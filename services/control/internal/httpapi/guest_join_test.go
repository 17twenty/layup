package httpapi

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/layup-app/layup/services/control/internal/domain"
)

// redeem redeems an invitation link as a browser guest would: no credential of
// any kind, because not having one is the whole situation.
func redeem(t *testing.T, s *Server, token, name string) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, s, http.MethodPost, "/api/guest/join", "", map[string]string{
		"token":       token,
		"displayName": name,
	})
}

func TestRedeemingALinkGivesAGuestASeatAndAName(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing with a stranger", "LINK")
	link, code := mintLink(t, s, "nick", created.Layup.ID)
	if code != http.StatusOK {
		t.Fatalf("mint: %d", code)
	}

	rec := redeem(t, s, link.Token, "Sam Okafor")
	if rec.Code != http.StatusOK {
		t.Fatalf("redeem: %d (%s)", rec.Code, rec.Body.String())
	}
	joined := payloadOf[GuestJoinDTO](t, rec)

	if joined.GuestToken == "" {
		t.Fatal("a guest needs a credential to do anything at all")
	}
	if joined.GuestToken == link.Token {
		t.Fatal("the session token must not be the link token: one is shared, the other is not")
	}
	if joined.Layup.ID != created.Layup.ID {
		t.Fatalf("wrong layup: %+v", joined.Layup)
	}
	if joined.MembershipID == "" {
		t.Fatal("a guest must be told which participant is them")
	}
	if len(joined.IceServers) == 0 {
		t.Fatal("a guest needs ICE servers in the same breath as the seat, or the call cannot start")
	}

	// The name is the point: the people already in the room see a person, not
	// a blank row.
	var mine *ParticipantDTO
	for i := range joined.Layup.Participants {
		if joined.Layup.Participants[i].MembershipID == joined.MembershipID {
			mine = &joined.Layup.Participants[i]
		}
	}
	if mine == nil {
		t.Fatalf("the guest is missing from the participant list: %+v", joined.Layup.Participants)
	}
	if mine.DisplayName != "Sam Okafor" {
		t.Fatalf("the guest rendered as %q, expected %q", mine.DisplayName, "Sam Okafor")
	}
	if mine.IsCreatorMembership {
		t.Fatal("arriving by link never confers creator authority")
	}

	// And the members see the same thing when they look.
	view := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+created.Layup.ID, "nick", nil))
	found := false
	for _, participant := range view.Participants {
		if participant.MembershipID == joined.MembershipID {
			found = true
			if participant.DisplayName != "Sam Okafor" {
				t.Fatalf("the host sees the guest as %q", participant.DisplayName)
			}
		}
	}
	if !found {
		t.Fatal("the host cannot see the guest who just joined")
	}

	// The credential works, and works only where Task 3 says it may.
	if rec := guestCall(t, s, http.MethodGet, "/api/layups/"+created.Layup.ID, joined.GuestToken, nil); rec.Code != http.StatusOK {
		t.Fatalf("the guest token should open their own layup, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rec := guestCall(t, s, http.MethodGet, "/api/directory", joined.GuestToken, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("the guest token must not open the directory, got %d", rec.Code)
	}
}

// TestARedeemedGuestIsNotInTheDirectory is asserted directly rather than
// inferred, because so much else depends on it: the directory is what presence,
// the roster and the organisation boundary are all computed from. A guest who
// leaked into it would leak into all three at once.
func TestARedeemedGuestIsNotInTheDirectory(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)
	before := len(s.directory.Users())

	rec := redeem(t, s, link.Token, "Sam")
	if rec.Code != http.StatusOK {
		t.Fatalf("redeem: %d (%s)", rec.Code, rec.Body.String())
	}
	joined := payloadOf[GuestJoinDTO](t, rec)

	var guestUserID domain.UserID
	for _, participant := range joined.Layup.Participants {
		if participant.MembershipID == joined.MembershipID {
			guestUserID = domain.UserID(participant.UserID)
		}
	}
	if guestUserID == "" {
		t.Fatal("could not find the guest's user id")
	}

	if after := len(s.directory.Users()); after != before {
		t.Fatalf("the directory grew from %d to %d: a guest is not a colleague", before, after)
	}
	for _, user := range s.directory.Users() {
		if user.ID == guestUserID {
			t.Fatalf("the guest %q is in directory.Users()", guestUserID)
		}
	}
	if _, err := s.directory.UserByID(guestUserID); err == nil {
		t.Fatalf("the directory answered for guest %q", guestUserID)
	}
}

func TestAGuestMustSayWhoTheyAre(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)

	// Blank, whitespace-only, too long to be a name, and names carrying
	// control characters: a name is the one string a stranger can put on other
	// people's screens, so it must be present, short, and printable.
	for _, name := range []string{
		"", "   ", "\t\n",
		strings.Repeat("a", maxGuestNameLength+1),
		"Sam\x00Okafor",
		"Sam\rOkafor",
	} {
		rec := redeem(t, s, link.Token, name)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("name %q: expected 400, got %d (%s)", name, rec.Code, rec.Body.String())
		}
	}

	// Nobody was let in by any of those attempts.
	view := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+created.Layup.ID, "nick", nil))
	if len(view.Participants) != 1 {
		t.Fatalf("a refused redemption must not seat anyone: %+v", view.Participants)
	}

	// Surrounding whitespace is trimmed rather than treated as a name.
	rec := redeem(t, s, link.Token, "  Sam  ")
	if rec.Code != http.StatusOK {
		t.Fatalf("redeem: %d (%s)", rec.Code, rec.Body.String())
	}
	joined := payloadOf[GuestJoinDTO](t, rec)
	for _, participant := range joined.Layup.Participants {
		if participant.MembershipID == joined.MembershipID && participant.DisplayName != "Sam" {
			t.Fatalf("expected a trimmed name, got %q", participant.DisplayName)
		}
	}
}

// TestABadLinkTellsAGuestNothing: this route is public, so anyone on the
// internet can hammer it. Every way a link can fail must look the same, and
// none of them may mention a layup.
func TestABadLinkTellsAGuestNothing(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Acquisition of Initech", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)

	unknown := redeem(t, s, "not-a-real-token", "Sam")
	if unknown.Code != http.StatusForbidden {
		t.Fatalf("an unknown token must be refused with 403, got %d (%s)", unknown.Code, unknown.Body.String())
	}

	if code := call(t, s, http.MethodDelete, "/api/layups/"+created.Layup.ID+"/link", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("revoke: %d", code)
	}
	revoked := redeem(t, s, link.Token, "Sam")
	if revoked.Code != http.StatusForbidden {
		t.Fatalf("a revoked token must be refused with 403, got %d (%s)", revoked.Code, revoked.Body.String())
	}
	if revoked.Body.String() != unknown.Body.String() {
		t.Fatalf("revoked and unknown must be indistinguishable:\n%s\n%s",
			revoked.Body.String(), unknown.Body.String())
	}
	for _, secret := range []string{created.Layup.ID, "Initech", "org_devlayup", "Nick"} {
		if strings.Contains(revoked.Body.String(), secret) {
			t.Fatalf("the refusal leaked %q: %s", secret, revoked.Body.String())
		}
	}

	// An ended layup is the same answer again.
	other := createLayup(t, s, "karl", "Ends now", "LINK")
	otherLink, _ := mintLink(t, s, "karl", other.Layup.ID)
	if code := call(t, s, http.MethodPost, "/api/layups/"+other.Layup.ID+"/leave", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("leave: %d", code)
	}
	ended := redeem(t, s, otherLink.Token, "Sam")
	if ended.Code != http.StatusForbidden || ended.Body.String() != unknown.Body.String() {
		t.Fatalf("an ended layup must look like every other bad link, got %d (%s)",
			ended.Code, ended.Body.String())
	}
}

// TestTwoRedemptionsAreTwoDifferentGuests: a link is handed around, and two
// people opening it are two people. One seat they take turns being thrown out
// of would be worse than not letting the second one in.
func TestTwoRedemptionsAreTwoDifferentGuests(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)

	first := payloadOf[GuestJoinDTO](t, redeem(t, s, link.Token, "Sam"))
	second := payloadOf[GuestJoinDTO](t, redeem(t, s, link.Token, "Robin"))

	if first.GuestToken == second.GuestToken {
		t.Fatal("two guests must not share a credential")
	}
	if first.MembershipID == second.MembershipID {
		t.Fatal("two guests must not share a seat")
	}

	view := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+created.Layup.ID, "nick", nil))
	names := map[string]string{}
	for _, participant := range view.Participants {
		names[participant.MembershipID] = participant.DisplayName
		if participant.UserID == "" {
			t.Fatalf("a participant with no user id: %+v", participant)
		}
	}
	if len(view.Participants) != 3 {
		t.Fatalf("expected the host and two guests, got %d: %+v", len(view.Participants), view.Participants)
	}
	if names[first.MembershipID] != "Sam" || names[second.MembershipID] != "Robin" {
		t.Fatalf("the two guests must keep their own names: %+v", names)
	}
	if names[first.MembershipID] == names[second.MembershipID] {
		t.Fatal("two guests must not be rendered as the same person")
	}
}

// TestTheGuestJoinRouteNeverLogsEitherToken: this endpoint handles two secrets
// at once - the link being redeemed and the session being issued - and it is
// the one place both exist in the same function.
func TestTheGuestJoinRouteNeverLogsEitherToken(t *testing.T) {
	var logs safeBuffer
	s := testServerWithLogger(t, slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	created := createLayup(t, s, "nick", "Pairing", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)

	joined := payloadOf[GuestJoinDTO](t, redeem(t, s, link.Token, "Sam"))
	forged := "forged-" + link.Token
	if rec := redeem(t, s, forged, "Sam"); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for a forged token, got %d", rec.Code)
	}

	for _, secret := range []string{link.Token, joined.GuestToken, forged} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("a token reached the logs:\n%s", logs.String())
		}
	}
}
