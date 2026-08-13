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

func testServer(t *testing.T) *Server {
	t.Helper()
	cfg, err := config.Load(func(string) string { return "" })
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
