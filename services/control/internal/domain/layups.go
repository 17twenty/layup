package domain

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// Participant is one active or historical membership rendered for a caller.
type Participant struct {
	MembershipID MembershipID `json:"membershipId"`
	UserID       UserID       `json:"userId"`
	JoinedAt     time.Time    `json:"joinedAt"`
	LeftAt       *time.Time   `json:"leftAt,omitempty"`
	// IsCreatorMembership is true only while this membership still holds
	// creator privilege. It is false for every membership once the creator has
	// left - nobody inherits it.
	IsCreatorMembership bool `json:"isCreatorMembership"`
}

// LayupView is the read model of a layup and its participants.
type LayupView struct {
	Layup        Layup         `json:"-"`
	Participants []Participant `json:"participants"`
	// HasCreatorAuthority is false once creator privilege has devolved.
	HasCreatorAuthority bool `json:"hasCreatorAuthority"`
}

// Active reports whether the layup is still running.
func (v LayupView) Active() bool { return v.Layup.Active() }

// ActiveParticipants returns only memberships that have not left.
func (v LayupView) ActiveParticipants() []Participant {
	out := make([]Participant, 0, len(v.Participants))
	for _, p := range v.Participants {
		if p.LeftAt == nil {
			out = append(out, p)
		}
	}
	return out
}

// LayupService implements layup lifecycle: create, join, leave, and end when
// the final membership leaves. There is no owner requirement: a layup with no
// creator authority is a completely normal layup (SPEC.md §2.2).
type LayupService struct {
	repo Repository
	ids  IDGenerator
	now  func() time.Time
	log  *slog.Logger
}

// LayupServiceOptions configures a LayupService.
type LayupServiceOptions struct {
	IDs    IDGenerator
	Now    func() time.Time
	Logger *slog.Logger
}

// NewLayupService builds the service.
func NewLayupService(repo Repository, opts LayupServiceOptions) *LayupService {
	ids := opts.IDs
	if ids == nil {
		ids = NewRandomIDs()
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &LayupService{repo: repo, ids: ids, now: now, log: log}
}

// CreateLayupInput describes a new layup.
type CreateLayupInput struct {
	OrganisationID OrganisationID
	CreatorUserID  UserID
	Title          string
	Visibility     Visibility
	DrawingDefault bool
	ControlDefault bool
}

// CreateLayup creates a layup and the creator's membership atomically. The
// first membership activates the layup.
func (s *LayupService) CreateLayup(ctx context.Context, in CreateLayupInput) (LayupView, error) {
	if err := in.OrganisationID.Validate(); err != nil {
		return LayupView{}, err
	}
	if err := in.CreatorUserID.Validate(); err != nil {
		return LayupView{}, err
	}
	if in.Visibility == "" {
		in.Visibility = VisibilityPrivate
	}
	if !in.Visibility.Valid() {
		return LayupView{}, fmt.Errorf("%w: unknown visibility %q", ErrInvalid, in.Visibility)
	}

	now := s.now()
	membershipID := NewMembershipID(s.ids)
	layup := Layup{
		ID:                  NewLayupID(s.ids),
		OrganisationID:      in.OrganisationID,
		Title:               in.Title,
		Visibility:          in.Visibility,
		CreatedAt:           now,
		CreatorMembershipID: &membershipID,
		DrawingDefault:      in.DrawingDefault,
		ControlDefault:      in.ControlDefault,
	}
	if err := layup.Validate(); err != nil {
		return LayupView{}, err
	}

	membership := Membership{
		ID:                  membershipID,
		LayupID:             layup.ID,
		UserID:              in.CreatorUserID,
		JoinedAt:            now,
		IsCreatorMembership: true,
	}

	if err := s.repo.SaveLayup(layup); err != nil {
		return LayupView{}, err
	}
	if err := s.repo.SaveMembership(membership); err != nil {
		return LayupView{}, err
	}

	s.log.InfoContext(ctx, "layup created",
		"layupId", string(layup.ID),
		"organisationId", string(layup.OrganisationID),
		"visibility", string(layup.Visibility),
		"creatorMembershipId", string(membershipID),
	)
	return s.view(layup.ID)
}

// CreateLayupWithGuests creates a layup, the creator membership and one
// membership per guest in a single call.
//
// This is what accepting an invitation does: one layup and both memberships
// appear together, or nothing does (SPEC.md §6.1). If any part fails, the layup
// is ended immediately rather than left half-formed.
func (s *LayupService) CreateLayupWithGuests(
	ctx context.Context,
	in CreateLayupInput,
	guests ...UserID,
) (LayupView, error) {
	view, err := s.CreateLayup(ctx, in)
	if err != nil {
		return LayupView{}, err
	}

	for _, guest := range guests {
		if _, _, err := s.Join(ctx, view.Layup.ID, guest); err != nil {
			// Roll back: end the layup we just made so no half-formed layup
			// survives an invitation that could not complete.
			layup, getErr := s.repo.GetLayup(view.Layup.ID)
			if getErr == nil {
				ended := s.now()
				layup.EndedAt = &ended
				layup.CreatorMembershipID = nil
				_ = s.repo.SaveLayup(layup)
			}
			s.log.WarnContext(ctx, "invitation could not be completed; layup discarded",
				"layupId", string(view.Layup.ID), "guestUserId", string(guest), "error", err.Error())
			return LayupView{}, err
		}
	}
	return s.view(view.Layup.ID)
}

// Join adds a user to an active layup and returns the resulting view.
//
// Joining is idempotent for a user who is already present: the existing active
// membership is returned rather than creating a second incarnation.
func (s *LayupService) Join(ctx context.Context, layupID LayupID, userID UserID) (LayupView, Membership, error) {
	layup, err := s.repo.GetLayup(layupID)
	if err != nil {
		return LayupView{}, Membership{}, err
	}
	if err := userID.Validate(); err != nil {
		return LayupView{}, Membership{}, err
	}
	if !layup.Active() {
		return LayupView{}, Membership{}, fmt.Errorf("%w: layup %q has ended", ErrConflict, layupID)
	}

	existing, err := s.repo.MembershipsForLayup(layupID)
	if err != nil {
		return LayupView{}, Membership{}, err
	}
	for _, m := range existing {
		if m.UserID == userID && m.Active() {
			view, err := s.view(layupID)
			return view, m, err
		}
	}

	membership := Membership{
		ID:       NewMembershipID(s.ids),
		LayupID:  layupID,
		UserID:   userID,
		JoinedAt: s.now(),
		// A join is never a creator membership: only CreateLayup mints one, and
		// creator privilege is never granted to a later incarnation.
		IsCreatorMembership: false,
	}
	if err := s.repo.SaveMembership(membership); err != nil {
		return LayupView{}, Membership{}, err
	}

	s.log.InfoContext(ctx, "membership joined",
		"layupId", string(layupID),
		"membershipId", string(membership.ID),
		"userId", string(userID),
	)
	view, err := s.view(layupID)
	return view, membership, err
}

// Leave ends a membership.
//
// Two consequences are permanent:
//   - if this was the creator membership, creator privilege disappears forever;
//   - if it was the last active membership, the layup ends.
func (s *LayupService) Leave(ctx context.Context, membershipID MembershipID) (LayupView, error) {
	membership, err := s.repo.GetMembership(membershipID)
	if err != nil {
		return LayupView{}, err
	}
	layup, err := s.repo.GetLayup(membership.LayupID)
	if err != nil {
		return LayupView{}, err
	}

	if membership.Active() {
		now := s.now()
		membership.LeftAt = &now
		if err := s.repo.SaveMembership(membership); err != nil {
			return LayupView{}, err
		}

		if layup.IsCreatorMembership(membership.ID) {
			// Devolution: cleared, never reassigned, never restored.
			layup.CreatorMembershipID = nil
			s.log.InfoContext(ctx, "creator privilege devolved permanently",
				"layupId", string(layup.ID),
				"membershipId", string(membership.ID),
			)
		}

		remaining, err := s.activeMemberships(layup.ID)
		if err != nil {
			return LayupView{}, err
		}
		if len(remaining) == 0 {
			ended := now
			layup.EndedAt = &ended
			s.log.InfoContext(ctx, "layup ended", "layupId", string(layup.ID), "reason", "last membership left")
		}
		if err := s.repo.SaveLayup(layup); err != nil {
			return LayupView{}, err
		}

		s.log.InfoContext(ctx, "membership left",
			"layupId", string(layup.ID),
			"membershipId", string(membership.ID),
			"userId", string(membership.UserID),
			"remainingParticipants", len(remaining),
		)
	}

	return s.view(layup.ID)
}

// View returns the current read model of a layup.
func (s *LayupService) View(_ context.Context, layupID LayupID) (LayupView, error) {
	return s.view(layupID)
}

// ActiveLayupsForUser returns the layups a user is currently inside.
func (s *LayupService) ActiveLayupsForUser(_ context.Context, userID UserID) ([]LayupView, error) {
	memberships, err := s.repo.MembershipsForUser(userID)
	if err != nil {
		return nil, err
	}
	views := make([]LayupView, 0, len(memberships))
	for _, m := range memberships {
		if !m.Active() {
			continue
		}
		view, err := s.view(m.LayupID)
		if err != nil {
			return nil, err
		}
		if view.Active() {
			views = append(views, view)
		}
	}
	return views, nil
}

func (s *LayupService) activeMemberships(id LayupID) ([]Membership, error) {
	all, err := s.repo.MembershipsForLayup(id)
	if err != nil {
		return nil, err
	}
	out := make([]Membership, 0, len(all))
	for _, m := range all {
		if m.Active() {
			out = append(out, m)
		}
	}
	return out, nil
}

func (s *LayupService) view(id LayupID) (LayupView, error) {
	layup, err := s.repo.GetLayup(id)
	if err != nil {
		return LayupView{}, err
	}
	memberships, err := s.repo.MembershipsForLayup(id)
	if err != nil {
		return LayupView{}, err
	}
	participants := make([]Participant, 0, len(memberships))
	for _, m := range memberships {
		participants = append(participants, Participant{
			MembershipID: m.ID,
			UserID:       m.UserID,
			JoinedAt:     m.JoinedAt,
			LeftAt:       m.LeftAt,
			// Creator privilege is reported from the layup, not from the
			// membership flag, so a departed creator cannot look privileged.
			IsCreatorMembership: layup.IsCreatorMembership(m.ID),
		})
	}
	return LayupView{
		Layup:               layup,
		Participants:        participants,
		HasCreatorAuthority: layup.HasCreatorAuthority(),
	}, nil
}

// OpenLayups returns the active, organisation-visible layups of one
// organisation. Private and link layups are never discoverable this way
// (SPEC.md §5.3).
func (s *LayupService) OpenLayups(_ context.Context, org OrganisationID) ([]LayupView, error) {
	layups, err := s.repo.ListLayups(org)
	if err != nil {
		return nil, err
	}
	out := make([]LayupView, 0, len(layups))
	for _, layup := range layups {
		if !layup.Active() || !layup.Visibility.Open() {
			continue
		}
		view, err := s.view(layup.ID)
		if err != nil {
			return nil, err
		}
		if len(view.ActiveParticipants()) == 0 {
			continue
		}
		out = append(out, view)
	}
	return out, nil
}
