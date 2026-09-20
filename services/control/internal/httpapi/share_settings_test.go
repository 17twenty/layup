package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
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

// TestAGuestCanNeverBeNamedInAControlGrant is the second, independent
// refusal - input-guard.ts is the client-side one. The allow-list
// (guest_auth.go) already keeps a guest from reaching this route at all in
// production, so this test bypasses it deliberately and calls the handler
// directly, the same way seatAGuest bypasses the join route: a single point
// of failure for "can a stranger drive my Mac" is not acceptable, so the
// handler itself must refuse, not merely rely on never being reached.
//
// The guest is seated as the *presenter* of their own share by talking to the
// domain layer directly - what "if guest screen sharing existed" would look
// like (SPEC.md's own "deliberately not done" list names it as a future
// possibility). Without this refusal, nothing else in this handler stops a
// guest presenter from switching remote mouse/keyboard control on.
func TestAGuestCanNeverBeNamedInAControlGrant(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Guest call", "LINK")
	session := seatAGuest(t, s, created.Layup.ID, "Sam")

	if _, err := s.layups.StartScreenShare(context.Background(), domain.StartShareInput{
		LayupID:               domain.LayupID(created.Layup.ID),
		PresenterMembershipID: session.MembershipID,
		SourceID:              "screen:1:0",
	}); err != nil {
		t.Fatalf("seat the guest as presenter: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/layups/"+created.Layup.ID+"/share/settings",
		strings.NewReader(`{"allowPointer": true, "allowKeyboard": true}`))
	req.SetPathValue("id", created.Layup.ID)
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(context.WithValue(req.Context(), identityContextKey{}, guestIdentity(session)))
	rec := httptest.NewRecorder()

	s.handleShareSettings(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("a guest must never be granted control, even naming themselves as the presenter: got %d (%s)",
			rec.Code, rec.Body.String())
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
