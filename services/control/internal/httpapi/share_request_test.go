package httpapi

import (
	"net/http"
	"testing"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

func askToShare(t *testing.T, s *Server, devUser, layupID string) int {
	t.Helper()
	return call(t, s, http.MethodPost, "/api/layups/"+layupID+"/share/request", devUser, nil).Code
}

func TestAdvertisedSessionsUseAskToShare(t *testing.T) {
	srv, api := realtimeServer(t)
	// The presenter is listening, because being asked is the whole point.
	nick := dial(t, srv, "v=1&devUser=nick")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)

	created := createLayup(t, api, "nick", "Advertised session", "ORGANISATION")
	if code := call(t, api, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	if _, code := startShare(t, api, "nick", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("share: %d", code)
	}

	// Karl cannot simply take an advertised session's screen mid-sentence.
	if _, code := startShare(t, api, "karl", created.Layup.ID, "screen:1:0"); code != http.StatusForbidden {
		t.Fatalf("expected 403 taking over an advertised session, got %d", code)
	}

	if code := askToShare(t, api, "karl", created.Layup.ID); code != http.StatusOK {
		t.Fatalf("asking should be allowed: %d", code)
	}

	notice := awaitType(t, nick, TypeScreenShareRequest)
	var payload map[string]string
	if err := protocol.DecodePayload(notice, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["askedByName"] == "" || payload["layupId"] != created.Layup.ID {
		t.Fatalf("the presenter needs to know who is asking: %+v", payload)
	}

	// Asking grants nothing until the presenter acts.
	if _, code := startShare(t, api, "karl", created.Layup.ID, "screen:1:0"); code != http.StatusForbidden {
		t.Fatalf("asking must not grant the screen, got %d", code)
	}

	// The presenter hands it over by stopping; then Karl simply shares.
	if code := call(t, api, http.MethodPost, "/api/layups/"+created.Layup.ID+"/share/stop", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("stop: %d", code)
	}
	if _, code := startShare(t, api, "karl", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("with nobody presenting anyone may share, got %d", code)
	}
}

func TestNobodyAsksWhereTakingIsAllowed(t *testing.T) {
	s := testServer(t)
	// A LINK layup is joined by invitation rather than advertised, so its
	// takeover rule is the collaborative one.
	created := createLayup(t, s, "nick", "Pairing", "LINK")
	link, code := mintLink(t, s, "nick", created.Layup.ID)
	if code != http.StatusOK {
		t.Fatalf("mint link: %d", code)
	}
	if code := call(t, s, http.MethodPost, "/api/links/"+link.Token+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	if _, code := startShare(t, s, "nick", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("share: %d", code)
	}

	// In a private layup Karl takes the screen; asking would be theatre.
	if code := askToShare(t, s, "karl", created.Layup.ID); code != http.StatusConflict {
		t.Fatalf("expected 409 where taking is allowed, got %d", code)
	}
	if _, code := startShare(t, s, "karl", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("a private takeover needs no approval, got %d", code)
	}
}

func TestAskingNeedsSomebodyToAsk(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Advertised", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}

	// Nobody is presenting: Karl can just share.
	if code := askToShare(t, s, "karl", created.Layup.ID); code != http.StatusConflict {
		t.Fatalf("expected 409 with nobody presenting, got %d", code)
	}
	// And somebody who is not in the layup cannot ask at all.
	if code := askToShare(t, s, "sam", created.Layup.ID); code == http.StatusOK {
		t.Fatal("an outsider must not be able to ask")
	}
}
