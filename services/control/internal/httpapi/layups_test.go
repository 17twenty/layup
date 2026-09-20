package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

func call(t *testing.T, s *Server, method, path, devUser string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set(protocol.HeaderVersion, strconv.Itoa(protocol.Version))
	if devUser != "" {
		req.Header.Set(HeaderDevUser, devUser)
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func createLayup(t *testing.T, s *Server, devUser, title, visibility string) MembershipResultDTO {
	t.Helper()
	rec := call(t, s, http.MethodPost, "/api/layups", devUser, map[string]string{
		"title": title, "visibility": visibility,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("create layup: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	return payloadOf[MembershipResultDTO](t, rec)
}

func TestCreateJoinAndLeaveALogicalLayup(t *testing.T) {
	s := testServer(t)

	created := createLayup(t, s, "nick", "Auth is doing something dumb", "PRIVATE")
	if !created.Layup.Active || len(created.Layup.Participants) != 1 {
		t.Fatalf("unexpected created layup: %+v", created.Layup)
	}
	if created.YourMembershipID == "" || created.Layup.CreatorMembershipID != created.YourMembershipID {
		t.Fatalf("creator membership should be the caller's: %+v", created)
	}
	if !created.Layup.HasCreatorAuthority {
		t.Fatal("a new layup has creator authority")
	}

	// A second person cannot walk into a private layup uninvited.
	forbidden := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for an uninvited join, got %d", forbidden.Code)
	}

	// An organisation-open layup is joinable.
	open := createLayup(t, s, "nick", "Capture path", "ORGANISATION")
	joined := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/join", "karl", nil)
	if joined.Code != http.StatusOK {
		t.Fatalf("expected 200 joining an open layup, got %d (%s)", joined.Code, joined.Body.String())
	}
	result := payloadOf[MembershipResultDTO](t, joined)
	if len(result.Layup.Participants) != 2 {
		t.Fatalf("expected two participants, got %d", len(result.Layup.Participants))
	}
	if result.YourMembershipID == result.Layup.CreatorMembershipID {
		t.Fatal("a joiner must not be the creator membership")
	}

	// Leaving updates the membership list.
	left := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/leave", "karl", nil)
	if left.Code != http.StatusOK {
		t.Fatalf("expected 200 leaving, got %d", left.Code)
	}
	after := payloadOf[MembershipResultDTO](t, left)
	active := 0
	for _, participant := range after.Layup.Participants {
		if participant.LeftAt == nil {
			active++
		}
	}
	if active != 1 {
		t.Fatalf("expected one remaining participant, got %d", active)
	}
}

func TestCreatorDevolutionIsVisibleInAPIState(t *testing.T) {
	s := testServer(t)
	open := createLayup(t, s, "nick", "Capture path", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}

	// The creator leaves.
	left := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/leave", "nick", nil)
	if left.Code != http.StatusOK {
		t.Fatalf("leave: %d (%s)", left.Code, left.Body.String())
	}
	state := payloadOf[MembershipResultDTO](t, left).Layup

	if state.HasCreatorAuthority {
		t.Fatal("creator authority must be gone in the API state")
	}
	if state.CreatorMembershipID != "" {
		t.Fatalf("no membership may be named as creator, got %q", state.CreatorMembershipID)
	}
	for _, participant := range state.Participants {
		if participant.IsCreatorMembership {
			t.Fatalf("participant %s still marked as creator", participant.DisplayName)
		}
	}
	if !state.Active {
		t.Fatal("the layup continues without a creator")
	}

	// The former creator rejoins: ordinary membership, no authority anywhere.
	rejoined := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/join", "nick", nil)
	if rejoined.Code != http.StatusOK {
		t.Fatalf("rejoin: %d", rejoined.Code)
	}
	result := payloadOf[MembershipResultDTO](t, rejoined)
	if result.Layup.HasCreatorAuthority || result.Layup.CreatorMembershipID != "" {
		t.Fatalf("authority reappeared on rejoin: %+v", result.Layup)
	}
	if result.YourMembershipID == open.YourMembershipID {
		t.Fatal("a rejoin must mint a new membership id")
	}
}

func TestLayupReadIsScopedToPeopleEntitledToIt(t *testing.T) {
	s := testServer(t)
	private := createLayup(t, s, "nick", "Acquisition of Initech", "PRIVATE")

	// An outsider is not even told it exists.
	outsider := call(t, s, http.MethodGet, "/api/layups/"+private.Layup.ID, "karl", nil)
	if outsider.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for an outsider, got %d", outsider.Code)
	}
	if bytes.Contains(outsider.Body.Bytes(), []byte("Initech")) {
		t.Fatal("private title leaked in the error response")
	}

	// The participant can read it.
	insider := call(t, s, http.MethodGet, "/api/layups/"+private.Layup.ID, "nick", nil)
	if insider.Code != http.StatusOK {
		t.Fatalf("expected 200 for a participant, got %d", insider.Code)
	}
	if payloadOf[LayupDTO](t, insider).Title != "Acquisition of Initech" {
		t.Fatal("a participant should see the title")
	}
}

func TestLayupCommandsRejectJunk(t *testing.T) {
	s := testServer(t)

	if code := call(t, s, http.MethodGet, "/api/layups/not-an-id", "nick", nil).Code; code != http.StatusBadRequest {
		t.Errorf("expected 400 for a malformed id, got %d", code)
	}
	if code := call(t, s, http.MethodPost, "/api/layups/lay_devzzzzzz/join", "nick", nil).Code; code != http.StatusNotFound {
		t.Errorf("expected 404 for an unknown layup, got %d", code)
	}
	unknownField := call(t, s, http.MethodPost, "/api/layups", "nick", map[string]any{"titel": "typo"})
	if unknownField.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for an unknown field, got %d", unknownField.Code)
	}
	badVisibility := call(t, s, http.MethodPost, "/api/layups", "nick", map[string]string{"visibility": "PUBLIC"})
	if badVisibility.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for an unknown visibility, got %d", badVisibility.Code)
	}

	open := createLayup(t, s, "nick", "Capture path", "ORGANISATION")
	notAMember := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/leave", "karl", nil)
	if notAMember.Code != http.StatusConflict {
		t.Errorf("expected 409 leaving a layup you are not in, got %d", notAMember.Code)
	}
}

func TestParticipantsSeeLayupStateOverRealtime(t *testing.T) {
	srv, api := realtimeServer(t)

	nick := dial(t, srv, "v=1&devUser=nick")
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, nick, "presence.snapshot")
	_ = awaitType(t, karl, "presence.snapshot")

	open := createLayup(t, api, "nick", "Capture path", "ORGANISATION")
	// Nick is a participant, so he is told about his own layup.
	first := awaitType(t, nick, TypeLayupState)
	var state LayupDTO
	if err := protocol.DecodePayload(first, &state); err != nil {
		t.Fatalf("layup state payload: %v", err)
	}
	if state.ID != open.Layup.ID || len(state.Participants) != 1 {
		t.Fatalf("unexpected state: %+v", state)
	}

	// Karl joins: both participants get the updated membership list.
	if code := call(t, api, http.MethodPost, "/api/layups/"+open.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	updated := awaitType(t, nick, TypeLayupState)
	if err := protocol.DecodePayload(updated, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Participants) != 2 {
		t.Fatalf("membership list should update in realtime: %+v", state.Participants)
	}
	karlState := awaitType(t, karl, TypeLayupState)
	if err := protocol.DecodePayload(karlState, &state); err != nil {
		t.Fatal(err)
	}
	if state.ID != open.Layup.ID {
		t.Fatalf("the joiner should receive the layup state: %+v", state)
	}
}

func TestLeavingUpdatesPresenceActivity(t *testing.T) {
	srv, api := realtimeServer(t)
	nick := dial(t, srv, "v=1&devUser=nick")
	_ = awaitType(t, nick, "presence.snapshot")

	open := createLayup(t, api, "nick", "Capture path", "ORGANISATION")
	inLayup := findUpdateWhere(t, nick, "usr_devnickx", func(p presencefeed.PresenceDTO) bool {
		return p.Activity == "IN_OPEN_LAYUP"
	})
	if inLayup.LayupID != open.Layup.ID {
		t.Fatalf("expected activity to name the layup, got %+v", inLayup)
	}

	if code := call(t, api, http.MethodPost, "/api/layups/"+open.Layup.ID+"/leave", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("leave: %d", code)
	}
	after := findUpdateWhere(t, nick, "usr_devnickx", func(p presencefeed.PresenceDTO) bool { return p.Activity == "NONE" })
	if after.LayupID != "" {
		t.Fatalf("activity should be clear after leaving: %+v", after)
	}
}

// TestAGuestParticipantIsMarkedInTheLayupDTO gives the desktop client a way to
// tell a guest's membership from an ordinary one when all it otherwise has is
// a membership id. input-guard.ts's "a guest is never handed the mouse"
// refusal depends on this: the client sees membership ids on the wire, never
// user ids, so the server has to say which memberships are guests.
func TestAGuestParticipantIsMarkedInTheLayupDTO(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Guest call", "LINK")
	session := seatAGuest(t, s, created.Layup.ID, "Sam")

	rec := call(t, s, http.MethodGet, "/api/layups/"+created.Layup.ID, "nick", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get layup: %d (%s)", rec.Code, rec.Body.String())
	}
	view := payloadOf[LayupDTO](t, rec)

	var sawGuest, sawMember bool
	for _, participant := range view.Participants {
		if participant.MembershipID == string(session.MembershipID) {
			sawGuest = true
			if !participant.IsGuest {
				t.Fatalf("the guest's own participant entry must say so: %+v", participant)
			}
		} else {
			sawMember = true
			if participant.IsGuest {
				t.Fatalf("a registered member must not be marked a guest: %+v", participant)
			}
		}
	}
	if !sawGuest || !sawMember {
		t.Fatalf("expected both a guest and a member in the participant list: %+v", view.Participants)
	}
}
