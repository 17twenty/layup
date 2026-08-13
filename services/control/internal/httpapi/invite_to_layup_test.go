package httpapi

import (
	"net/http"
	"testing"

	"github.com/layup-app/layup/services/control/internal/directory"
)

func inviteInto(t *testing.T, s *Server, from, toHandle, layupID string) (RequestDTO, int) {
	t.Helper()
	rec := call(t, s, http.MethodPost, "/api/requests", from, map[string]string{
		"type":     "INVITE_USER_TO_LAYUP",
		"toUserId": string(directory.DevUserID(toHandle)),
		"layupId":  layupID,
	})
	if rec.Code != http.StatusOK {
		return RequestDTO{}, rec.Code
	}
	return payloadOf[RequestDTO](t, rec), rec.Code
}

func TestInvitingIntoAnExistingLayupJoinsThatLayup(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Capture path", "PRIVATE")

	request, code := inviteInto(t, s, "nick", "karl", created.Layup.ID)
	if code != http.StatusOK {
		t.Fatalf("invite into layup: got %d", code)
	}
	// The invited person may see which layup they are being asked into.
	if request.LayupID != created.Layup.ID || request.LayupTitle != "Capture path" {
		t.Fatalf("the recipient needs the layup context: %+v", request)
	}

	rec := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/accept", "karl", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("accept: %d (%s)", rec.Code, rec.Body.String())
	}
	result := payloadOf[AcceptResultDTO](t, rec)

	if result.Layup.ID != created.Layup.ID {
		t.Fatalf("accepting must join the existing layup, got a different one: %q", result.Layup.ID)
	}
	if len(result.Layup.Participants) != 2 {
		t.Fatalf("expected two participants, got %d", len(result.Layup.Participants))
	}
	if result.Layup.CreatorMembershipID != created.YourMembershipID {
		t.Fatal("creator authority must be untouched by someone joining")
	}
}

func TestOnlyAParticipantMayInviteIntoALayup(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Capture path", "PRIVATE")

	// Emelia is not in the layup and cannot invite anyone into it.
	if _, code := inviteInto(t, s, "emelia", "karl", created.Layup.ID); code != http.StatusForbidden {
		t.Fatalf("expected 403 for an outsider inviting, got %d", code)
	}

	// Inviting someone who is already inside is a conflict, not a second invite.
	if _, code := inviteInto(t, s, "nick", "nick", created.Layup.ID); code != http.StatusConflict {
		t.Fatalf("expected 409 inviting someone already present, got %d", code)
	}
}

func TestDecliningAnInvitationChangesNoMemberships(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Capture path", "PRIVATE")
	request, _ := inviteInto(t, s, "nick", "karl", created.Layup.ID)

	if code := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/decline", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("decline: %d", code)
	}

	state := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+created.Layup.ID, "nick", nil))
	active := 0
	for _, participant := range state.Participants {
		if participant.LeftAt == nil {
			active++
		}
	}
	if active != 1 {
		t.Fatalf("declining must not change memberships, got %d participants", active)
	}
	if !state.Active || state.CreatorMembershipID != created.YourMembershipID {
		t.Fatalf("the layup should be untouched: %+v", state)
	}

	// And the invitee still cannot walk in on their own.
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil).Code; code != http.StatusForbidden {
		t.Fatalf("expected 403 joining a private layup after declining, got %d", code)
	}
}

func TestInvitingIntoALayupThatHasEnded(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Capture path", "PRIVATE")
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/leave", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("leave: %d", code)
	}
	if _, code := inviteInto(t, s, "nick", "karl", created.Layup.ID); code != http.StatusConflict {
		t.Fatalf("expected 409 inviting into an ended layup, got %d", code)
	}
}
