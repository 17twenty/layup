package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/config"
	"github.com/layup-app/layup/services/control/internal/directory"
)

const testJoinCode = "LAYUP-7K2M"

// registerServer follows testServer (server_test.go:14) but gives the server a
// hosted directory and, optionally, a join code - the two things registration
// turns on.
func registerServer(t *testing.T, joinCode string, log *slog.Logger) *Server {
	t.Helper()
	env := map[string]string{
		config.EnvPrefix + "ENV":       "selfhosted",
		config.EnvPrefix + "JOIN_CODE": joinCode,
	}
	cfg, err := config.Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	base := time.Unix(1700000000, 0)
	calls := 0
	return New(cfg, Options{
		Logger:    log,
		Directory: hostedDirectory(t),
		Now: func() time.Time {
			calls++
			return base.Add(time.Duration(calls-1) * 2 * time.Second)
		},
	})
}

// postRegister sends a registration body to a server and returns the recorder.
func postRegister(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/register", strings.NewReader(body))
	req.Header.Set(protocol.HeaderVersion, strconv.Itoa(protocol.Version))
	req.Header.Set("Content-Type", "application/json")
	// Deliberately not loopback: registration is a public route.
	req.RemoteAddr = "203.0.113.9:5555"
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestRegisterWithTheRightCodeReturnsATokenAndUser(t *testing.T) {
	s := registerServer(t, testJoinCode, nil)

	rec := postRegister(t, s, `{"code":"`+testJoinCode+`","displayName":"Nick"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	registered := payloadOf[RegisterResponse](t, rec)
	if registered.Token == "" {
		t.Fatal("registration returned no token")
	}
	if registered.User.DisplayName != "Nick" {
		t.Fatalf("unexpected user: %+v", registered.User)
	}
	if registered.User.ID == "" {
		t.Fatal("registration returned no user id")
	}
	if registered.Organisation.ID != string(directory.HostedOrganisationID) {
		t.Fatalf("unexpected organisation: %+v", registered.Organisation)
	}

	// The token must actually work.
	req := versionedRequest(t, http.MethodGet, "/api/directory")
	req.Header.Set(HeaderAuthorization, "Bearer "+registered.Token)
	req.RemoteAddr = "203.0.113.9:5555"
	dirRec := httptest.NewRecorder()
	s.ServeHTTP(dirRec, req)
	if dirRec.Code != http.StatusOK {
		t.Fatalf("directory with the issued token: expected 200, got %d (%s)",
			dirRec.Code, dirRec.Body.String())
	}
	listed := payloadOf[DirectoryDTO](t, dirRec)
	found := false
	for _, user := range listed.Users {
		if user.ID == registered.User.ID && user.DisplayName == "Nick" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the registered user is not in the directory: %+v", listed.Users)
	}
}

func TestRegisterWithTheWrongCodeIsRejected(t *testing.T) {
	s := registerServer(t, testJoinCode, nil)

	rec := postRegister(t, s, `{"code":"nope","displayName":"Nick"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "forbidden") {
		t.Fatalf("expected a forbidden code, got %s", rec.Body.String())
	}
	// The refusal must not leak the configured code.
	if strings.Contains(rec.Body.String(), testJoinCode) {
		t.Fatalf("the response revealed the join code: %s", rec.Body.String())
	}
}

func TestRegisterIsRefusedWhenNoJoinCodeIsConfigured(t *testing.T) {
	s := registerServer(t, "", nil)

	for _, body := range []string{
		`{"code":"","displayName":"Nick"}`,
		`{"code":"anything","displayName":"Nick"}`,
	} {
		rec := postRegister(t, s, body)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s: expected 403 with no join code configured, got %d (%s)",
				body, rec.Code, rec.Body.String())
		}
	}
}

func TestRegisterRejectsABlankDisplayName(t *testing.T) {
	s := registerServer(t, testJoinCode, nil)

	rec := postRegister(t, s, `{"code":"`+testJoinCode+`","displayName":"  "}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_request") {
		t.Fatalf("expected an invalid_request code, got %s", rec.Body.String())
	}
}

func TestRegisterIsRefusedOnADirectoryThatIssuesNoTokens(t *testing.T) {
	// The development directory has nobody to register into; a server on it
	// must say so rather than pretend.
	env := map[string]string{
		config.EnvPrefix + "ENV":       "selfhosted",
		config.EnvPrefix + "JOIN_CODE": testJoinCode,
	}
	cfg, err := config.Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	s := New(cfg, Options{Directory: directory.NewDev()})

	rec := postRegister(t, s, `{"code":"`+testJoinCode+`","displayName":"Nick"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestTheTokenIsNeverLogged(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	s := registerServer(t, testJoinCode, log)

	rec := postRegister(t, s, `{"code":"`+testJoinCode+`","displayName":"Nick"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	registered := payloadOf[RegisterResponse](t, rec)

	// An authenticated call on the same token, both by header and on the
	// query string - the realtime handshake's shape.
	req := versionedRequest(t, http.MethodGet, "/api/me")
	req.Header.Set(HeaderAuthorization, "Bearer "+registered.Token)
	s.ServeHTTP(httptest.NewRecorder(), req)

	query := versionedRequest(t, http.MethodGet,
		"/api/me?"+protocol.QueryToken+"="+registered.Token)
	s.ServeHTTP(httptest.NewRecorder(), query)

	if strings.Contains(logs.String(), registered.Token) {
		t.Fatalf("the token appeared in the logs:\n%s", logs.String())
	}
	// The join code is a credential too.
	if strings.Contains(logs.String(), testJoinCode) {
		t.Fatalf("the join code appeared in the logs:\n%s", logs.String())
	}
}
