package httpapi

import (
	"net/http"
	"strings"
	"testing"
)

func mintLink(t *testing.T, s *Server, devUser, layupID string) (LinkDTO, int) {
	t.Helper()
	rec := call(t, s, http.MethodPost, "/api/layups/"+layupID+"/link", devUser, nil)
	if rec.Code != http.StatusOK {
		return LinkDTO{}, rec.Code
	}
	return payloadOf[LinkDTO](t, rec), rec.Code
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

	rec := call(t, s, http.MethodPost, "/api/links/"+link.Token+"/join", "karl", nil)
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

	rec := call(t, s, http.MethodPost, "/api/links/not-a-real-token/join", "karl", nil)
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
	ended := call(t, s, http.MethodPost, "/api/links/"+link.Token+"/join", "karl", nil)
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
