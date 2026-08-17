package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
)

// Realtime message type carrying the state of a layup to its participants.
const TypeLayupState = "layup.state"

// ParticipantDTO is one membership as seen on the wire.
type ParticipantDTO struct {
	MembershipID string     `json:"membershipId"`
	UserID       string     `json:"userId"`
	DisplayName  string     `json:"displayName"`
	JoinedAt     time.Time  `json:"joinedAt"`
	LeftAt       *time.Time `json:"leftAt,omitempty"`
	// IsCreatorMembership is true only while this membership still holds
	// creator authority. After the creator leaves it is false for everyone.
	IsCreatorMembership bool `json:"isCreatorMembership"`
}

// LayupDTO is the wire shape of a layup and its participants.
type LayupDTO struct {
	ID             string     `json:"id"`
	OrganisationID string     `json:"organisationId"`
	Title          string     `json:"title,omitempty"`
	Visibility     string     `json:"visibility"`
	Active         bool       `json:"active"`
	CreatedAt      time.Time  `json:"createdAt"`
	EndedAt        *time.Time `json:"endedAt,omitempty"`
	// HasCreatorAuthority is false once the creator membership has left. It
	// never becomes true again (SPEC.md §2.2).
	HasCreatorAuthority bool             `json:"hasCreatorAuthority"`
	CreatorMembershipID string           `json:"creatorMembershipId,omitempty"`
	Participants        []ParticipantDTO `json:"participants"`
	// ActiveShare is absent when nobody is sharing, which is a normal state.
	ActiveShare *ScreenShareDTO `json:"activeShare,omitempty"`
}

// MembershipResultDTO is returned by create/join: the layup plus which
// membership *you* now are, and how media should start.
type MembershipResultDTO struct {
	Layup            LayupDTO `json:"layup"`
	YourMembershipID string   `json:"yourMembershipId"`
	// Media is the join policy for *this* join: camera/microphone defaults for
	// the participant count that resulted (SPEC.md §4).
	Media domain.JoinMediaDefaults `json:"media"`
}

// CurrentLayupDTO answers "which layup am I in?", with no layup being a
// perfectly ordinary answer.
type CurrentLayupDTO struct {
	Layup            *LayupDTO `json:"layup,omitempty"`
	YourMembershipID string    `json:"yourMembershipId,omitempty"`
}

type createLayupRequest struct {
	Title      string `json:"title"`
	Visibility string `json:"visibility"`
}

func (s *Server) handleCreateLayup(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}

	var body createLayupRequest
	if err := decodeJSON(r, &body); err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	visibility := domain.Visibility(body.Visibility)
	if body.Visibility == "" {
		visibility = domain.VisibilityPrivate
	}

	policy := s.directory.Organisation().Policy
	if visibility == domain.VisibilityOrganisation && !policy.OrganisationOpenAllowed {
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden", "organisation-open layups are not permitted here")
		return
	}
	if visibility == domain.VisibilityLink && !policy.LinkLayupsAllowed {
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden", "link layups are not permitted here")
		return
	}

	view, err := s.layups.CreateLayup(r.Context(), domain.CreateLayupInput{
		OrganisationID: identity.OrganisationID(),
		CreatorUserID:  identity.User.ID,
		Title:          body.Title,
		Visibility:     visibility,
		DrawingDefault: policy.DrawingDefault,
		ControlDefault: policy.RemoteControlDefault,
	})
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	s.afterLayupChange(r.Context(), view, identity.User)
	s.writeEnvelope(w, r, "layup.created", MembershipResultDTO{
		Layup:            s.layupDTO(view),
		YourMembershipID: string(membershipOf(view, identity.User.ID)),
		Media:            s.joinMedia(view),
	})
}

func (s *Server) handleJoinLayup(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}
	layupID := domain.LayupID(r.PathValue("id"))
	if err := layupID.Validate(); err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	existing, err := s.layups.View(r.Context(), layupID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	if err := s.mayEnter(existing, identity); err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	view, membership, err := s.layups.Join(r.Context(), layupID, identity.User.ID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	s.afterLayupChange(r.Context(), view, identity.User)
	s.writeEnvelope(w, r, "layup.joined", MembershipResultDTO{
		Layup:            s.layupDTO(view),
		YourMembershipID: string(membership.ID),
		Media:            s.joinMedia(view),
	})
}

func (s *Server) handleLeaveLayup(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}
	layupID := domain.LayupID(r.PathValue("id"))
	if err := layupID.Validate(); err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	view, err := s.layups.View(r.Context(), layupID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	// You may only end your own membership. There is no moderator who can
	// remove someone else (SPEC.md §2.2).
	membershipID := membershipOf(view, identity.User.ID)
	if membershipID == "" {
		s.writeAPIError(w, r, http.StatusConflict, "conflict", "you are not in this layup")
		return
	}

	after, err := s.layups.Leave(r.Context(), membershipID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	s.afterLayupChange(r.Context(), after, identity.User)
	s.writeEnvelope(w, r, "layup.left", MembershipResultDTO{
		Layup:            s.layupDTO(after),
		YourMembershipID: string(membershipID),
	})

	// Media stops when the membership does; nothing to hand back.
}

// handleCurrentLayup answers "which layup am I in?".
//
// A desktop asks this the moment it starts. Without it, restarting the
// application looks to the person like being thrown out of the room they are
// standing in, and the obvious recovery - creating another layup - leaves two
// of them with their colleagues scattered between.
func (s *Server) handleCurrentLayup(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}

	view, membership, err := s.layups.CurrentLayupForUser(r.Context(), identity.User.ID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	if view == nil || membership == nil {
		// Being in no layup is an ordinary state, not an error, and the
		// difference must be unmistakable to the client: an absent layup, not
		// an empty-looking one.
		s.writeEnvelope(w, r, "layup.current", CurrentLayupDTO{})
		return
	}

	dto := s.layupDTO(*view)
	s.writeEnvelope(w, r, "layup.current", CurrentLayupDTO{
		Layup:            &dto,
		YourMembershipID: string(membership.ID),
	})
}

func (s *Server) handleGetLayup(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}
	layupID := domain.LayupID(r.PathValue("id"))
	if err := layupID.Validate(); err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	view, err := s.layups.View(r.Context(), layupID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	if err := s.mayObserve(view, identity); err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	s.writeEnvelope(w, r, TypeLayupState, s.layupDTO(view))
}

// mayEnter decides whether an identity may join a layup.
//
// PLAN-1 rules: your own organisation only; ORGANISATION layups are open to
// members; PRIVATE and LINK layups need an invitation, which Phase C adds. A
// participant rejoining their own active layup is always allowed.
func (s *Server) mayEnter(view domain.LayupView, identity Identity) error {
	if view.Layup.OrganisationID != identity.OrganisationID() {
		return domain.ErrNotFound
	}
	if !view.Active() {
		return domain.ErrConflict
	}
	if view.Layup.Visibility.Open() {
		return nil
	}
	for _, participant := range view.Participants {
		if participant.UserID == identity.User.ID {
			return nil
		}
	}
	return domain.ErrForbidden
}

// mayObserve decides whether an identity may read a layup's detail.
func (s *Server) mayObserve(view domain.LayupView, identity Identity) error {
	if view.Layup.OrganisationID != identity.OrganisationID() {
		return domain.ErrNotFound
	}
	if view.Layup.Visibility.Open() {
		return nil
	}
	for _, participant := range view.Participants {
		if participant.UserID == identity.User.ID {
			return nil
		}
	}
	// Outsiders are not told a private layup exists in any detail.
	return domain.ErrNotFound
}

// afterLayupChange republishes everything a membership change affects: the
// layup state to its participants, and presence/activity to the organisation.
func (s *Server) afterLayupChange(ctx context.Context, view domain.LayupView, actor domain.User) {
	env, err := protocol.NewEnvelope(TypeLayupState, s.layupDTO(view))
	if err == nil {
		recipients := make([]domain.UserID, 0, len(view.Participants))
		for _, participant := range view.Participants {
			recipients = append(recipients, participant.UserID)
		}
		// Everyone who was in the layup - including whoever just left - needs
		// the new state.
		s.hub.SendToUsers(recipients, env)
	}

	// Activity presence changed for every participant, not only the actor.
	seen := map[domain.UserID]bool{actor.ID: true}
	s.feed.PublishUserByID(ctx, actor.ID)
	for _, participant := range view.Participants {
		if seen[participant.UserID] {
			continue
		}
		seen[participant.UserID] = true
		s.feed.PublishUserByID(ctx, participant.UserID)
	}
}

func (s *Server) layupDTO(view domain.LayupView) LayupDTO {
	participants := make([]ParticipantDTO, 0, len(view.Participants))
	for _, participant := range view.Participants {
		name := ""
		if user, err := s.directory.UserByID(participant.UserID); err == nil {
			name = user.DisplayName
		}
		participants = append(participants, ParticipantDTO{
			MembershipID:        string(participant.MembershipID),
			UserID:              string(participant.UserID),
			DisplayName:         name,
			JoinedAt:            participant.JoinedAt,
			LeftAt:              participant.LeftAt,
			IsCreatorMembership: participant.IsCreatorMembership,
		})
	}
	dto := LayupDTO{
		ID:                  string(view.Layup.ID),
		OrganisationID:      string(view.Layup.OrganisationID),
		Title:               view.Layup.Title,
		Visibility:          string(view.Layup.Visibility),
		Active:              view.Active(),
		CreatedAt:           view.Layup.CreatedAt,
		EndedAt:             view.Layup.EndedAt,
		HasCreatorAuthority: view.HasCreatorAuthority,
		Participants:        participants,
	}
	if id, ok := domain.CreatorMembership(view.Layup); ok {
		dto.CreatorMembershipID = string(id)
	}
	if share, err := s.layups.ActiveScreenShare(context.Background(), view.Layup.ID); err == nil {
		dto.ActiveShare = s.shareDTO(share)
	}
	return dto
}

// joinMedia applies the organisation policy to the resulting participant count.
// Personal preference is a PLAN-2 setting; the default follows policy.
func (s *Server) joinMedia(view domain.LayupView) domain.JoinMediaDefaults {
	return domain.JoinDefaults(
		s.directory.Organisation().Policy,
		domain.DefaultMediaPreference(),
		len(view.ActiveParticipants()),
	)
}

func (s *Server) writeDomainError(w http.ResponseWriter, r *http.Request, err error) {
	status, code := statusForDomainError(err)
	s.writeAPIError(w, r, status, code, err.Error())
}

// membershipOf returns the caller's active membership in a layup, if any.
func membershipOf(view domain.LayupView, user domain.UserID) domain.MembershipID {
	for _, participant := range view.ActiveParticipants() {
		if participant.UserID == user {
			return participant.MembershipID
		}
	}
	return ""
}

// decodeJSON reads a small JSON body, rejecting unknown fields.
func decodeJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil && err != io.EOF {
		return err
	}
	return nil
}

// OpenLayupDTO is one discoverable layup on the Happening Now surface.
//
// Only ORGANISATION layups appear here. A private layup is never listed, and
// its title and participants are never rendered for an outsider (SPEC.md §5.3).
type OpenLayupDTO struct {
	ID               string   `json:"id"`
	Title            string   `json:"title,omitempty"`
	ParticipantCount int      `json:"participantCount"`
	Participants     []string `json:"participants"`
	// PresenterName is empty while nobody is sharing a screen. Screen sharing
	// arrives in Phase D; the field exists so the surface does not change shape.
	PresenterName string `json:"presenterName,omitempty"`
	CanJoin       bool   `json:"canJoin"`
	// YouAreInIt is true when the viewer is already a participant.
	YouAreInIt bool `json:"youAreInIt"`
}

// OpenLayupsDTO is the payload of GET /api/layups.
type OpenLayupsDTO struct {
	Layups []OpenLayupDTO `json:"layups"`
}

func (s *Server) handleListOpenLayups(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}

	layups, err := s.layups.OpenLayups(r.Context(), identity.OrganisationID())
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	out := make([]OpenLayupDTO, 0, len(layups))
	for _, view := range layups {
		participants := make([]string, 0, len(view.Participants))
		inside := false
		for _, participant := range view.ActiveParticipants() {
			if user, err := s.directory.UserByID(participant.UserID); err == nil {
				participants = append(participants, user.DisplayName)
			}
			if participant.UserID == identity.User.ID {
				inside = true
			}
		}
		presenterName := ""
		if share, err := s.layups.ActiveScreenShare(r.Context(), view.Layup.ID); err == nil && share != nil {
			if dto := s.shareDTO(share); dto != nil {
				presenterName = dto.PresenterName
			}
		}
		out = append(out, OpenLayupDTO{
			ID:               string(view.Layup.ID),
			PresenterName:    presenterName,
			Title:            view.Layup.Title,
			ParticipantCount: len(view.ActiveParticipants()),
			Participants:     participants,
			CanJoin:          !inside,
			YouAreInIt:       inside,
		})
	}
	s.writeEnvelope(w, r, "layup.open", OpenLayupsDTO{Layups: out})
}
