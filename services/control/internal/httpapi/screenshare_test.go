package httpapi

import (
	"net/http"
	"testing"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

func startShare(t *testing.T, s *Server, devUser, layupID, sourceID string) (*ScreenShareDTO, int) {
	t.Helper()
	rec := call(t, s, http.MethodPost, "/api/layups/"+layupID+"/share", devUser,
		map[string]string{"sourceId": sourceID})
	if rec.Code != http.StatusOK {
		return nil, rec.Code
	}
	dto := payloadOf[ScreenShareDTO](t, rec)
	return &dto, rec.Code
}

func TestSharingIsVisibleToEveryoneInTheLayup(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}

	share, code := startShare(t, s, "nick", created.Layup.ID, "screen:1:0")
	if code != http.StatusOK {
		t.Fatalf("start share: %d", code)
	}
	if share.PresenterMembershipID != created.YourMembershipID || share.PresenterName != "Nick" {
		t.Fatalf("unexpected share: %+v", share)
	}

	// Everyone in the layup sees who is presenting.
	state := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+created.Layup.ID, "karl", nil))
	if state.ActiveShare == nil || state.ActiveShare.PresenterName != "Nick" {
		t.Fatalf("the layup state must name the presenter: %+v", state.ActiveShare)
	}

	// And Happening Now names them too.
	listing := openLayups(t, s, "emelia")
	if listing.Layups[0].PresenterName != "Nick" {
		t.Fatalf("Happening Now should name the presenter: %+v", listing.Layups[0])
	}
}

func TestTakeoverNotifiesThePreviousPresenter(t *testing.T) {
	srv, api := realtimeServer(t)
	nick := dial(t, srv, "v=1&devUser=nick")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)

	// Karl creates it, so Karl's membership holds creator authority and may
	// take the screen back in an advertised layup; Nick joins and shares first.
	created := createLayup(t, api, "karl", "Pairing", "ORGANISATION")
	if code := call(t, api, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("nick join: %d", code)
	}
	if _, code := startShare(t, api, "nick", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("nick share: %d", code)
	}

	// Karl takes over: no approval dialog, but Nick is told at once.
	if _, code := startShare(t, api, "karl", created.Layup.ID, "screen:2:0"); code != http.StatusOK {
		t.Fatalf("karl takeover: %d", code)
	}

	notice := awaitType(t, nick, TypeScreenTakeover)
	var payload struct {
		LayupID     string `json:"layupId"`
		TakenByName string `json:"takenByName"`
	}
	if err := protocol.DecodePayload(notice, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.LayupID != created.Layup.ID || payload.TakenByName != "Karl" {
		t.Fatalf("unexpected takeover notice: %+v", payload)
	}

	state := payloadOf[LayupDTO](t, call(t, api, http.MethodGet, "/api/layups/"+created.Layup.ID, "nick", nil))
	if state.ActiveShare == nil || state.ActiveShare.PresenterName != "Karl" {
		t.Fatalf("exactly one presenter, and it is Karl: %+v", state.ActiveShare)
	}
}

func TestStoppingAShareKeepsTheLayupAlive(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	if _, code := startShare(t, s, "nick", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("share: %d", code)
	}

	rec := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/share/stop", "nick", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("stop: %d (%s)", rec.Code, rec.Body.String())
	}
	after := payloadOf[LayupDTO](t, rec)
	if !after.Active || after.ActiveShare != nil {
		t.Fatalf("the layup continues with nobody presenting: %+v", after)
	}
	if len(after.Participants) != 2 {
		t.Fatalf("participants are untouched by a share ending: %d", len(after.Participants))
	}
}

func TestShareControlIsNotModeration(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	if _, code := startShare(t, s, "nick", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("share: %d", code)
	}

	// Karl cannot stop Nick's share - only the presenter may.
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/share/stop", "karl", nil).Code; code != http.StatusForbidden {
		t.Fatalf("expected 403 stopping someone else's share, got %d", code)
	}
	// An outsider cannot start one either.
	if _, code := startShare(t, s, "emelia", created.Layup.ID, "screen:1:0"); code != http.StatusConflict {
		t.Fatalf("expected 409 for someone not in the layup, got %d", code)
	}
}
