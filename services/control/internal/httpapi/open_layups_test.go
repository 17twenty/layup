package httpapi

import (
	"bytes"
	"net/http"
	"testing"
)

func openLayups(t *testing.T, s *Server, devUser string) OpenLayupsDTO {
	t.Helper()
	rec := call(t, s, http.MethodGet, "/api/layups", devUser, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list open layups: %d (%s)", rec.Code, rec.Body.String())
	}
	return payloadOf[OpenLayupsDTO](t, rec)
}

func TestHappeningNowShowsOrganisationOpenLayupsOnly(t *testing.T) {
	s := testServer(t)
	open := createLayup(t, s, "nick", "Debugging the capture path", "ORGANISATION")
	createLayup(t, s, "emelia", "Acquisition of Initech", "PRIVATE")

	rec := call(t, s, http.MethodGet, "/api/layups", "karl", nil)
	if bytes.Contains(rec.Body.Bytes(), []byte("Initech")) {
		t.Fatal("a private layup leaked into Happening Now")
	}

	listing := payloadOf[OpenLayupsDTO](t, rec)
	if len(listing.Layups) != 1 {
		t.Fatalf("expected exactly the open layup, got %d", len(listing.Layups))
	}
	entry := listing.Layups[0]
	if entry.ID != open.Layup.ID || entry.Title != "Debugging the capture path" {
		t.Fatalf("unexpected entry: %+v", entry)
	}
	if entry.ParticipantCount != 1 || len(entry.Participants) != 1 || entry.Participants[0] != "Nick" {
		t.Fatalf("participants should be visible for an open layup: %+v", entry)
	}
	if !entry.CanJoin || entry.YouAreInIt {
		t.Fatalf("an outsider in the organisation may join: %+v", entry)
	}
	if entry.PresenterName != "" {
		t.Fatalf("nobody is presenting yet: %+v", entry)
	}
}

func TestHappeningNowTracksMembershipAndEnding(t *testing.T) {
	s := testServer(t)
	open := createLayup(t, s, "nick", "Capture path", "ORGANISATION")

	// The creator is in it, so it is not offered as something to join.
	mine := openLayups(t, s, "nick")
	if len(mine.Layups) != 1 || !mine.Layups[0].YouAreInIt || mine.Layups[0].CanJoin {
		t.Fatalf("your own layup should be marked as yours: %+v", mine.Layups)
	}

	// Karl joins: the count grows for everyone.
	if code := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	after := openLayups(t, s, "emelia")
	if after.Layups[0].ParticipantCount != 2 {
		t.Fatalf("expected two participants, got %d", after.Layups[0].ParticipantCount)
	}

	// Everyone leaves: it disappears rather than lingering as an empty room.
	for _, who := range []string{"nick", "karl"} {
		if code := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/leave", who, nil).Code; code != http.StatusOK {
			t.Fatalf("%s leave: %d", who, code)
		}
	}
	if listing := openLayups(t, s, "emelia"); len(listing.Layups) != 0 {
		t.Fatalf("an ended layup must not be discoverable: %+v", listing.Layups)
	}
}

func TestOpenLayupCanBeJoinedWithoutAnInvitation(t *testing.T) {
	s := testServer(t)
	open := createLayup(t, s, "nick", "Capture path", "ORGANISATION")

	if code := call(t, s, http.MethodPost, "/api/layups/"+open.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("an organisation member may join an open layup, got %d", code)
	}
	state := payloadOf[LayupDTO](t, call(t, s, http.MethodGet, "/api/layups/"+open.Layup.ID, "karl", nil))
	if len(state.Participants) != 2 {
		t.Fatalf("expected two participants, got %d", len(state.Participants))
	}
}
