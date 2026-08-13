package httpapi

import (
	"net/http"
	"testing"
)

// Being invited while already in a layup offers three answers, and none of them
// merges two layups together (SPEC.md §6.4).

func TestJoinTheirsLeavesTheCurrentLayupFirst(t *testing.T) {
	s := testServer(t)

	// Karl is busy in his own layup with Emelia.
	karlsLayup := createLayup(t, s, "karl", "Karl and Emelia", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+karlsLayup.Layup.ID+"/join", "emelia", nil).Code; code != http.StatusOK {
		t.Fatalf("emelia join: %d", code)
	}

	// Nick invites Karl to a new layup and Karl says "Join theirs".
	request := invite(t, s, "nick", "karl", "Pairing")
	rec := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/accept", "karl", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("accept: %d (%s)", rec.Code, rec.Body.String())
	}
	result := payloadOf[AcceptResultDTO](t, rec)

	// He is in exactly the new layup...
	newActive := 0
	for _, participant := range result.Layup.Participants {
		if participant.LeftAt == nil {
			newActive++
		}
	}
	if newActive != 2 {
		t.Fatalf("expected Nick and Karl in the new layup, got %d", newActive)
	}

	// ...and has left the old one, which continues for Emelia.
	old := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+karlsLayup.Layup.ID, "emelia", nil))
	if !old.Active {
		t.Fatal("the layup Karl left should continue for Emelia")
	}
	for _, participant := range old.Participants {
		if participant.DisplayName == "Karl" && participant.LeftAt == nil {
			t.Fatal("Karl must have left his previous layup before joining the new one")
		}
	}
	// No merge: the two layups are still two layups.
	if old.ID == result.Layup.ID {
		t.Fatal("layups must never be merged")
	}
	if len(old.Participants) != 2 || len(result.Layup.Participants) != 2 {
		t.Fatalf("participants were moved rather than merged: old=%d new=%d",
			len(old.Participants), len(result.Layup.Participants))
	}
}

func TestInviteThemHereCreatesAnInvitationToTheCurrentLayup(t *testing.T) {
	s := testServer(t)
	karlsLayup := createLayup(t, s, "karl", "Karl's layup", "ORGANISATION")

	// Nick invites Karl; Karl answers with "Invite them here" instead.
	incoming := invite(t, s, "nick", "karl", "Pairing")
	counter, code := inviteInto(t, s, "karl", "nick", karlsLayup.Layup.ID)
	if code != http.StatusOK {
		t.Fatalf("counter-invitation: %d", code)
	}
	if code := call(t, s, http.MethodPost, "/api/requests/"+incoming.ID+"/decline", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("decline: %d", code)
	}

	// Nick accepts and lands in Karl's existing layup - no third layup exists.
	rec := call(t, s, http.MethodPost, "/api/requests/"+counter.ID+"/accept", "nick", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("accept counter-invitation: %d (%s)", rec.Code, rec.Body.String())
	}
	result := payloadOf[AcceptResultDTO](t, rec)
	if result.Layup.ID != karlsLayup.Layup.ID {
		t.Fatalf("expected Karl's layup, got %q", result.Layup.ID)
	}
	if result.Layup.CreatorMembershipID != karlsLayup.YourMembershipID {
		t.Fatal("creator authority stays with the original creator membership")
	}

	listing := openLayups(t, s, "emelia")
	if len(listing.Layups) != 1 {
		t.Fatalf("exactly one layup should exist, got %d", len(listing.Layups))
	}
}

func TestDecliningWhileBusyChangesNothing(t *testing.T) {
	s := testServer(t)
	karlsLayup := createLayup(t, s, "karl", "Karl's layup", "ORGANISATION")
	request := invite(t, s, "nick", "karl", "Pairing")

	if code := call(t, s, http.MethodPost, "/api/requests/"+request.ID+"/decline", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("decline: %d", code)
	}

	state := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+karlsLayup.Layup.ID, "karl", nil))
	active := 0
	for _, participant := range state.Participants {
		if participant.LeftAt == nil {
			active++
		}
	}
	if active != 1 || !state.Active {
		t.Fatalf("declining must leave the current layup untouched: %+v", state)
	}
}
