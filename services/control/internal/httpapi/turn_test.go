package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/layup-app/layup/services/control/internal/config"
)

func turnServer(t *testing.T, env map[string]string) *Server {
	t.Helper()
	cfg, err := config.Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	return New(cfg, Options{Now: func() time.Time { return time.Unix(1800000000, 0) }})
}

func TestTurnCredentialsAreShortLivedAndDerived(t *testing.T) {
	s := turnServer(t, map[string]string{
		"LAYUP_TURN_URLS":   "turn:turn.example:3478?transport=udp,turns:turn.example:5349",
		"LAYUP_TURN_SECRET": "a-shared-secret",
		"LAYUP_STUN_URLS":   "stun:stun.example:3478",
	})

	rec := call(t, s, http.MethodGet, "/api/turn", "karl", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	dto := payloadOf[TurnDTO](t, rec)

	if len(dto.IceServers) != 2 {
		t.Fatalf("expected STUN and TURN entries, got %+v", dto.IceServers)
	}
	stun, turn := dto.IceServers[0], dto.IceServers[1]
	if stun.Username != "" || stun.Credential != "" {
		t.Fatalf("STUN needs no credentials: %+v", stun)
	}
	if len(turn.URLs) != 2 {
		t.Fatalf("both TURN URLs should be offered: %+v", turn.URLs)
	}

	// coturn REST convention: username is "<expiry>:<user>", password is an
	// HMAC of it. The shared secret itself never leaves the server.
	parts := strings.SplitN(turn.Username, ":", 2)
	if len(parts) != 2 || parts[1] != "usr_devkarlx" {
		t.Fatalf("unexpected username %q", turn.Username)
	}
	expiry, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		t.Fatalf("username must start with an expiry: %v", err)
	}
	if time.Unix(expiry, 0).Sub(time.Unix(1800000000, 0)) != DefaultTurnCredentialTTL {
		t.Fatalf("unexpected credential lifetime: %v", time.Unix(expiry, 0))
	}
	if turn.Credential == "" || strings.Contains(rec.Body.String(), "a-shared-secret") {
		t.Fatal("the shared secret must never be sent to a client")
	}

	expectedUsername, expectedCredential := turnCredential("a-shared-secret", "usr_devkarlx", time.Unix(expiry, 0))
	if turn.Username != expectedUsername || turn.Credential != expectedCredential {
		t.Fatal("credential must be a deterministic HMAC of the username")
	}
	if dto.ForceRelay {
		t.Fatal("relay must not be forced unless configured")
	}
}

func TestTurnConfigurationIsValidated(t *testing.T) {
	// A TURN URL without a secret is a misconfiguration, not a silent default.
	if _, err := config.Load(func(key string) string {
		return map[string]string{"LAYUP_TURN_URLS": "turn:turn.example:3478"}[key]
	}); err == nil || !strings.Contains(err.Error(), "TURN_SECRET") {
		t.Fatalf("expected a TURN_SECRET complaint, got %v", err)
	}

	// Forcing relay with no TURN server configured cannot work.
	if _, err := config.Load(func(key string) string {
		return map[string]string{"LAYUP_FORCE_RELAY": "true"}[key]
	}); err == nil || !strings.Contains(err.Error(), "FORCE_RELAY") {
		t.Fatalf("expected a FORCE_RELAY complaint, got %v", err)
	}

	// A URL that is not turn:/turns: is rejected.
	if _, err := config.Load(func(key string) string {
		return map[string]string{
			"LAYUP_TURN_URLS":   "https://turn.example",
			"LAYUP_TURN_SECRET": "s",
		}[key]
	}); err == nil || !strings.Contains(err.Error(), "must start turn:") {
		t.Fatalf("expected a scheme complaint, got %v", err)
	}
}

func TestTurnEndpointWithoutTurnConfiguredStillOffersStun(t *testing.T) {
	s := turnServer(t, nil)
	dto := payloadOf[TurnDTO](t, call(t, s, http.MethodGet, "/api/turn", "nick", nil))

	if len(dto.IceServers) != 1 || len(dto.IceServers[0].URLs) == 0 {
		t.Fatalf("expected a STUN-only configuration, got %+v", dto.IceServers)
	}
	if !strings.HasPrefix(dto.IceServers[0].URLs[0], "stun:") {
		t.Fatalf("unexpected default ICE server %+v", dto.IceServers[0])
	}
}

func TestTurnEndpointNeedsAnIdentity(t *testing.T) {
	s := turnServer(t, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/turn", nil)
	req.Header.Set("X-Layup-Protocol-Version", "1")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without an identity, got %d", rec.Code)
	}
}
