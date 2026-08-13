package httpapi

import (
	"net/http"
	"testing"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/directory"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

func invite(t *testing.T, s *Server, from, toHandle, note string) RequestDTO {
	t.Helper()
	to := directory.DevUserID(toHandle)
	rec := call(t, s, http.MethodPost, "/api/requests", from, map[string]string{
		"type":     "INVITE_USER_TO_NEW_LAYUP",
		"toUserId": string(to),
		"note":     note,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("invite: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	return payloadOf[RequestDTO](t, rec)
}

func TestInvitingAnAvailablePersonCreatesOnePendingRequest(t *testing.T) {
	s := testServer(t)
	request := invite(t, s, "nick", "karl", "Auth is doing something dumb")

	if request.State != "PENDING" || request.Type != "INVITE_USER_TO_NEW_LAYUP" {
		t.Fatalf("unexpected request: %+v", request)
	}
	if request.FromName != "Nick" || request.ToName != "Karl" {
		t.Fatalf("both identities should be named: %+v", request)
	}
	if request.Note != "Auth is doing something dumb" {
		t.Fatalf("the note should survive: %+v", request)
	}
	// No layup exists yet: clicking someone starts nothing on its own.
	if request.LayupID != "" || request.ResultLayupID != "" {
		t.Fatalf("no layup may exist before acceptance: %+v", request)
	}

	// The recipient sees it; the sender sees their own outgoing one.
	karl := payloadOf[RequestListDTO](t, call(t, s, http.MethodGet, "/api/requests", "karl", nil))
	if len(karl.Incoming) != 1 || karl.Incoming[0].FromName != "Nick" {
		t.Fatalf("recipient should see one incoming request: %+v", karl)
	}
	nick := payloadOf[RequestListDTO](t, call(t, s, http.MethodGet, "/api/requests", "nick", nil))
	if len(nick.Outgoing) != 1 || len(nick.Incoming) != 0 {
		t.Fatalf("sender should see one outgoing request: %+v", nick)
	}
}

func TestAcceptingCreatesOneLayupAndTwoMemberships(t *testing.T) {
	s := testServer(t)
	request := invite(t, s, "nick", "karl", "Pairing")

	rec := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/accept", "karl", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("accept: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	result := payloadOf[AcceptResultDTO](t, rec)

	active := 0
	for _, participant := range result.Layup.Participants {
		if participant.LeftAt == nil {
			active++
		}
	}
	if active != 2 {
		t.Fatalf("acceptance must produce two memberships, got %d: %+v", active, result.Layup.Participants)
	}
	if result.Layup.Visibility != "PRIVATE" {
		t.Fatalf("an invitation creates a private layup, got %q", result.Layup.Visibility)
	}
	if result.YourMembershipID == "" || result.YourMembershipID == result.Layup.CreatorMembershipID {
		t.Fatalf("the accepter joins as an ordinary membership: %+v", result)
	}
	// The inviter created it, so the inviter's membership holds authority.
	creator := ""
	for _, participant := range result.Layup.Participants {
		if participant.IsCreatorMembership {
			creator = participant.DisplayName
		}
	}
	if creator != "Nick" {
		t.Fatalf("the inviter should hold creator authority, got %q", creator)
	}
	if result.Request.State != "ACCEPTED" || result.Request.ResultLayupID != result.Layup.ID {
		t.Fatalf("the request should record its result: %+v", result.Request)
	}
}

func TestRequestsCannotBeResolvedByTheWrongPerson(t *testing.T) {
	s := testServer(t)
	request := invite(t, s, "nick", "karl", "Pairing")

	if code := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/accept", "emelia", nil).Code; code != http.StatusForbidden {
		t.Errorf("a stranger must not accept, got %d", code)
	}
	if code := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/decline", "emelia", nil).Code; code != http.StatusForbidden {
		t.Errorf("a stranger must not decline, got %d", code)
	}
	if code := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/cancel", "karl", nil).Code; code != http.StatusForbidden {
		t.Errorf("only the sender may cancel, got %d", code)
	}

	if code := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/decline", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("the recipient may decline, got %d", code)
	}
	if code := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/accept", "karl", nil).Code; code != http.StatusConflict {
		t.Errorf("a declined request cannot be accepted, got %d", code)
	}
}

func TestRepeatedClicksProduceOneNotification(t *testing.T) {
	srv, api := realtimeServer(t)
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	first := invite(t, api, "nick", "karl", "Pairing")
	incoming := awaitType(t, karl, TypeRequestIncoming)
	var dto RequestDTO
	if err := protocol.DecodePayload(incoming, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.ID != first.ID {
		t.Fatalf("unexpected incoming request: %+v", dto)
	}

	// Clicking again collapses onto the same request and pushes nothing new.
	second := invite(t, api, "nick", "karl", "Pairing")
	if second.ID != first.ID {
		t.Fatalf("a repeated click must reuse the pending request: %q vs %q", second.ID, first.ID)
	}
	list := payloadOf[RequestListDTO](t, call(t, api, http.MethodGet, "/api/requests", "karl", nil))
	if len(list.Incoming) != 1 {
		t.Fatalf("the recipient must still see exactly one request: %+v", list.Incoming)
	}
}

func TestInvitationChangesViewerRelativeActivity(t *testing.T) {
	srv, api := realtimeServer(t)
	nick := dial(t, srv, "v=1&devUser=nick")
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	invite(t, api, "nick", "karl", "Pairing")

	// Karl's tile for Nick reads "inviting you"...
	inviting := findUpdateWhere(t, karl, "usr_devnickx", func(p presencefeed.PresenceDTO) bool {
		return p.Activity == "INVITING_YOU"
	})
	if inviting.Activity != "INVITING_YOU" {
		t.Fatalf("unexpected activity: %+v", inviting)
	}

	// ...and Nick's tile for Karl reads "waiting for you".
	waiting := findUpdateWhere(t, nick, "usr_devkarlx", func(p presencefeed.PresenceDTO) bool {
		return p.Activity == "WAITING_FOR_YOU"
	})
	if waiting.Activity != "WAITING_FOR_YOU" {
		t.Fatalf("unexpected activity: %+v", waiting)
	}
}

func TestBothSidesAreToldWhenARequestResolves(t *testing.T) {
	srv, api := realtimeServer(t)
	nick := dial(t, srv, "v=1&devUser=nick")
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	request := invite(t, api, "nick", "karl", "Pairing")
	if code := call(t, api, http.MethodPost, "/api/requests/"+request.ID+"/accept", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("accept: %d", code)
	}

	resolvedForNick := awaitType(t, nick, TypeRequestResolved)
	var dto RequestDTO
	if err := protocol.DecodePayload(resolvedForNick, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.State != "ACCEPTED" || dto.ResultLayupID == "" {
		t.Fatalf("the sender should learn the outcome: %+v", dto)
	}

	resolvedForKarl := awaitType(t, karl, TypeRequestResolved)
	if err := protocol.DecodePayload(resolvedForKarl, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.State != "ACCEPTED" {
		t.Fatalf("the recipient should see the resolution: %+v", dto)
	}
}
