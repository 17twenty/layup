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

	// Two links for the same layup differ, so one leaked link can be replaced.
	other, _ := mintLink(t, s, "nick", created.Layup.ID)
	if other.Token == link.Token {
		t.Fatal("each link should be distinct")
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
