package httpapi

import (
	"testing"
	"time"

	"github.com/layup-app/layup/services/control/internal/domain"
)

func newTestGuestSession(t *testing.T, s *guestStore, layupID domain.LayupID, displayName string) GuestSession {
	t.Helper()
	gen := domain.NewRandomIDs()
	membershipID := domain.NewMembershipID(gen)
	userID := newGuestUserID()
	session, err := s.create(layupID, membershipID, userID, displayName)
	if err != nil {
		t.Fatalf("create guest session: %v", err)
	}
	return session
}

func TestAGuestUserIDSatisfiesTheOrdinaryUserIDShape(t *testing.T) {
	// This is the trap the brief warns about: a hand-rolled generator that
	// looks plausible fails domain.ValidateID almost every time, because the
	// id alphabet excludes hex digits like 0, 1, 8, 9. Guard it directly.
	for i := 0; i < 200; i++ {
		id := newGuestUserID()
		if err := id.Validate(); err != nil {
			t.Fatalf("guest user id %q failed validation: %v", id, err)
		}
	}
}

func TestACreatedGuestSessionResolvesByItsToken(t *testing.T) {
	s := newGuestStore(nil)
	layupID := domain.NewLayupID(domain.NewRandomIDs())

	session := newTestGuestSession(t, s, layupID, "Robin")
	if session.Token == "" {
		t.Fatal("expected a non-empty token")
	}
	if session.LayupID != layupID {
		t.Fatalf("expected layup %q, got %q", layupID, session.LayupID)
	}
	if session.DisplayName != "Robin" {
		t.Fatalf("expected display name %q, got %q", "Robin", session.DisplayName)
	}

	resolved, ok := s.resolve(session.Token)
	if !ok {
		t.Fatal("expected the freshly-minted token to resolve")
	}
	if resolved != session {
		t.Fatalf("resolved session %+v does not match created session %+v", resolved, session)
	}
}

func TestAForgedGuestTokenDoesNotResolve(t *testing.T) {
	s := newGuestStore(nil)
	layupID := domain.NewLayupID(domain.NewRandomIDs())
	session := newTestGuestSession(t, s, layupID, "Robin")

	forged := session.Token[:len(session.Token)-1] + "x"
	if forged == session.Token {
		t.Fatal("test setup produced the same token; fix the fixture")
	}
	if _, ok := s.resolve(forged); ok {
		t.Fatal("a forged token must not resolve")
	}
	if _, ok := s.resolve("not-a-real-token-at-all"); ok {
		t.Fatal("an unrelated token must not resolve")
	}
	if _, ok := s.resolve(""); ok {
		t.Fatal("an empty token must not resolve")
	}
}

func TestEndingALayupInvalidatesItsGuestSessionsAndLeavesOthersAlone(t *testing.T) {
	s := newGuestStore(nil)
	ended := domain.NewLayupID(domain.NewRandomIDs())
	other := domain.NewLayupID(domain.NewRandomIDs())

	inEnded := newTestGuestSession(t, s, ended, "Robin")
	alsoInEnded := newTestGuestSession(t, s, ended, "Sam")
	inOther := newTestGuestSession(t, s, other, "Alex")

	s.endLayup(ended)

	if _, ok := s.resolve(inEnded.Token); ok {
		t.Fatal("a session in the ended layup must no longer resolve")
	}
	if _, ok := s.resolve(alsoInEnded.Token); ok {
		t.Fatal("every session in the ended layup must no longer resolve")
	}
	if _, ok := s.resolve(inOther.Token); !ok {
		t.Fatal("a session in a different layup must be untouched")
	}
	if name, ok := s.displayName(inOther.UserID); !ok || name != "Alex" {
		t.Fatalf("the untouched session's name should still answer, got %q, %v", name, ok)
	}
	if _, ok := s.displayName(inEnded.UserID); ok {
		t.Fatal("the ended session's guest id should no longer answer a name")
	}
}

func TestTwoGuestSessionsNeverShareATokenOrAUserID(t *testing.T) {
	s := newGuestStore(nil)
	layupID := domain.NewLayupID(domain.NewRandomIDs())

	first := newTestGuestSession(t, s, layupID, "Robin")
	second := newTestGuestSession(t, s, layupID, "Sam")

	if first.Token == second.Token {
		t.Fatal("two sessions must not share a token")
	}
	if first.UserID == second.UserID {
		t.Fatal("two sessions must not share a user id")
	}
}

func TestDisplayNameAnswersForAKnownGuestAndNotForAStranger(t *testing.T) {
	s := newGuestStore(nil)
	layupID := domain.NewLayupID(domain.NewRandomIDs())
	session := newTestGuestSession(t, s, layupID, "Robin")

	name, ok := s.displayName(session.UserID)
	if !ok || name != "Robin" {
		t.Fatalf("expected (%q, true), got (%q, %v)", "Robin", name, ok)
	}

	stranger := domain.NewUserID(domain.NewRandomIDs())
	if _, ok := s.displayName(stranger); ok {
		t.Fatal("a stranger's user id must not answer a display name")
	}
}

func TestNewGuestStoreDefaultsItsClock(t *testing.T) {
	// newLinkStore (links.go) falls back to time.Now when handed nil; the
	// guest store constructor takes the same shape, so make sure it does not
	// panic or otherwise misbehave when given nil.
	s := newGuestStore(nil)
	if s.now == nil {
		t.Fatal("expected a default clock, got nil")
	}
	if s.now().Before(time.Unix(0, 0)) {
		t.Fatal("default clock should report a sane time")
	}
}
