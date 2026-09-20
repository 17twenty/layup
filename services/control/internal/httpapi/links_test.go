package httpapi

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/layup-app/layup/services/control/internal/config"
)

func mintLink(t *testing.T, s *Server, devUser, layupID string) (LinkDTO, int) {
	t.Helper()
	rec := call(t, s, http.MethodPost, "/api/layups/"+layupID+"/link", devUser, nil)
	if rec.Code != http.StatusOK {
		return LinkDTO{}, rec.Code
	}
	return payloadOf[LinkDTO](t, rec), rec.Code
}

// joinByLink redeems a link token from the JSON body: the only place it may
// legally travel. A path-based version of this helper must never come back -
// that is exactly the leak Task 1 closes.
func joinByLink(t *testing.T, s *Server, devUser, token string) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, s, http.MethodPost, "/api/links/join", devUser, map[string]string{"token": token})
}

// testServerWithLogger follows testServer (server_test.go:24) but hands back
// the logger too, so a test can assert what did - and did not - get written.
func testServerWithLogger(t *testing.T, log *slog.Logger) *Server {
	t.Helper()
	env := map[string]string{config.EnvPrefix + "ENV": "dev"}
	cfg, err := config.Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	base := time.Unix(1700000000, 0)
	calls := 0
	return New(cfg, Options{
		Logger: log,
		Now: func() time.Time {
			calls++
			return base.Add(time.Duration(calls-1) * 2 * time.Second)
		},
	})
}

func TestAValidLinkJoinsTheIntendedLayup(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Link layup", "LINK")

	link, code := mintLink(t, s, "nick", created.Layup.ID)
	if code != http.StatusOK {
		t.Fatalf("mint link: %d", code)
	}
	if link.Token == "" || link.ExpiresAt.IsZero() {
		t.Fatalf("unexpected link: %+v", link)
	}

	rec := joinByLink(t, s, "karl", link.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("join by link: %d (%s)", rec.Code, rec.Body.String())
	}
	result := payloadOf[MembershipResultDTO](t, rec)
	if result.Layup.ID != created.Layup.ID {
		t.Fatalf("the link must open the intended layup, got %q", result.Layup.ID)
	}
	if len(result.Layup.Participants) != 2 {
		t.Fatalf("expected two participants, got %d", len(result.Layup.Participants))
	}
	if result.YourMembershipID == result.Layup.CreatorMembershipID {
		t.Fatal("joining by link is an ordinary membership")
	}
}

func TestLinkTokensRevealNothing(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Acquisition of Initech", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)

	// The token is opaque: no id, no title, no organisation inside it.
	for _, secret := range []string{created.Layup.ID, "Initech", "org_devlayup", "lay_"} {
		if strings.Contains(link.Token, secret) {
			t.Fatalf("token %q leaks %q", link.Token, secret)
		}
	}
	if len(link.Token) < 20 {
		t.Fatalf("token looks too short to be unguessable: %q", link.Token)
	}

	// A leaked link can still be replaced - but by revoking it first, not by
	// minting a second one alongside it. (This assertion used to demand that
	// two mints differ. Task 4 made a layup's link singular, so the mechanism
	// changed; the property it protects has not.)
	if code := call(t, s, http.MethodDelete, "/api/layups/"+created.Layup.ID+"/link", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("revoke: %d", code)
	}
	other, _ := mintLink(t, s, "nick", created.Layup.ID)
	if other.Token == link.Token {
		t.Fatal("a link minted after a revocation must be a new one")
	}
}

func TestInvalidLinksFailUsefullyWithoutRevealingAnything(t *testing.T) {
	s := testServer(t)

	rec := joinByLink(t, s, "karl", "not-a-real-token")
	if rec.Code != http.StatusGone {
		t.Fatalf("expected 410 for an unknown link, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ask for a new one") {
		t.Fatalf("the error should tell the user what to do: %s", rec.Body.String())
	}

	// A link to an ended layup fails the same way, so it is not an oracle.
	created := createLayup(t, s, "nick", "Ends soon", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/leave", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("leave: %d", code)
	}
	ended := joinByLink(t, s, "karl", link.Token)
	if ended.Code != http.StatusGone {
		t.Fatalf("expected 410 for a link to an ended layup, got %d", ended.Code)
	}
}

func TestOnlyParticipantsCanMintALink(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Link layup", "LINK")

	if _, code := mintLink(t, s, "karl", created.Layup.ID); code != http.StatusForbidden {
		t.Fatalf("an outsider must not mint a link, got %d", code)
	}
}

// TestThePathBasedJoinRouteIsGone proves the leaky route (POST
// /api/links/{token}/join) no longer exists at all: not just that it rejects
// the token, but that the router has never heard of it. A 404 here is the
// difference between "closed" and "still there, still logging".
func TestThePathBasedJoinRouteIsGone(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Link layup", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)

	rec := call(t, s, http.MethodPost, "/api/links/"+link.Token+"/join", "karl", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("the path-based join route must be gone, got %d", rec.Code)
	}
}

// TestTheLinkTokenNeverAppearsInALogLine is the point of Task 1: a token in
// the URL path is written to Caddy's access log in cleartext, because Caddy's
// redaction covers query strings, not paths. Moving the token into the body
// only closes that hole if the server's own logging never turns around and
// writes the body - or the path, or the error - back out again. This checks
// both a successful and a failed redemption.
func TestTheLinkTokenNeverAppearsInALogLine(t *testing.T) {
	var logs safeBuffer
	log := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	s := testServerWithLogger(t, log)
	created := createLayup(t, s, "nick", "Link layup", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)

	if rec := joinByLink(t, s, "karl", link.Token); rec.Code != http.StatusOK {
		t.Fatalf("join by link: %d (%s)", rec.Code, rec.Body.String())
	}
	if strings.Contains(logs.String(), link.Token) {
		t.Fatalf("the token appeared in the logs after a successful join:\n%s", logs.String())
	}

	forged := "forged-" + link.Token
	if rec := joinByLink(t, s, "karl", forged); rec.Code != http.StatusGone {
		t.Fatalf("expected 410 for a forged token, got %d", rec.Code)
	}
	if strings.Contains(logs.String(), forged) || strings.Contains(logs.String(), link.Token) {
		t.Fatalf("the token appeared in the logs after a failed join:\n%s", logs.String())
	}
}

// TestALayupHasOneLiveLinkNotAGrowingPile is what makes revocation mean
// anything. If every request minted a new token, "revoke the link" would be a
// promise the server could not keep: there would be no *the* link, only a
// trail of live ones the host never sees.
func TestALayupHasOneLiveLinkNotAGrowingPile(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "One link", "LINK")

	first, code := mintLink(t, s, "nick", created.Layup.ID)
	if code != http.StatusOK {
		t.Fatalf("mint: %d", code)
	}
	second, _ := mintLink(t, s, "nick", created.Layup.ID)
	if second.Token != first.Token {
		t.Fatalf("asking twice must hand back the same link, got %q then %q", first.Token, second.Token)
	}
	if !second.ExpiresAt.Equal(first.ExpiresAt) {
		t.Fatalf("the link's life should not restart on being read again: %v then %v",
			first.ExpiresAt, second.ExpiresAt)
	}

	// A different member of the same layup gets the same link, not their own.
	if rec := joinByLink(t, s, "karl", first.Token); rec.Code != http.StatusOK {
		t.Fatalf("karl join by link: %d (%s)", rec.Code, rec.Body.String())
	}
	third, _ := mintLink(t, s, "karl", created.Layup.ID)
	if third.Token != first.Token {
		t.Fatal("a layup's link belongs to the layup, not to whoever asked for it")
	}
}

// TestRevokingALinkRefusesNewJoinsButKeepsThePeopleInside separates the two
// things a revocation is often confused with. It closes the door; it does not
// empty the room.
func TestRevokingALinkRefusesNewJoinsButKeepsThePeopleInside(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Revocable", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)

	if rec := joinByLink(t, s, "karl", link.Token); rec.Code != http.StatusOK {
		t.Fatalf("karl join by link: %d (%s)", rec.Code, rec.Body.String())
	}

	rec := call(t, s, http.MethodDelete, "/api/layups/"+created.Layup.ID+"/link", "nick", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d (%s)", rec.Code, rec.Body.String())
	}
	if revoked := payloadOf[LinkRevokedDTO](t, rec); revoked.LayupID != created.Layup.ID {
		t.Fatalf("unexpected revocation payload: %+v", revoked)
	}

	if rec := joinByLink(t, s, "emelia", link.Token); rec.Code != http.StatusGone {
		t.Fatalf("a revoked link must not let anyone new in, got %d (%s)", rec.Code, rec.Body.String())
	}
	// Karl is still where he was.
	view := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+created.Layup.ID, "karl", nil))
	if len(view.Participants) != 2 {
		t.Fatalf("revoking a link must not remove anyone: %+v", view.Participants)
	}

	// Revoking again is not an error, and still says nothing about what was
	// there: a caller cannot use it to probe.
	if again := call(t, s, http.MethodDelete, "/api/layups/"+created.Layup.ID+"/link", "nick", nil); again.Code != http.StatusOK {
		t.Fatalf("revoking twice should be uneventful, got %d", again.Code)
	}
}

func TestOnlyAMemberMayRevokeALink(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Revocable", "LINK")
	if _, code := mintLink(t, s, "nick", created.Layup.ID); code != http.StatusOK {
		t.Fatalf("mint: %d", code)
	}

	rec := call(t, s, http.MethodDelete, "/api/layups/"+created.Layup.ID+"/link", "karl", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("an outsider must not revoke a link, got %d (%s)", rec.Code, rec.Body.String())
	}
	// And it is still there for the people it belongs to.
	if _, code := mintLink(t, s, "nick", created.Layup.ID); code != http.StatusOK {
		t.Fatalf("the link should have survived: %d", code)
	}
}

// TestEndingTheLayupKillsItsLinkAndItsGuests hooks to the event, not a clock:
// a layup ends when its last participant leaves, and at that instant the link
// stops opening it and every guest session it let in stops authenticating.
// Here the last participant is the guest themselves, which is the case a
// timer-based cleanup would most easily miss.
func TestEndingTheLayupKillsItsLinkAndItsGuests(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Ends with us", "LINK")
	link, _ := mintLink(t, s, "nick", created.Layup.ID)
	session := seatAGuest(t, s, created.Layup.ID, "Sam")

	// Nick goes; the guest is still in the room, so nothing has ended yet.
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/leave", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("nick leave: %d", code)
	}
	if _, ok := s.links.resolve(link.Token); !ok {
		t.Fatal("the link must outlive one person leaving")
	}
	if _, ok := s.guests.resolve(session.Token); !ok {
		t.Fatal("the guest session must outlive one person leaving")
	}

	// Now the guest goes, and the layup goes with them.
	if code := guestCall(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/leave", session.Token, nil).Code; code != http.StatusOK {
		t.Fatalf("guest leave: %d", code)
	}
	if _, ok := s.links.resolve(link.Token); ok {
		t.Fatal("a link must not outlive the layup it opens")
	}
	if _, ok := s.guests.resolve(session.Token); ok {
		t.Fatal("endLayup must have been called: a guest session must not outlive its layup")
	}
	if rec := joinByLink(t, s, "karl", link.Token); rec.Code != http.StatusGone {
		t.Fatalf("expected 410 from a dead link, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rec := guestCall(t, s, http.MethodGet, "/api/turn", session.Token, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a dead guest token must authenticate nothing, got %d", rec.Code)
	}
}

// TestAnExpiredLinkIsReplacedRatherThanReturned: singular does not mean
// immortal. Once the TTL has passed, asking again mints a new one.
func TestAnExpiredLinkIsReplacedRatherThanReturned(t *testing.T) {
	clock := time.Unix(1700000000, 0)
	store := newLinkStore(func() time.Time { return clock })

	first, expiresAt := store.mint("lay_aaaaaaaa", "usr_devnickx", time.Hour)
	again, _ := store.mint("lay_aaaaaaaa", "usr_devnickx", time.Hour)
	if again != first {
		t.Fatal("a live link is handed back, not replaced")
	}

	clock = expiresAt.Add(time.Second)
	if _, ok := store.resolve(first); ok {
		t.Fatal("an expired link must not resolve")
	}
	replacement, _ := store.mint("lay_aaaaaaaa", "usr_devnickx", time.Hour)
	if replacement == first {
		t.Fatal("an expired link must be replaced, not resurrected")
	}
	if _, ok := store.resolve(first); ok {
		t.Fatal("the expired token must be gone from the store, not merely unusable")
	}
}
