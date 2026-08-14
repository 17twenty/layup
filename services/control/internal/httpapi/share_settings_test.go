package httpapi

import (
	"net/http"
	"testing"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

func setDrawing(t *testing.T, s *Server, devUser, layupID string, allowed bool) int {
	t.Helper()
	return call(t, s, http.MethodPost, "/api/layups/"+layupID+"/share/settings", devUser,
		map[string]bool{"allowDrawing": allowed}).Code
}

func mayDraw(t *testing.T, s *Server, devUser, layupID string) int {
	t.Helper()
	return call(t, s, http.MethodGet, "/api/layups/"+layupID+"/share/drawing", devUser, nil).Code
}

func TestPresenterCanDisableDrawingImmediately(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	if _, code := startShare(t, s, "nick", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("share: %d", code)
	}

	// Drawing follows the organisation default (on) to begin with.
	if code := mayDraw(t, s, "karl", created.Layup.ID); code != http.StatusOK {
		t.Fatalf("expected drawing to be allowed initially, got %d", code)
	}

	if code := setDrawing(t, s, "nick", created.Layup.ID, false); code != http.StatusOK {
		t.Fatalf("disable drawing: %d", code)
	}

	// Rejected server-side, not merely hidden in Karl's UI.
	if code := mayDraw(t, s, "karl", created.Layup.ID); code != http.StatusForbidden {
		t.Fatalf("expected 403 once drawing is off, got %d", code)
	}

	// Re-enabling permits new strokes again.
	if code := setDrawing(t, s, "nick", created.Layup.ID, true); code != http.StatusOK {
		t.Fatalf("re-enable: %d", code)
	}
	if code := mayDraw(t, s, "karl", created.Layup.ID); code != http.StatusOK {
		t.Fatalf("expected drawing to be allowed again, got %d", code)
	}
}

func TestOnlyThePresenterControlsTheirOwnScreen(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing", "ORGANISATION")
	if code := call(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	if _, code := startShare(t, s, "nick", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("share: %d", code)
	}

	// These are safety rights over your own machine, not moderation rights:
	// a viewer cannot switch drawing off on someone else's screen.
	if code := setDrawing(t, s, "karl", created.Layup.ID, false); code != http.StatusForbidden {
		t.Fatalf("expected 403 for a non-presenter, got %d", code)
	}

	// The presenter may always annotate their own screen, even with drawing off.
	if code := setDrawing(t, s, "nick", created.Layup.ID, false); code != http.StatusOK {
		t.Fatalf("disable: %d", code)
	}
	if code := mayDraw(t, s, "nick", created.Layup.ID); code != http.StatusOK {
		t.Fatalf("the presenter may annotate their own screen, got %d", code)
	}
}

func TestDrawingToggleIsPushedToParticipants(t *testing.T) {
	srv, api := realtimeServer(t)
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	created := createLayup(t, api, "nick", "Pairing", "ORGANISATION")
	if code := call(t, api, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil).Code; code != http.StatusOK {
		t.Fatalf("join: %d", code)
	}
	if _, code := startShare(t, api, "nick", created.Layup.ID, "screen:1:0"); code != http.StatusOK {
		t.Fatalf("share: %d", code)
	}
	if code := setDrawing(t, api, "nick", created.Layup.ID, false); code != http.StatusOK {
		t.Fatalf("disable: %d", code)
	}

	notice := awaitType(t, karl, TypeScreenSettings)
	var dto ScreenShareDTO
	if err := protocol.DecodePayload(notice, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.AllowDrawing {
		t.Fatalf("participants must be told drawing is off: %+v", dto)
	}
}

func TestDrawingIsRefusedWhenNobodyIsSharing(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Pairing", "ORGANISATION")
	if code := mayDraw(t, s, "nick", created.Layup.ID); code != http.StatusForbidden {
		t.Fatalf("expected 403 with no active share, got %d", code)
	}
	if code := setDrawing(t, s, "nick", created.Layup.ID, true); code != http.StatusConflict {
		t.Fatalf("expected 409 changing settings with no share, got %d", code)
	}
}
