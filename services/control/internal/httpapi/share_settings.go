package httpapi

import (
	"net/http"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
)

// TypeScreenSettings tells every participant that the presenter's safety
// switches changed. It is pushed rather than polled, so "drawing off" takes
// effect on the other machines immediately (SPEC.md §7.3).
const TypeScreenSettings = "screen.settings"

type shareSettingsBody struct {
	AllowDrawing  *bool `json:"allowDrawing"`
	AllowPointer  *bool `json:"allowPointer"`
	AllowKeyboard *bool `json:"allowKeyboard"`
}

func (s *Server) handleShareSettings(w http.ResponseWriter, r *http.Request) {
	identity, layupID, view, ok := s.shareContext(w, r)
	if !ok {
		return
	}
	membershipID := membershipOf(view, identity.User.ID)
	if membershipID == "" {
		s.writeAPIError(w, r, http.StatusConflict, "conflict", "you are not in this layup")
		return
	}

	var body shareSettingsBody
	if err := decodeJSON(r, &body); err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	share, err := s.layups.UpdateShareSettings(r.Context(), layupID, membershipID, domain.ShareSettings{
		AllowDrawing:  body.AllowDrawing,
		AllowPointer:  body.AllowPointer,
		AllowKeyboard: body.AllowKeyboard,
	})
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	dto := s.shareDTO(&share)
	if env, err := protocol.NewEnvelope(TypeScreenSettings, dto); err == nil {
		recipients := make([]domain.UserID, 0, len(view.Participants))
		for _, participant := range view.ActiveParticipants() {
			recipients = append(recipients, participant.UserID)
		}
		s.hub.SendToUsers(recipients, env)
	}

	s.writeEnvelope(w, r, TypeScreenSettings, dto)
}

// handleDrawingCheck answers "may this membership draw right now?".
//
// The desktop enforces the same rule locally, but the authority is here: a
// client that ignores the toggle - or has not received it yet - is rejected
// rather than merely hidden (SPEC.md §7.3).
func (s *Server) handleDrawingCheck(w http.ResponseWriter, r *http.Request) {
	identity, layupID, view, ok := s.shareContext(w, r)
	if !ok {
		return
	}
	membershipID := membershipOf(view, identity.User.ID)
	allowed, err := s.layups.MayDraw(r.Context(), layupID, membershipID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	if !allowed {
		s.writeAPIError(w, r, http.StatusForbidden, "drawing_disabled",
			"the presenter has drawing switched off for this screen")
		return
	}
	s.writeEnvelope(w, r, "screen.drawing", map[string]bool{"allowed": true})
}
