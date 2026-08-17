package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/config"
)

// testServer is the plain route-level server: the development directory, and
// identities declared with X-Layup-Dev-User rather than proved with a token.
//
// It asks for LAYUP_ENV=dev explicitly, because that is what these tests are:
// a development directory whose people say who they are. The default is now
// "selfhosted" (config.defaults), under which a declared identity is honoured
// only for a genuinely local caller - and httptest.NewRequest stamps requests
// with 192.0.2.1, the documentation range, which is deliberately not local.
// Tests of *that* rule use authServer (auth_test.go:20) and name the
// environment they mean.
func testServer(t *testing.T) *Server {
	t.Helper()
	env := map[string]string{config.EnvPrefix + "ENV": "dev"}
	cfg, err := config.Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	base := time.Unix(1700000000, 0)
	calls := 0
	return New(cfg, Options{Now: func() time.Time {
		calls++
		return base.Add(time.Duration(calls-1) * 2 * time.Second)
	}})
}

func TestHealthzReportsReadyService(t *testing.T) {
	s := testServer(t)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("unexpected content type %q", got)
	}

	var body HealthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("health response is not JSON: %v", err)
	}
	if body.Status != "ok" {
		t.Errorf("unexpected status %q", body.Status)
	}
	if body.ProtocolVersion != protocol.Version {
		t.Errorf("expected protocol v%d, got v%d", protocol.Version, body.ProtocolVersion)
	}
	if body.Build.Version == "" || body.Build.GoVersion == "" || body.Build.Platform == "" {
		t.Errorf("build metadata incomplete: %+v", body.Build)
	}
	if body.UptimeSeconds < 0 {
		t.Errorf("uptime must not be negative: %v", body.UptimeSeconds)
	}
}

func TestUnknownRouteIs404(t *testing.T) {
	s := testServer(t)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestHealthzRejectsNonGet(t *testing.T) {
	s := testServer(t)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/healthz", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}
