package main

import (
	"fmt"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/stun/v3"
	"github.com/pion/turn/v4"
)

func TestParseTurnUsername(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	credential, err := parseTurnUsername("1800000600:203.0.113.10:abc", now)
	if err != nil {
		t.Fatal(err)
	}
	if !credential.peer.Equal(net.ParseIP("203.0.113.10")) {
		t.Fatalf("peer is %s", credential.peer)
	}
	for _, username := range []string{"1799999999:203.0.113.10:abc", "1800000600:abc", "soon:203.0.113.10:abc", "1800000600:2001:db8::1:abc", "1800000600:example.com:abc"} {
		if _, err := parseTurnUsername(username, now); err == nil {
			t.Fatalf("accepted %q", username)
		}
	}
}

func TestTurnGuardBindsTheClientToItsPeer(t *testing.T) {
	guard := newTurnGuard("secret")
	client := &net.UDPAddr{IP: net.ParseIP("198.51.100.7"), Port: 40000}
	username := fmt.Sprintf("%d:203.0.113.10:abc", time.Now().Add(time.Hour).Unix())
	key, ok := guard.authenticate(username, "meowcord", client)
	if !ok || string(key) != string(turn.GenerateAuthKey(username, "meowcord", turnPassword("secret", username))) {
		t.Fatal("a valid username was refused")
	}
	if guard.permit(client, net.ParseIP("203.0.113.10")) {
		t.Fatal("a client was bound before its allocation succeeded")
	}
	guard.bind(client, username)
	if !guard.permit(client, net.ParseIP("203.0.113.10")) {
		t.Fatal("the named peer was refused")
	}
	if guard.permit(client, net.ParseIP("127.0.0.1")) {
		t.Fatal("another peer was allowed")
	}
	if guard.permit(&net.UDPAddr{IP: net.ParseIP("198.51.100.8"), Port: 40000}, net.ParseIP("203.0.113.10")) {
		t.Fatal("a client that never authenticated was allowed")
	}
	if _, ok := guard.authenticate(username, "meowcord", client); !ok {
		t.Fatal("the bound credential was refused on its own allocation")
	}
	other := fmt.Sprintf("%d:192.0.2.1:xyz", time.Now().Add(time.Hour).Unix())
	if _, ok := guard.authenticate(other, "meowcord", client); ok {
		t.Fatal("another credential was accepted for a bound allocation")
	}
	if !guard.permit(client, net.ParseIP("203.0.113.10")) || guard.permit(client, net.ParseIP("192.0.2.1")) {
		t.Fatal("another credential changed the binding")
	}
	guard.forget(client)
	if guard.permit(client, net.ParseIP("203.0.113.10")) {
		t.Fatal("a forgotten client was allowed")
	}
}

func TestTurnGuardRefusesPrivatePeers(t *testing.T) {
	client := &net.UDPAddr{IP: net.ParseIP("198.51.100.7"), Port: 40000}
	for _, peer := range []string{"127.0.0.1", "10.0.0.5", "192.168.1.1", "172.20.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "239.1.1.1"} {
		guard := newTurnGuard("secret")
		username := fmt.Sprintf("%d:%s:abc", time.Now().Add(time.Hour).Unix(), peer)
		guard.bind(client, username)
		if guard.permit(client, net.ParseIP(peer)) {
			t.Fatalf("a credential reached the private peer %s", peer)
		}
		guard.allowPrivate = true
		if !guard.permit(client, net.ParseIP(peer)) {
			t.Fatalf("TURN_ALLOW_PRIVATE_PEERS did not allow %s", peer)
		}
	}
	guard := newTurnGuard("secret")
	username := fmt.Sprintf("%d:8.8.8.8:abc", time.Now().Add(time.Hour).Unix())
	guard.bind(client, username)
	if !guard.permit(client, net.ParseIP("8.8.8.8")) {
		t.Fatal("a public peer was refused")
	}
}

func stunRoundTrip(t *testing.T, conn net.PacketConn, server net.Addr, setters ...stun.Setter) *stun.Message {
	t.Helper()
	request := stun.MustBuild(append([]stun.Setter{stun.TransactionID}, setters...)...)
	if _, err := conn.WriteTo(request.Raw, server); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1500)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	defer conn.SetReadDeadline(time.Time{})
	n, _, err := conn.ReadFrom(buffer)
	if err != nil {
		t.Fatal(err)
	}
	response := &stun.Message{Raw: append([]byte{}, buffer[:n]...)}
	if err := response.Decode(); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestTurnBindsOnlyAfterAnAuthenticatedAllocation(t *testing.T) {
	port := freeUDPPort(t)
	relayPort := freeUDPPort(t)
	if relayPort > 65000 {
		relayPort = 40000
	}
	cfg := turnConfig{port: port, listenIP: "127.0.0.1", publicIP: "127.0.0.1", relayMin: relayPort, relayMax: relayPort + 20, realm: "meowcord", secret: "secret"}
	guard := newTurnGuard(cfg.secret)
	guard.allowPrivate = true
	server, err := startTurnWithGuard(cfg, logging.NewDefaultLoggerFactory(), guard)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	serverAddr := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: port}

	peer, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()

	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	allocate := stun.NewType(stun.MethodAllocate, stun.ClassRequest)
	transport := stun.RawAttribute{Type: stun.AttrRequestedTransport, Value: []byte{17, 0, 0, 0}}
	challenge := stunRoundTrip(t, conn, serverAddr, allocate, transport)
	var nonce stun.Nonce
	if err := nonce.GetFrom(challenge); err != nil {
		t.Fatalf("no nonce in the challenge: %v", err)
	}
	forged := fmt.Sprintf("%d:203.0.113.10:forged", time.Now().Add(time.Minute).Unix())
	refused := stunRoundTrip(t, conn, serverAddr, allocate, transport,
		stun.NewUsername(forged), stun.NewRealm("meowcord"), nonce,
		stun.NewLongTermIntegrity(forged, "meowcord", "not the password"))
	if refused.Type.Class != stun.ClassErrorResponse {
		t.Fatalf("an allocation with a wrong password got %s", refused.Type)
	}
	if guard.permit(conn.LocalAddr(), net.ParseIP("203.0.113.10")) {
		t.Fatal("a request with a wrong password bound its credential to the source address")
	}

	username := fmt.Sprintf("%d:127.0.0.1:victim", time.Now().Add(time.Minute).Unix())
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: serverAddr.String(),
		TURNServerAddr: serverAddr.String(),
		Conn:           conn,
		Username:       username,
		Password:       turnPassword("secret", username),
		Realm:          "meowcord",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Listen(); err != nil {
		t.Fatal(err)
	}
	relayed, err := client.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	defer relayed.Close()
	if !guard.permit(conn.LocalAddr(), net.ParseIP("127.0.0.1")) {
		t.Fatal("the authenticated allocation was not bound to its peer")
	}

	stolen := fmt.Sprintf("%d:203.0.113.10:stolen", time.Now().Add(time.Minute).Unix())
	if _, ok := guard.authenticate(stolen, "meowcord", conn.LocalAddr()); ok {
		t.Fatal("another valid credential was accepted from the address of a bound allocation")
	}

	if _, err := relayed.WriteTo([]byte("ping"), peer.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 64)
	peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, _, err := peer.ReadFrom(buffer)
	if err != nil || string(buffer[:n]) != "ping" {
		t.Fatalf("the relay did not reach its peer after a forged request: %q, %v", buffer[:n], err)
	}
}

func freeUDPPort(t *testing.T) int {
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

func TestTurnRelaysOnlyToThePeerInTheCredential(t *testing.T) {
	port := freeUDPPort(t)
	relayPort := freeUDPPort(t)
	if relayPort > 65000 {
		relayPort = 40000
	}
	cfg := turnConfig{port: port, listenIP: "127.0.0.1", publicIP: "127.0.0.1", relayMin: relayPort, relayMax: relayPort + 20, realm: "meowcord", secret: "secret", allowPrivatePeers: true}
	server, err := startTurn(cfg, logging.NewDefaultLoggerFactory())
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	peer, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()

	allocate := func(peerIP string) (net.PacketConn, func()) {
		username := fmt.Sprintf("%d:%s:probe", time.Now().Add(time.Minute).Unix(), peerIP)
		conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		client, err := turn.NewClient(&turn.ClientConfig{
			STUNServerAddr: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
			TURNServerAddr: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
			Conn:           conn,
			Username:       username,
			Password:       turnPassword("secret", username),
			Realm:          "meowcord",
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := client.Listen(); err != nil {
			t.Fatal(err)
		}
		relayed, err := client.Allocate()
		if err != nil {
			t.Fatal(err)
		}
		return relayed, func() {
			relayed.Close()
			client.Close()
			conn.Close()
		}
	}

	relayed, release := allocate("127.0.0.1")
	if got := relayed.LocalAddr().(*net.UDPAddr).Port; got < relayPort || got > relayPort+20 {
		t.Fatalf("relay port %d is outside %d-%d", got, relayPort, relayPort+20)
	}
	if _, err := relayed.WriteTo([]byte("ping"), peer.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 64)
	peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, from, err := peer.ReadFrom(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if string(buffer[:n]) != "ping" || from.(*net.UDPAddr).Port != relayed.LocalAddr().(*net.UDPAddr).Port {
		t.Fatalf("peer got %q from %s", buffer[:n], from)
	}
	if _, err := peer.WriteTo([]byte("pong"), from); err != nil {
		t.Fatal(err)
	}
	relayed.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, _, err = relayed.ReadFrom(buffer)
	if err != nil || string(buffer[:n]) != "pong" {
		t.Fatalf("relay read %q, %v", buffer[:n], err)
	}
	release()

	other, releaseOther := allocate("203.0.113.10")
	defer releaseOther()
	if _, err := other.WriteTo([]byte("ping"), peer.LocalAddr()); err == nil {
		peer.SetReadDeadline(time.Now().Add(time.Second))
		if n, _, err := peer.ReadFrom(buffer); err == nil {
			t.Fatalf("a relay for another peer reached this one: %q", buffer[:n])
		}
	}
}

func TestTurnConfigFromEnv(t *testing.T) {
	t.Setenv("TURN_SECRET", "")
	if _, enabled, err := turnConfigFromEnv("127.0.0.1"); err != nil || enabled {
		t.Fatalf("TURN without a secret: enabled %v, %v", enabled, err)
	}
	t.Setenv("TURN_SECRET", "secret")
	t.Setenv("TURN_PORT", "0")
	if _, enabled, _ := turnConfigFromEnv("127.0.0.1"); enabled {
		t.Fatal("TURN_PORT=0 left TURN on")
	}
	t.Setenv("TURN_PORT", "3479")
	t.Setenv("TURN_RELAY_PORT_MIN", "50010")
	t.Setenv("TURN_RELAY_PORT_MAX", "50000")
	if _, _, err := turnConfigFromEnv("127.0.0.1"); err == nil {
		t.Fatal("an inverted relay range was accepted")
	}
	t.Setenv("TURN_RELAY_PORT_MAX", "50020")
	cfg, enabled, err := turnConfigFromEnv("127.0.0.1")
	if err != nil || !enabled || cfg.port != 3479 || cfg.publicIP != "127.0.0.1" || cfg.relayMin != 50010 || cfg.relayMax != 50020 {
		t.Fatalf("unexpected config %+v, %v, %v", cfg, enabled, err)
	}
}
