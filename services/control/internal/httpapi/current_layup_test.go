package httpapi

import (
	"net/http"
	"testing"
)

func currentLayup(t *testing.T, s *Server, devUser string) CurrentLayupDTO {
	t.Helper()
	rec := call(t, s, http.MethodGet, "/api/layups/current", devUser, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("current layup: %d (%s)", rec.Code, rec.Body.String())
	}
	return payloadOf[CurrentLayupDTO](t, rec)
}

func TestADesktopCanFindTheLayupItIsAlreadyIn(t *testing.T) {
	s := testServer(t)

	// A fresh desktop is in no layup, and that is not an error.
	if current := currentLayup(t, s, "nick"); current.Layup != nil {
		t.Fatalf("expected no layup, got %+v", current.Layup)
	}

	created := createLayup(t, s, "nick", "Pairing", "ORGANISATION")

	// Restarting must not look like being thrown out of the room you are in.
	current := currentLayup(t, s, "nick")
	if current.Layup == nil || current.Layup.ID != created.Layup.ID {
		t.Fatalf("expected the layup they are in, got %+v", current.Layup)
	}
	if current.YourMembershipID != created.YourMembershipID {
		t.Fatalf("expected their own membership %q, got %q", created.YourMembershipID, current.YourMembershipID)
	}

	// Somebody else's layup is not yours.
	if other := currentLayup(t, s, "karl"); other.Layup != nil {
		t.Fatalf("karl is in nothing, got %+v", other.Layup)
	}

	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/leave", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("leave: %d", code)
	}
	if after := currentLayup(t, s, "nick"); after.Layup != nil {
		t.Fatalf("expected nothing after leaving, got %+v", after.Layup)
	}
}

func TestJoiningAnotherLayupLeavesTheFirst(t *testing.T) {
	s := testServer(t)
	first := createLayup(t, s, "nick", "First", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+first.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}

	second := createLayup(t, s, "karl", "Second", "ORGANISATION")

	// Karl is in one place at a time.
	current := currentLayup(t, s, "karl")
	if current.Layup == nil || current.Layup.ID != second.Layup.ID {
		t.Fatalf("expected the second layup, got %+v", current.Layup)
	}

	// And Happening Now shows him in exactly one of them.
	rec := call(t, s, http.MethodGet, "/api/layups", "nick", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("open layups: %d", rec.Code)
	}
	open := payloadOf[struct {
		Layups []struct {
			ID           string   `json:"id"`
			Participants []string `json:"participants"`
		} `json:"layups"`
	}](t, rec)

	for _, layup := range open.Layups {
		karlIsHere := false
		for _, name := range layup.Participants {
			if name == "Karl" {
				karlIsHere = true
			}
		}
		if layup.ID == first.Layup.ID && karlIsHere {
			t.Fatal("Karl must not still be listed in the layup he left")
		}
		if layup.ID == second.Layup.ID && !karlIsHere {
			t.Fatal("Karl should be listed where he actually is")
		}
	}
}
