package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/pion/rtcp"
)

type IpcConnection struct {
	conn net.Conn
	mu   sync.Mutex // prevents concurrent write corruption on the stream
}

// every message carries a ClientID so the intermediary process can route
// messages to/from the correct client over the ipc.
type IpcMessage struct {
	ID      string        `json:"id"`
	Type    string        `json:"type"`
	Payload SignalMessage `json:"payload"`
	Error   string        `json:"error,omitempty"`
}

type SignalMessage struct {
	Type        string `json:"type"`
	ClientID    string `json:"clientId"`
	SDP         string `json:"sdp,omitempty"`
	TrackType   string `json:"trackType,omitempty"` // "audio" | "video"
	PublisherID string `json:"publisherId,omitempty"`
	SSRC        uint32 `json:"ssrc,omitempty"`
	BlockAudio  bool   `json:"blockAudio,omitempty"`
	BlockVideo  bool   `json:"blockVideo,omitempty"`
	Deaf        bool   `json:"deaf,omitempty"`
	Remote      string `json:"remote,omitempty"`
}

func getListener(path string) (net.Listener, error) {
	if runtime.GOOS == "windows" {
		// todo: figure out why "github.com/Microsoft/go-winio" is broken
		//path := `\\.\pipe\` + pipeName
		//log.Printf("Starting Windows Named Pipe on %s", path)
		//return winio.ListenPipe(path, nil)
		return nil, fmt.Errorf("Windows Named Pipe not implemented yet")
	}

	log.Printf("Starting Unix Socket on %s", path)
	os.RemoveAll(path) // clean up stale unix socket file
	return net.Listen("unix", path)
}

// Fixed shards bound concurrent signaling work and preserve each client's order.
// Heartbeats bypass pending negotiation work. A saturated shard applies bounded
// backpressure until its current operation finishes or reaches its deadline.
const signalingWorkers = 16

func signalingShard(clientID string) uint32 {
	var hash uint32 = 2166136261
	for i := 0; i < len(clientID); i++ {
		hash = (hash ^ uint32(clientID[i])) * 16777619
	}
	return hash % signalingWorkers
}

func (ipcConn *IpcConnection) handleConnection() {
	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	queues := make([]chan IpcMessage, signalingWorkers)
	for i := range queues {
		queues[i] = make(chan IpcMessage, 1)
		workers.Add(1)
		go func(queue <-chan IpcMessage) {
			defer workers.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case msg := <-queue:
					if ctx.Err() != nil {
						return
					}
					ipcConn.processMessage(ctx, msg)
				}
			}
		}(queues[i])
	}
	defer func() {
		cancel()
		// Unblock replies before waiting for negotiation workers to stop.
		ipcConn.conn.Close()
		workers.Wait()
	}()

	headerBuf := make([]byte, 4)

	for {
		// 4-byte length header (Length-prefixed framing)
		if _, err := io.ReadFull(ipcConn.conn, headerBuf); err != nil {
			if err == io.EOF {
				log.Println("Client disconnected")
			} else {
				log.Printf("Socket read error: %v", err)
			}
			return
		}

		msgLen := binary.BigEndian.Uint32(headerBuf)

		// prevent possible DOS when node sends massive length header
		if msgLen > 10*1024*1024 { // 10MB limit
			log.Println("Message too large, closing connection")
			return
		}

		// read the exact payload based on length
		payloadBuf := make([]byte, msgLen)
		if _, err := io.ReadFull(ipcConn.conn, payloadBuf); err != nil {
			log.Printf("Failed to read full payload: %v", err)
			return
		}

		// parse and handle message
		var msg IpcMessage
		if err := json.Unmarshal(payloadBuf, &msg); err != nil {
			log.Printf("Invalid JSON received: %v", err)
			continue
		}

		if msg.Type == "ping" {
			ipcConn.processMessage(ctx, msg)
			continue
		}
		select {
		case queues[signalingShard(msg.Payload.ClientID)] <- msg:
		case <-ctx.Done():
			return
		}
	}
}

func (ipcConn *IpcConnection) processMessage(ctx context.Context, ipcMsg IpcMessage) {
	// handle ping pong heartbeats
	if ipcMsg.Type == "ping" {
		ipcConn.sendReply(ipcMsg.ID, SignalMessage{
			Type: "pong",
		}, "")
		return
	}
	msg := ipcMsg.Payload
	requestID := ipcMsg.ID
	clientID := msg.ClientID

	if clientID == "" {
		log.Printf("Message missing clientId, ignoring")
		return
	}

	log.Printf("id=%s client=%s type=%s", requestID, clientID, msg.Type)

	var handleErr error

	// "join" and "leave" don't require an existing peer
	switch msg.Type {
	case "join":
		handleErr = handleJoin(clientID)
		if handleErr == nil {
			ipcConn.sendReply(requestID, SignalMessage{
				Type:     "joined",
				ClientID: clientID,
			}, "")
		}
	case "leave":
		handleErr = handleLeave(clientID)
		if handleErr == nil {
			ipcConn.sendReply(requestID, SignalMessage{
				Type:     "left",
				ClientID: clientID,
			}, "")
		}
	default:
		// all other messages require an existing peer
		p := sfu.GetPeer(clientID)
		if p == nil {
			handleErr = fmt.Errorf("client %s not found (send 'join' first)", clientID)
		} else {
			switch msg.Type {
			case "offer":
				handleErr = handleOffer(ctx, p, msg, requestID)
			case "publish":
				handleErr = handlePublish(p, msg)
			case "stop-publish":
				handleErr = handleStopPublish(p, msg)
			case "subscribe":
				handleErr = handleSubscribe(p, msg, requestID)
			case "unsubscribe":
				handleErr = handleUnsubscribe(p, msg)
			case "moderate":
				p.moderate(msg.BlockAudio, msg.BlockVideo, msg.Deaf)
			case "keyframe":
				p.mu.Lock()
				pt := p.videoPublished
				p.mu.Unlock()
				if pt != nil {
					if err := p.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(pt.ssrc)}}); err != nil {
						log.Printf("WriteRTCP: %v", err)
					}
				}
			default:
				handleErr = fmt.Errorf("unknown message type: %s", msg.Type)
			}
		}
	}

	if handleErr != nil {
		log.Printf("client=%s error handling %s: %v", clientID, msg.Type, handleErr)
		ipcConn.sendReply(requestID, msg, handleErr.Error())
	}
}

func (ipcConn *IpcConnection) sendReply(requestID string, payload SignalMessage, errMsg string) error {
	// lock the connection to prevent concurrent writes from interleaving bytes
	ipcConn.mu.Lock()
	defer ipcConn.mu.Unlock()

	if ipcConn.conn == nil {
		return fmt.Errorf("no IPC connection")
	}

	ipcMsg := IpcMessage{
		ID:      requestID,
		Type:    "response",
		Payload: payload,
		Error:   errMsg,
	}
	data, _ := json.Marshal(ipcMsg)

	length := uint32(len(data))

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, length)

	if err := ipcConn.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	defer ipcConn.conn.SetWriteDeadline(time.Time{})
	for _, part := range [][]byte{header, data} {
		for len(part) > 0 {
			n, err := ipcConn.conn.Write(part)
			if err != nil {
				// A partial frame makes the stream unusable; let the reader cancel work.
				ipcConn.conn.Close()
				return err
			}
			if n == 0 {
				ipcConn.conn.Close()
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}
