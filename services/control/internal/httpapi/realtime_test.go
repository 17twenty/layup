package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/config"
	"github.com/layup-app/layup/services/control/internal/domain"
	"github.com/layup-app/layup/services/control/internal/realtime"
)

func realtimeServer(t *testing.T) (*httptest.Server, *Server) {
	t.Helper()
	// LAYUP_ENV=dev: these handshakes carry devUser=, not a token. The token
	// handshake is covered in auth_test.go under "selfhosted".
	env := map[string]string{config.EnvPrefix + "ENV": "dev"}
	cfg, err := config.Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	api := New(cfg, Options{HeartbeatInterval: 40 * time.Millisecond})
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	return srv, api
}

func dial(t *testing.T, srv *httptest.Server, query string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/realtime?" + query
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "test over") })
	return conn
}

func readEnvelope(t *testing.T, conn *websocket.Conn) protocol.Envelope {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	env, err := protocol.Decode(data)
	if err != nil {
		t.Fatalf("decode %q: %v", string(data), err)
	}
	return env
}

func writeRaw(t *testing.T, conn *websocket.Conn, raw string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(raw)); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestRealtimeHandshakeIdentifiesTheConnection(t *testing.T) {
	srv, api := realtimeServer(t)
	conn := dial(t, srv, "v=1&devUser=karl")

	env := readEnvelope(t, conn)
	if env.Type != protocol.TypeHelloOK {
		t.Fatalf("expected hello.ok first, got %q", env.Type)
	}
	var hello protocol.HelloOKPayload
	if err := protocol.DecodePayload(env, &hello); err != nil {
		t.Fatalf("hello payload: %v", err)
	}
	if hello.ProtocolVersion != protocol.Version {
		t.Fatalf("unexpected protocol version %d", hello.ProtocolVersion)
	}
	if !strings.HasPrefix(hello.UserID, "usr_") || hello.OrganisationID == "" {
		t.Fatalf("hello must state who you are: %+v", hello)
	}
	if hello.HeartbeatInterval <= 0 {
		t.Fatalf("hello must advertise the heartbeat interval: %+v", hello)
	}
	if api.Hub().Connections() != 1 {
		t.Fatalf("hub should track the connection, has %d", api.Hub().Connections())
	}
}

func TestRealtimeHeartbeatArrivesAndIsAcknowledged(t *testing.T) {
	srv, _ := realtimeServer(t)
	conn := dial(t, srv, "v=1&devUser=nick")
	_ = readEnvelope(t, conn) // hello.ok

	beat := awaitHeartbeat(t, conn)
	var payload protocol.HeartbeatPayload
	if err := protocol.DecodePayload(beat, &payload); err != nil {
		t.Fatalf("heartbeat payload: %v", err)
	}
	if payload.Seq < 1 {
		t.Fatalf("heartbeat should carry a sequence, got %+v", payload)
	}

	ack, _ := protocol.NewEnvelope(protocol.TypeHeartbeatAck, protocol.HeartbeatPayload{Seq: payload.Seq})
	data, _ := json.Marshal(ack)
	writeRaw(t, conn, string(data))

	// A second heartbeat proves the connection survived the ack.
	_ = awaitHeartbeat(t, conn)
}

func TestRealtimeRejectsMalformedMessagesWithoutClosing(t *testing.T) {
	srv, _ := realtimeServer(t)
	conn := dial(t, srv, "v=1&devUser=nick")
	_ = readEnvelope(t, conn) // hello.ok

	for _, bad := range []string{`not json`, `{"type":"heartbeat.ack"}`, `{"v":99,"type":"heartbeat.ack"}`} {
		writeRaw(t, conn, bad)

		env := readIgnoringBackground(t, conn)
		if env.Type != protocol.TypeError {
			t.Fatalf("expected an error envelope for %q, got %q", bad, env.Type)
		}
		var payload protocol.ErrorPayload
		if err := protocol.DecodePayload(env, &payload); err != nil {
			t.Fatalf("error payload: %v", err)
		}
		if payload.Code == "" {
			t.Fatalf("error must carry a code: %+v", payload)
		}
	}

	// The connection is still usable afterwards: heartbeats keep arriving.
	deadline := time.Now().Add(2 * time.Second)
	sawHeartbeat := false
	for time.Now().Before(deadline) && !sawHeartbeat {
		if readEnvelope(t, conn).Type == protocol.TypeHeartbeat {
			sawHeartbeat = true
		}
	}
	if !sawHeartbeat {
		t.Fatal("connection should survive malformed input")
	}
}

func TestRealtimeRequiresIdentityAndSupportedVersion(t *testing.T) {
	srv, _ := realtimeServer(t)
	base := srv.URL + "/api/realtime"

	for _, tc := range []struct {
		name   string
		url    string
		status int
	}{
		{"no identity", base + "?v=1", http.StatusUnauthorized},
		{"unknown identity", base + "?v=1&devUser=mallory", http.StatusUnauthorized},
		{"no version", base + "?devUser=nick", http.StatusBadRequest},
		{"unsupported version", base + "?v=99&devUser=nick", http.StatusUpgradeRequired},
	} {
		resp, err := http.Get(tc.url)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if resp.StatusCode != tc.status {
			t.Errorf("%s: expected %d, got %d", tc.name, tc.status, resp.StatusCode)
		}
		_ = resp.Body.Close()
	}
}

func TestHubFansOutWithinTheOrganisationOnly(t *testing.T) {
	srv, api := realtimeServer(t)
	first := dial(t, srv, "v=1&devUser=nick")
	second := dial(t, srv, "v=1&devUser=karl")
	_ = readEnvelope(t, first)
	_ = readEnvelope(t, second)

	waitFor(t, func() bool { return api.Hub().Connections() == 2 })

	notice, _ := protocol.NewEnvelope("layup.test-broadcast", map[string]string{"userId": "usr_devnickx"})
	if delivered := api.Hub().BroadcastToOrganisation("org_devlayup", notice); delivered != 2 {
		t.Fatalf("expected delivery to both connections, got %d", delivered)
	}
	if delivered := api.Hub().BroadcastToOrganisation("org_elsewhere", notice); delivered != 0 {
		t.Fatalf("another organisation must receive nothing, got %d", delivered)
	}

	for _, conn := range []*websocket.Conn{first, second} {
		env := readIgnoringBackground(t, conn)
		if env.Type != "layup.test-broadcast" {
			t.Fatalf("expected the broadcast, got %q", env.Type)
		}
	}
}

func TestHubSendToUserTargetsOneUser(t *testing.T) {
	_, api := realtimeServer(t)
	hub := api.Hub()

	nick := &fakeSink{id: "c1", user: "usr_devnickx", org: "org_devlayup"}
	karl := &fakeSink{id: "c2", user: "usr_devkarlx", org: "org_devlayup"}
	hub.Add(nick)
	hub.Add(karl)

	env, _ := protocol.NewEnvelope("request.incoming", nil)
	if delivered := hub.SendToUser("usr_devkarlx", env); delivered != 1 {
		t.Fatalf("expected one delivery, got %d", delivered)
	}
	if len(nick.sent) != 0 || len(karl.sent) != 1 {
		t.Fatalf("wrong recipient: nick=%d karl=%d", len(nick.sent), len(karl.sent))
	}
}

func TestHubDropsAConnectionThatCannotKeepUp(t *testing.T) {
	_, api := realtimeServer(t)
	hub := api.Hub()
	slow := &fakeSink{id: "c3", user: "usr_devnickx", org: "org_devlayup", full: true}
	hub.Add(slow)

	env, _ := protocol.NewEnvelope("presence.update", nil)
	if delivered := hub.BroadcastToOrganisation("org_devlayup", env); delivered != 0 {
		t.Fatalf("a full queue delivers nothing, got %d", delivered)
	}
	if !slow.closed {
		t.Fatal("a slow connection must be closed, not buffered indefinitely")
	}
}

// awaitHeartbeat reads until the next heartbeat arrives.
func awaitHeartbeat(t *testing.T, conn *websocket.Conn) protocol.Envelope {
	t.Helper()
	for i := 0; i < 40; i++ {
		if env := readEnvelope(t, conn); env.Type == protocol.TypeHeartbeat {
			return env
		}
	}
	t.Fatal("no heartbeat arrived")
	return protocol.Envelope{}
}

// readIgnoringBackground skips heartbeats and presence traffic, which flow
// continuously, and returns the next interesting envelope.
func readIgnoringBackground(t *testing.T, conn *websocket.Conn) protocol.Envelope {
	t.Helper()
	for i := 0; i < 40; i++ {
		env := readEnvelope(t, conn)
		switch env.Type {
		case protocol.TypeHeartbeat, "presence.snapshot", "presence.update":
			continue
		default:
			return env
		}
	}
	t.Fatal("no non-background envelope arrived")
	return protocol.Envelope{}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met within 2s")
}

type fakeSink struct {
	id     string
	user   domain.UserID
	org    domain.OrganisationID
	full   bool
	closed bool
	sent   []protocol.Envelope
}

func (f *fakeSink) ID() string                            { return f.id }
func (f *fakeSink) UserID() domain.UserID                 { return f.user }
func (f *fakeSink) OrganisationID() domain.OrganisationID { return f.org }
func (f *fakeSink) Send(env protocol.Envelope) bool {
	if f.full {
		return false
	}
	f.sent = append(f.sent, env)
	return true
}
func (f *fakeSink) Close(string) { f.closed = true }

var _ realtime.Sink = (*fakeSink)(nil)
