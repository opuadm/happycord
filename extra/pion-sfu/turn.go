package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

type turnConfig struct {
	port     int
	listenIP string
	publicIP string
	relayMin int
	relayMax int
	realm    string
	secret   string

	allowPrivatePeers bool
}

func envInt(name string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s is not a number: %q", name, value)
	}
	return parsed, nil
}

func envString(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func turnConfigFromEnv(defaultPublicIP string) (turnConfig, bool, error) {
	cfg := turnConfig{
		listenIP: envString("TURN_LISTEN_IP", "0.0.0.0"),
		realm:    envString("TURN_REALM", "meowcord"),
		secret:   os.Getenv("TURN_SECRET"),

		allowPrivatePeers: envString("TURN_ALLOW_PRIVATE_PEERS", "") == "1" || envString("TURN_ALLOW_PRIVATE_PEERS", "") == "true",
	}
	var err error
	if cfg.port, err = envInt("TURN_PORT", 3478); err != nil {
		return cfg, false, err
	}
	if cfg.relayMin, err = envInt("TURN_RELAY_PORT_MIN", 49160); err != nil {
		return cfg, false, err
	}
	if cfg.relayMax, err = envInt("TURN_RELAY_PORT_MAX", 49200); err != nil {
		return cfg, false, err
	}
	if cfg.port == 0 || cfg.secret == "" {
		return cfg, false, nil
	}
	if cfg.port < 0 || cfg.port > 65535 || cfg.relayMin < 1 || cfg.relayMax > 65535 || cfg.relayMin > cfg.relayMax {
		return cfg, false, fmt.Errorf("TURN ports out of range: port %d, relay %d-%d", cfg.port, cfg.relayMin, cfg.relayMax)
	}
	if net.ParseIP(cfg.listenIP).To4() == nil {
		return cfg, false, fmt.Errorf("TURN_LISTEN_IP must be an IPv4 address: %q", cfg.listenIP)
	}
	cfg.publicIP, err = resolvePublicIP(envString("TURN_PUBLIC_IP", defaultPublicIP))
	if err != nil {
		return cfg, false, fmt.Errorf("resolve TURN_PUBLIC_IP: %w", err)
	}
	return cfg, true, nil
}

func turnPassword(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

type turnCredential struct {
	username string
	peer     net.IP
	expires  time.Time
}

func parseTurnUsername(username string, now time.Time) (turnCredential, error) {
	parts := strings.SplitN(username, ":", 3)
	if len(parts) != 3 {
		return turnCredential{}, fmt.Errorf("username %q is not expiry:peer:tag", username)
	}
	expiry, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return turnCredential{}, fmt.Errorf("username %q has no expiry", username)
	}
	expires := time.Unix(expiry, 0)
	if !expires.After(now) {
		return turnCredential{}, fmt.Errorf("username %q expired", username)
	}
	peer := net.ParseIP(parts[1]).To4()
	if peer == nil {
		return turnCredential{}, fmt.Errorf("username %q names no IPv4 peer", username)
	}
	return turnCredential{username: username, peer: peer, expires: expires}, nil
}

type turnGuard struct {
	secret       string
	allowPrivate bool
	mu           sync.Mutex
	clients      map[string]turnCredential
	now          func() time.Time
}

var reservedPeerNetworks = func() []*net.IPNet {
	var networks []*net.IPNet
	for _, cidr := range []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3"} {
		_, network, _ := net.ParseCIDR(cidr)
		networks = append(networks, network)
	}
	return networks
}()

func reservedPeer(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return true
	}
	for _, network := range reservedPeerNetworks {
		if network.Contains(v4) {
			return true
		}
	}
	return false
}

func newTurnGuard(secret string) *turnGuard {
	return &turnGuard{secret: secret, clients: make(map[string]turnCredential), now: time.Now}
}

func (g *turnGuard) authenticate(username, realm string, srcAddr net.Addr) ([]byte, bool) {
	if _, err := parseTurnUsername(username, g.now()); err != nil {
		log.Printf("TURN refused %s: %v", srcAddr, err)
		return nil, false
	}
	g.mu.Lock()
	bound, ok := g.clients[srcAddr.String()]
	g.mu.Unlock()
	if ok && bound.username != username {
		log.Printf("TURN refused %s: the allocation from that address belongs to another credential", srcAddr)
		return nil, false
	}
	return turn.GenerateAuthKey(username, realm, turnPassword(g.secret, username)), true
}

func (g *turnGuard) bind(clientAddr net.Addr, username string) {
	credential, err := parseTurnUsername(username, g.now())
	if err != nil {
		log.Printf("TURN did not bind %s: %v", clientAddr, err)
		return
	}
	g.mu.Lock()
	g.clients[clientAddr.String()] = credential
	g.mu.Unlock()
}

func (g *turnGuard) permit(clientAddr net.Addr, peerIP net.IP) bool {
	g.mu.Lock()
	credential, ok := g.clients[clientAddr.String()]
	g.mu.Unlock()
	allowed := ok && g.now().Before(credential.expires) && credential.peer.Equal(peerIP) && (g.allowPrivate || !reservedPeer(peerIP))
	if !allowed {
		log.Printf("TURN refused a permission from %s to %s", clientAddr, peerIP)
	}
	return allowed
}

func (g *turnGuard) forget(clientAddr net.Addr) {
	g.mu.Lock()
	delete(g.clients, clientAddr.String())
	g.mu.Unlock()
}

func startTurn(cfg turnConfig, loggerFactory logging.LoggerFactory) (*turn.Server, error) {
	guard := newTurnGuard(cfg.secret)
	guard.allowPrivate = cfg.allowPrivatePeers
	return startTurnWithGuard(cfg, loggerFactory, guard)
}

func startTurnWithGuard(cfg turnConfig, loggerFactory logging.LoggerFactory, guard *turnGuard) (*turn.Server, error) {
	address := net.JoinHostPort(cfg.listenIP, strconv.Itoa(cfg.port))
	udpListener, err := net.ListenPacket("udp4", address)
	if err != nil {
		return nil, fmt.Errorf("TURN UDP listen on %s: %w", address, err)
	}
	tcpListener, err := net.Listen("tcp4", address)
	if err != nil {
		udpListener.Close()
		return nil, fmt.Errorf("TURN TCP listen on %s: %w", address, err)
	}
	relay := func() turn.RelayAddressGenerator {
		return &turn.RelayAddressGeneratorPortRange{
			RelayAddress: net.ParseIP(cfg.publicIP),
			Address:      cfg.listenIP,
			MinPort:      uint16(cfg.relayMin),
			MaxPort:      uint16(cfg.relayMax),
		}
	}
	server, err := turn.NewServer(turn.ServerConfig{
		Realm:         cfg.realm,
		LoggerFactory: loggerFactory,
		AuthHandler:   guard.authenticate,
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            udpListener,
			RelayAddressGenerator: relay(),
			PermissionHandler:     guard.permit,
		}},
		ListenerConfigs: []turn.ListenerConfig{{
			Listener:              tcpListener,
			RelayAddressGenerator: relay(),
			PermissionHandler:     guard.permit,
		}},
		EventHandler: turn.EventHandler{
			OnAllocationCreated: func(srcAddr, dstAddr net.Addr, protocol, username, realm string, relayAddr net.Addr, requestedPort int) {
				guard.bind(srcAddr, username)
				log.Printf("TURN allocation for %s over %s relays from %s", srcAddr, protocol, relayAddr)
			},
			OnAllocationDeleted: func(srcAddr, dstAddr net.Addr, protocol, username, realm string) {
				guard.forget(srcAddr)
				log.Printf("TURN allocation for %s closed", srcAddr)
			},
			OnPermissionCreated: func(srcAddr, dstAddr net.Addr, protocol, username, realm string, relayAddr net.Addr, peer net.IP) {
				log.Printf("TURN relay %s may now reach %s", relayAddr, peer)
			},
		},
	})
	if err != nil {
		udpListener.Close()
		tcpListener.Close()
		return nil, err
	}
	log.Printf("TURN listening on %s udp and tcp, relaying from %s ports %d-%d", address, cfg.publicIP, cfg.relayMin, cfg.relayMax)
	return server, nil
}
