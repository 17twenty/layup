package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/layup-app/layup/services/control/internal/domain"
)

// AcceptResultDTO is returned when a request is accepted: the request itself
// plus the layup the accepter is now in.
type AcceptResultDTO struct {
	Request RequestDTO `json:"request"`
	Layup   LayupDTO   `json:"layup"`
	// YourMembershipID is the accepter's membership in that layup.
	YourMembershipID string `json:"yourMembershipId"`
	// Media is how camera and microphone should start for this join.
	Media domain.JoinMediaDefaults `json:"media"`
}

func (s *Server) handleAcceptRequest(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}
	request, err := s.requests.Get(domain.JoinRequestID(r.PathValue("id")))
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	if err := s.mayResolve(r.Context(), request, identity, true); err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	view, membershipID, err := s.applyAcceptance(w, r, request, identity)
	if err != nil {
		return // applyAcceptance has already answered.
	}

	accepted, err := s.requests.MarkAccepted(r.Context(), request.ID, view.Layup.ID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	s.afterLayupChange(r.Context(), view, identity.User)
	s.publishResolution(r.Context(), accepted)

	s.writeEnvelope(w, r, "request.accepted", AcceptResultDTO{
		Request:          s.requestDTOFor(r.Context(), accepted, identity.User.ID),
		Layup:            s.layupDTO(view),
		YourMembershipID: string(membershipID),
		Media:            s.joinMedia(view),
	})
}

// applyAcceptance performs the domain effect of accepting a request. It writes
// an error response and returns an error if the effect cannot be applied.
func (s *Server) applyAcceptance(
	w http.ResponseWriter,
	r *http.Request,
	request domain.JoinRequest,
	identity Identity,
) (domain.LayupView, domain.MembershipID, error) {
	policy := s.directory.Organisation().Policy

	// "Join theirs" while already in a layup: leave the current one first, in
	// that order, so the two layups never briefly merge. There is deliberately
	// no room-graph merge in Layup (SPEC.md §6.4).
	if request.Type != domain.RequestKnock {
		if err := s.leaveOtherLayups(r.Context(), identity.User, request.LayupID); err != nil {
			s.writeDomainError(w, r, err)
			return domain.LayupView{}, "", err
		}
	}

	switch request.Type {
	case domain.RequestInviteToNewLayup:
		// One layup and both memberships appear together (SPEC.md §6.1).
		view, err := s.layups.CreateLayupWithGuests(r.Context(), domain.CreateLayupInput{
			OrganisationID: identity.OrganisationID(),
			// The inviter created the layup, so their membership is the
			// creator membership.
			CreatorUserID:  request.FromUserID,
			Title:          request.Note,
			Visibility:     domain.VisibilityPrivate,
			DrawingDefault: policy.DrawingDefault,
			ControlDefault: policy.RemoteControlDefault,
		}, identity.User.ID)
		if err != nil {
			s.writeDomainError(w, r, err)
			return domain.LayupView{}, "", err
		}
		return view, membershipOf(view, identity.User.ID), nil

	case domain.RequestInviteToLayup:
		view, _, err := s.layups.Join(r.Context(), request.LayupID, identity.User.ID)
		if err != nil {
			s.writeDomainError(w, r, err)
			return domain.LayupView{}, "", err
		}
		return view, membershipOf(view, identity.User.ID), nil

	case domain.RequestKnock:
		// One acceptance admits the knocker exactly once: Join is idempotent
		// for a user already present, so a second admitter changes nothing.
		view, _, err := s.layups.Join(r.Context(), request.LayupID, request.FromUserID)
		if err != nil {
			s.writeDomainError(w, r, err)
			return domain.LayupView{}, "", err
		}
		return view, membershipOf(view, request.FromUserID), nil

	default:
		err := errors.New("unsupported request type")
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return domain.LayupView{}, "", err
	}
}

// leaveOtherLayups ends the user's memberships in every active layup except
// `keep`. Each departure publishes its own state, so the people left behind see
// them go before the new layup appears.
func (s *Server) leaveOtherLayups(ctx context.Context, user domain.User, keep domain.LayupID) error {
	views, err := s.layups.ActiveLayupsForUser(ctx, user.ID)
	if err != nil {
		return err
	}
	for _, view := range views {
		if view.Layup.ID == keep {
			continue
		}
		membershipID := membershipOf(view, user.ID)
		if membershipID == "" {
			continue
		}
		after, err := s.layups.Leave(ctx, membershipID)
		if err != nil {
			return err
		}
		s.log.InfoContext(ctx, "left a layup to join another",
			"leftLayupId", string(view.Layup.ID), "userId", string(user.ID))
		s.afterLayupChange(ctx, after, user)
	}
	return nil
}

func (s *Server) handleDeclineRequest(w http.ResponseWriter, r *http.Request) {
	s.resolveRequest(w, r, domain.RequestDeclined)
}

func (s *Server) handleCancelRequest(w http.ResponseWriter, r *http.Request) {
	s.resolveRequest(w, r, domain.RequestCancelled)
}

func (s *Server) resolveRequest(w http.ResponseWriter, r *http.Request, state domain.RequestState) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}
	request, err := s.requests.Get(domain.JoinRequestID(r.PathValue("id")))
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	// Declining is for a recipient; cancelling is for the sender.
	if err := s.mayResolve(r.Context(), request, identity, state == domain.RequestDeclined); err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	resolved, err := s.requests.Resolve(r.Context(), request.ID, state)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	s.publishResolution(r.Context(), resolved)
	s.writeEnvelope(w, r, "request.resolved", s.requestDTOFor(r.Context(), resolved, identity.User.ID))
}

// mayResolve decides whether an identity may accept/decline (asRecipient) or
// cancel (as the sender) a request.
func (s *Server) mayResolve(ctx context.Context, request domain.JoinRequest, identity Identity, asRecipient bool) error {
	if !asRecipient {
		if request.FromUserID != identity.User.ID {
			return domain.ErrForbidden
		}
		return nil
	}

	if request.ToUserID != "" {
		if request.ToUserID != identity.User.ID {
			return domain.ErrForbidden
		}
		return nil
	}

	// A knock: any active participant of the target layup may admit or refuse.
	view, err := s.layups.View(ctx, request.LayupID)
	if err != nil {
		return err
	}
	for _, participant := range view.ActiveParticipants() {
		if participant.UserID == identity.User.ID {
			return nil
		}
	}
	return domain.ErrForbidden
}
