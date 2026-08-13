package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/directory"
)

func authedRequest(t *testing.T, s *Server, method, path, devUser string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set(protocol.HeaderVersion, strconv.Itoa(protocol.Version))
	if devUser != "" {
		req.Header.Set(HeaderDevUser, devUser)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func payloadOf[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var env protocol.Envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("response is not an envelope: %v (%s)", err, rec.Body.String())
	}
	if err := env.Validate(); err != nil {
		t.Fatalf("invalid envelope: %v", err)
	}
	var payload T
	if err := protocol.DecodePayload(env, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	return payload
}

func TestMeIdentifiesTheDevelopmentUser(t *testing.T) {
	s := testServer(t)
	rec := authedRequest(t, s, http.MethodGet, "/api/me", "karl")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	me := payloadOf[MeDTO](t, rec)
	if me.User.DisplayName != "Karl" {
		t.Fatalf("unexpected user: %+v", me.User)
	}
	if me.Organisation.ID != string(directory.DevOrganisationID) {
		t.Fatalf("organisation must come from the directory, got %q", me.Organisation.ID)
	}
}

func TestDirectoryListsAtLeastFourPeopleInOneOrganisation(t *testing.T) {
	s := testServer(t)
	rec := authedRequest(t, s, http.MethodGet, "/api/directory", "nick")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	dir := payloadOf[DirectoryDTO](t, rec)
	if len(dir.Users) < 4 {
		t.Fatalf("expected at least four users, got %d", len(dir.Users))
	}
	if dir.Organisation.ID != string(directory.DevOrganisationID) {
		t.Fatalf("unexpected organisation %+v", dir.Organisation)
	}
	for _, user := range dir.Users {
		if user.ID == "" || user.DisplayName == "" {
			t.Fatalf("incomplete user entry: %+v", user)
		}
	}
}

func TestAuthenticatedRoutesRejectMissingOrUnknownIdentity(t *testing.T) {
	s := testServer(t)

	missing := authedRequest(t, s, http.MethodGet, "/api/me", "")
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without an identity header, got %d", missing.Code)
	}

	unknown := authedRequest(t, s, http.MethodGet, "/api/me", "mallory")
	if unknown.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for an unknown identity, got %d", unknown.Code)
	}
}

func TestIdentityCannotChooseItsOwnOrganisation(t *testing.T) {
	s := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	req.Header.Set(protocol.HeaderVersion, strconv.Itoa(protocol.Version))
	req.Header.Set(HeaderDevUser, "karl")
	// A hostile client asserting a different organisation must be ignored.
	req.Header.Set("X-Layup-Organisation", "org_someoneelse")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	me := payloadOf[MeDTO](t, rec)
	if me.Organisation.ID != string(directory.DevOrganisationID) {
		t.Fatalf("organisation must be server-decided, got %q", me.Organisation.ID)
	}
}

func TestPublicProtocolRouteStillNeedsNoIdentity(t *testing.T) {
	s := testServer(t)
	rec := authedRequest(t, s, http.MethodGet, "/api/protocol", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("protocol discovery must not require an identity, got %d", rec.Code)
	}
}
