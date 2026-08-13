package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/directory"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

func knock(t *testing.T, s *Server, from, atHandle string) (RequestDTO, int, string) {
	t.Helper()
	rec := call(t, s, http.MethodPost, "/api/requests", from, map[string]string{
		"type":     "KNOCK_TO_JOIN",
		"toUserId": string(directory.DevUserID(atHandle)),
	})
	if rec.Code != http.StatusOK {
		return RequestDTO{}, rec.Code, rec.Body.String()
	}
	return payloadOf[RequestDTO](t, rec), rec.Code, ""
}

func TestKnockingIsAddressedAtAPersonAndRevealsNothing(t *testing.T) {
	s := testServer(t)
	private := createLayup(t, s, "nick", "Acquisition of Initech", "PRIVATE")

	request, code, body := knock(t, s, "karl", "nick")
	if code != http.StatusOK {
		t.Fatalf("knock: got %d (%s)", code, body)
	}
	if request.Type != "KNOCK_TO_JOIN" || request.State != "PENDING" {
		t.Fatalf("unexpected knock: %+v", request)
	}
	// The knocker learns nothing about the private layup.
	if request.LayupID != "" || request.LayupTitle != "" {
		t.Fatalf("a knocker must not see private layup detail: %+v", request)
	}
	if strings.Contains(body, "Initech") {
		t.Fatal("the private title leaked in the response")
	}

	// The requester sees their own pending state.
	list := payloadOf[RequestListDTO](t, call(t, s, http.MethodGet, "/api/requests", "karl", nil))
	if len(list.Outgoing) != 1 || list.Outgoing[0].State != "PENDING" {
		t.Fatalf("the knocker should see a pending request: %+v", list.Outgoing)
	}
	if list.Outgoing[0].LayupID != "" {
		t.Fatal("the pending knock must not name the layup")
	}

	// The people inside see it and may act on it.
	inside := payloadOf[RequestListDTO](t, call(t, s, http.MethodGet, "/api/requests", "nick", nil))
	if len(inside.Incoming) != 1 || inside.Incoming[0].FromName != "Karl" {
		t.Fatalf("participants should see the knock: %+v", inside.Incoming)
	}
	if inside.Incoming[0].LayupID != private.Layup.ID {
		t.Fatalf("a participant may see which layup is being knocked on: %+v", inside.Incoming[0])
	}
}

func TestOneAcceptanceAdmitsTheKnockerExactlyOnce(t *testing.T) {
	s := testServer(t)
	open := createLayup(t, s, "nick", "Capture path", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/join", "emelia", nil).Code; code != http.StatusOK {
		t.Fatalf("emelia join: %d", code)
	}

	request, code, body := knock(t, s, "karl", "nick")
	if code != http.StatusOK {
		t.Fatalf("knock: %d (%s)", code, body)
	}

	// Any participant may admit; the first acceptance wins.
	rec := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/accept", "emelia", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("accept by a participant: %d (%s)", rec.Code, rec.Body.String())
	}
	result := payloadOf[AcceptResultDTO](t, rec)
	active := 0
	for _, participant := range result.Layup.Participants {
		if participant.LeftAt == nil {
			active++
		}
	}
	if active != 3 {
		t.Fatalf("the knocker should have been admitted once, got %d participants", active)
	}

	// A second acceptance cannot admit them again.
	if code := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/accept", "nick", nil).Code; code != http.StatusConflict {
		t.Fatalf("expected 409 on a second acceptance, got %d", code)
	}
	state := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+open.Layup.ID, "nick", nil))
	admitted := 0
	for _, participant := range state.Participants {
		if participant.DisplayName == "Karl" && participant.LeftAt == nil {
			admitted++
		}
	}
	if admitted != 1 {
		t.Fatalf("the knocker must be admitted exactly once, got %d memberships", admitted)
	}
}

func TestKnockingRequiresSomethingToKnockOn(t *testing.T) {
	s := testServer(t)

	// Nobody is in a layup.
	if _, code, _ := knock(t, s, "karl", "nick"); code != http.StatusConflict {
		t.Fatalf("expected 409 knocking on someone idle, got %d", code)
	}

	// You cannot knock on a layup you are already in.
	open := createLayup(t, s, "nick", "Capture path", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	if _, code, _ := knock(t, s, "karl", "nick"); code != http.StatusConflict {
		t.Fatalf("expected 409 knocking on your own layup, got %d", code)
	}
}

func TestParticipantsAreNotifiedOfAKnock(t *testing.T) {
	srv, api := realtimeServer(t)
	nick := dial(t, srv, "v=1&devUser=nick")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)

	createLayup(t, api, "nick", "Acquisition of Initech", "PRIVATE")
	if _, code, body := knock(t, api, "karl", "nick"); code != http.StatusOK {
		t.Fatalf("knock: %d (%s)", code, body)
	}

	incoming := awaitType(t, nick, TypeRequestIncoming)
	var dto RequestDTO
	if err := protocol.DecodePayload(incoming, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.Type != "KNOCK_TO_JOIN" || dto.FromName != "Karl" {
		t.Fatalf("unexpected knock notification: %+v", dto)
	}

	// Declining leaves the knocker outside.
	if code := call(t, api, http.MethodPost, "/api/requests/"+dto.ID+"/decline", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("decline: %d", code)
	}
	state := payloadOf[LayupDTO](t, call(t, api, http.MethodGet, "/api/layups/"+dto.LayupID, "nick", nil))
	for _, participant := range state.Participants {
		if participant.DisplayName == "Karl" {
			t.Fatal("a declined knocker must not be in the layup")
		}
	}
}
