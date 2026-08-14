package httpapi

import (
	"net/http"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
)

// TypeScreenTakeover tells a presenter their screen was taken over. It is a
// notice, not a request: in a collaborative layup taking the screen needs no
// approval, and the previous presenter is simply told (SPEC.md §7.2).
const TypeScreenTakeover = "screen.takeover"

// TypeScreenShareRequest asks the presenter of an advertised session for the
// screen. It is the only place in screen sharing where anybody asks for
// anything: everywhere else you simply take it and the previous presenter is
// told (SPEC.md §7.2).
const TypeScreenShareRequest = "screen.share_request"

// ScreenShareDTO is the wire shape of the active shared desktop.
type ScreenShareDTO struct {
	ID                    string `json:"id"`
	PresenterMembershipID string `json:"presenterMembershipId"`
	PresenterName         string `json:"presenterName,omitempty"`
	// SourceID is only meaningful to the presenter's own machine; it is shared
	// so their other windows agree about what is being captured.
	SourceID      string `json:"sourceId,omitempty"`
	AllowDrawing  bool   `json:"allowDrawing"`
	AllowPointer  bool   `json:"allowPointer"`
	AllowKeyboard bool   `json:"allowKeyboard"`
}

type startShareBody struct {
	SourceID string `json:"sourceId"`
}

func (s *Server) handleStartShare(w http.ResponseWriter, r *http.Request) {
	identity, layupID, view, ok := s.shareContext(w, r)
	if !ok {
		return
	}

	var body startShareBody
	if err := decodeJSON(r, &body); err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	membershipID := membershipOf(view, identity.User.ID)
	if membershipID == "" {
		s.writeAPIError(w, r, http.StatusConflict, "conflict", "you are not in this layup")
		return
	}

	result, err := s.layups.StartScreenShare(r.Context(), domain.StartShareInput{
		LayupID:               layupID,
		PresenterMembershipID: membershipID,
		SourceID:              body.SourceID,
	})
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	// The replaced presenter finds out immediately, so their machine can stop
	// capturing rather than publishing into the void.
	if result.Replaced != nil {
		s.notifyTakeover(r, view, *result.Replaced, membershipID)
	}

	after, err := s.layups.View(r.Context(), layupID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	s.afterLayupChange(r.Context(), after, identity.User)
	s.writeEnvelope(w, r, "screen.started", s.shareDTO(&result.Share))
}

func (s *Server) handleStopShare(w http.ResponseWriter, r *http.Request) {
	identity, layupID, view, ok := s.shareContext(w, r)
	if !ok {
		return
	}
	membershipID := membershipOf(view, identity.User.ID)
	if membershipID == "" {
		s.writeAPIError(w, r, http.StatusConflict, "conflict", "you are not in this layup")
		return
	}

	if _, err := s.layups.StopScreenShare(r.Context(), layupID, membershipID); err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	after, err := s.layups.View(r.Context(), layupID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	s.afterLayupChange(r.Context(), after, identity.User)
	// The layup carries on as a valid audio/video space (SPEC.md §7.1).
	s.writeEnvelope(w, r, "screen.stopped", s.layupDTO(after))
}

func (s *Server) handleRequestShare(w http.ResponseWriter, r *http.Request) {
	identity, layupID, view, ok := s.shareContext(w, r)
	if !ok {
		return
	}
	membershipID := membershipOf(view, identity.User.ID)
	if membershipID == "" {
		s.writeAPIError(w, r, http.StatusConflict, "conflict", "you are not in this layup")
		return
	}

	request, err := s.layups.RequestScreenShare(r.Context(), layupID, membershipID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	// The presenter is asked, not overruled: nothing changes until they act.
	askedByName := ""
	var presenterUser domain.UserID
	for _, participant := range view.Participants {
		if participant.MembershipID == request.PresenterMembershipID {
			presenterUser = participant.UserID
		}
		if participant.MembershipID == membershipID {
			if user, err := s.directory.UserByID(participant.UserID); err == nil {
				askedByName = user.DisplayName
			}
		}
	}

	payload := map[string]string{
		"layupId":             string(layupID),
		"shareId":             string(request.Current.ID),
		"askedByMembershipId": string(membershipID),
		"askedByName":         askedByName,
	}
	if presenterUser != "" {
		if env, err := protocol.NewEnvelope(TypeScreenShareRequest, payload); err == nil {
			s.hub.SendToUser(presenterUser, env)
		}
	}
	s.writeEnvelope(w, r, TypeScreenShareRequest, payload)
}

// shareContext resolves and authorises the common part of both handlers.
func (s *Server) shareContext(w http.ResponseWriter, r *http.Request) (Identity, domain.LayupID, domain.LayupView, bool) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return Identity{}, "", domain.LayupView{}, false
	}
	layupID := domain.LayupID(r.PathValue("id"))
	if err := layupID.Validate(); err != nil {
		s.writeDomainError(w, r, err)
		return Identity{}, "", domain.LayupView{}, false
	}
	view, err := s.layups.View(r.Context(), layupID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return Identity{}, "", domain.LayupView{}, false
	}
	if err := s.mayObserve(view, identity); err != nil {
		s.writeDomainError(w, r, err)
		return Identity{}, "", domain.LayupView{}, false
	}
	return identity, layupID, view, true
}

func (s *Server) notifyTakeover(r *http.Request, view domain.LayupView, replaced domain.ScreenShare, by domain.MembershipID) {
	var previousUser domain.UserID
	takenByName := ""
	for _, participant := range view.Participants {
		if participant.MembershipID == replaced.PresenterMembershipID {
			previousUser = participant.UserID
		}
		if participant.MembershipID == by {
			if user, err := s.directory.UserByID(participant.UserID); err == nil {
				takenByName = user.DisplayName
			}
		}
	}
	if previousUser == "" {
		return
	}
	env, err := protocol.NewEnvelope(TypeScreenTakeover, map[string]string{
		"layupId":     string(view.Layup.ID),
		"shareId":     string(replaced.ID),
		"takenByName": takenByName,
	})
	if err == nil {
		s.hub.SendToUser(previousUser, env)
	}
	s.log.InfoContext(r.Context(), "notified previous presenter of takeover",
		"layupId", string(view.Layup.ID), "shareId", string(replaced.ID))
}

func (s *Server) shareDTO(share *domain.ScreenShare) *ScreenShareDTO {
	if share == nil {
		return nil
	}
	dto := &ScreenShareDTO{
		ID:                    string(share.ID),
		PresenterMembershipID: string(share.PresenterMembershipID),
		SourceID:              share.SourceID,
		AllowDrawing:          share.AllowDrawing,
		AllowPointer:          share.AllowPointer,
		AllowKeyboard:         share.AllowKeyboard,
	}
	if membership, err := s.layups.Membership(share.PresenterMembershipID); err == nil {
		if user, err := s.directory.UserByID(membership.UserID); err == nil {
			dto.PresenterName = user.DisplayName
		}
	}
	return dto
}
