package httpapi

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/config"
	"github.com/layup-app/layup/services/control/internal/directory"
)

// authServer follows testServer (server_test.go:14) but lets a test choose the
// deployment environment and the directory, which is what the identity rules
// turn on.
func authServer(t *testing.T, environment string, dir directory.Directory) *Server {
	t.Helper()
	env := map[string]string{config.EnvPrefix + "ENV": environment}
	cfg, err := config.Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	base := time.Unix(1700000000, 0)
	calls := 0
	return New(cfg, Options{Directory: dir, Now: func() time.Time {
		calls++
		return base.Add(time.Duration(calls-1) * 2 * time.Second)
	}})
}

// hostedDirectory is a fresh, empty identity store on disk.
func hostedDirectory(t *testing.T) *directory.Hosted {
	t.Helper()
	hosted, err := directory.NewHosted(filepath.Join(t.TempDir(), "identities.json"))
	if err != nil {
		t.Fatalf("hosted directory: %v", err)
	}
	return hosted
}

// versionedRequest builds an /api request that satisfies the version guard.
func versionedRequest(t *testing.T, method, path string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set(protocol.HeaderVersion, strconv.Itoa(protocol.Version))
	return req
}

func TestBearerTokenAuthenticates(t *testing.T) {
	hosted := hostedDirectory(t)
	user, token, err := hosted.Register("Nick")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s := authServer(t, "selfhosted", hosted)

	req := versionedRequest(t, http.MethodGet, "/api/me")
	req.Header.Set(HeaderAuthorization, "Bearer "+token)
	// Deliberately not loopback: a token stands on its own.
	req.RemoteAddr = "203.0.113.9:5555"
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	me := payloadOf[MeDTO](t, rec)
	if me.User.ID != string(user.ID) {
		t.Fatalf("token identified %q, expected %q", me.User.ID, user.ID)
	}
	if me.User.DisplayName != "Nick" {
		t.Fatalf("unexpected user: %+v", me.User)
	}
}

func TestForgedBearerTokenIsRejected(t *testing.T) {
	s := authServer(t, "selfhosted", hostedDirectory(t))

	const forged = "nonsense-but-distinctive-abc123"
	req := versionedRequest(t, http.MethodGet, "/api/me")
	req.Header.Set(HeaderAuthorization, "Bearer "+forged)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unauthenticated") {
		t.Fatalf("expected an unauthenticated code, got %s", rec.Body.String())
	}
	// A rejection must never quote the credential back: error strings are
	// log lines waiting to happen.
	if strings.Contains(rec.Body.String(), forged) {
		t.Fatalf("the response echoed the token: %s", rec.Body.String())
	}
}

func TestDevUserHeaderIsRefusedFromANonLoopbackCaller(t *testing.T) {
	s := authServer(t, "selfhosted", directory.NewDev())

	req := versionedRequest(t, http.MethodGet, "/api/me")
	req.Header.Set(HeaderDevUser, "nick")
	req.RemoteAddr = "203.0.113.9:5555"
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a declared identity from the internet must be refused, got %d (%s)",
			rec.Code, rec.Body.String())
	}
}

func TestDevUserHeaderIsRefusedFromLoopbackBehindAReverseProxy(t *testing.T) {
	s := authServer(t, "selfhosted", directory.NewDev())

	// This is what an internet request looks like once Caddy has forwarded
	// it: the peer address is 127.0.0.1 even though the caller is not.
	for _, header := range []string{"X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host", "X-Real-IP", "Forwarded"} {
		req := versionedRequest(t, http.MethodGet, "/api/me")
		req.Header.Set(HeaderDevUser, "nick")
		req.Header.Set(header, "203.0.113.9")
		req.RemoteAddr = "127.0.0.1:5555"
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s present: proxied request must not count as local, got %d (%s)",
				header, rec.Code, rec.Body.String())
		}
	}
}

func TestDevUserHeaderStillWorksOnLoopback(t *testing.T) {
	s := authServer(t, "selfhosted", directory.NewDev())

	req := versionedRequest(t, http.MethodGet, "/api/me")
	req.Header.Set(HeaderDevUser, "nick")
	req.RemoteAddr = "127.0.0.1:5555"
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from a genuinely local caller, got %d (%s)",
			rec.Code, rec.Body.String())
	}
	if me := payloadOf[MeDTO](t, rec); me.User.DisplayName != "Nick" {
		t.Fatalf("unexpected user: %+v", me.User)
	}
}

func TestRealtimeAcceptsATokenQueryParameter(t *testing.T) {
	hosted := hostedDirectory(t)
	user, token, err := hosted.Register("Nick")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	api := authServer(t, "selfhosted", hosted)
	api.heartbeatInterval = 40 * time.Millisecond
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)

	conn := dial(t, srv, protocol.QueryProtocolVersion+"=1&"+protocol.QueryToken+"="+token)
	env := readEnvelope(t, conn)
	if env.Type != protocol.TypeHelloOK {
		t.Fatalf("expected hello.ok first, got %q", env.Type)
	}
	var hello protocol.HelloOKPayload
	if err := protocol.DecodePayload(env, &hello); err != nil {
		t.Fatalf("hello payload: %v", err)
	}
	if hello.UserID != string(user.ID) {
		t.Fatalf("token identified %q, expected %q", hello.UserID, user.ID)
	}
}

func TestRealtimeRefusesADeclaredIdentityFromTheInternet(t *testing.T) {
	api := authServer(t, "selfhosted", directory.NewDev())
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)

	// httptest dials over loopback, so forge the proxy marker instead.
	req, err := http.NewRequest(http.MethodGet,
		srv.URL+"/api/realtime?"+protocol.QueryProtocolVersion+"=1&"+protocol.QueryDevUser+"=nick", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}
