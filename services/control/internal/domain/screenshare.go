package domain

import (
	"context"
	"fmt"
	"time"
)

// Exactly zero or one shared desktop exists per layup (ADR-0007, SPEC.md §7.1).
//
// The rule lives here rather than in the media layer: whether pixels are
// actually flowing is a WebRTC question, but *who is entitled to present* is a
// domain question, and it must hold even if a track is slow to start or a peer
// connection is still negotiating.

// ScreenShare is one shared-desktop session.
type ScreenShare struct {
	ID                    ScreenShareID
	LayupID               LayupID
	PresenterMembershipID MembershipID
	SourceID              string
	StartedAt             time.Time
	EndedAt               *time.Time

	// Presenter safety settings. The presenter is sovereign over their own
	// machine (ADR-0005); these are not moderation rights.
	AllowDrawing  bool
	AllowPointer  bool
	AllowKeyboard bool
}

// Active reports whether this share is still running.
func (s ScreenShare) Active() bool { return s.EndedAt == nil }

// StartShareInput describes a new share.
type StartShareInput struct {
	LayupID               LayupID
	PresenterMembershipID MembershipID
	SourceID              string
}

// TakeoverResult describes what starting a share did.
type TakeoverResult struct {
	Share ScreenShare
	// Replaced is the share that was stopped to make room, if any. The previous
	// presenter gets a brief notice rather than an approval dialog
	// (SPEC.md §7.2).
	Replaced *ScreenShare
}

// StartScreenShare makes a membership the active presenter of its layup.
//
// Takeover rules (SPEC.md §7.2):
//   - private/collaborative layups: any participant may take over directly;
//   - organisation-open layups: only the creator membership (while it exists)
//     or the current presenter may hand the screen over, so an advertised
//     session is not hijacked mid-sentence. With nobody presenting, anyone in
//     the layup may start.
func (s *LayupService) StartScreenShare(ctx context.Context, in StartShareInput) (TakeoverResult, error) {
	layup, err := s.repo.GetLayup(in.LayupID)
	if err != nil {
		return TakeoverResult{}, err
	}
	if !layup.Active() {
		return TakeoverResult{}, fmt.Errorf("%w: layup %q has ended", ErrConflict, in.LayupID)
	}

	membership, err := s.repo.GetMembership(in.PresenterMembershipID)
	if err != nil {
		return TakeoverResult{}, err
	}
	if membership.LayupID != in.LayupID || !membership.Active() {
		return TakeoverResult{}, fmt.Errorf("%w: you are not in that layup", ErrForbidden)
	}
	if in.SourceID == "" {
		return TakeoverResult{}, fmt.Errorf("%w: a share needs a capture source", ErrInvalid)
	}

	current, err := s.ActiveScreenShare(ctx, in.LayupID)
	if err != nil {
		return TakeoverResult{}, err
	}

	if current != nil {
		if current.PresenterMembershipID == in.PresenterMembershipID {
			// Already presenting: changing source is not a takeover.
			current.SourceID = in.SourceID
			if err := s.repo.SaveScreenShare(*current); err != nil {
				return TakeoverResult{}, err
			}
			return TakeoverResult{Share: *current}, nil
		}
		if err := s.mayTakeOver(layup, *current, in.PresenterMembershipID); err != nil {
			return TakeoverResult{}, err
		}
	}

	now := s.now()
	var replaced *ScreenShare
	if current != nil {
		ended := now
		current.EndedAt = &ended
		if err := s.repo.SaveScreenShare(*current); err != nil {
			return TakeoverResult{}, err
		}
		replaced = current
		s.log.InfoContext(ctx, "screen share taken over",
			"layupId", string(in.LayupID),
			"previousPresenter", string(current.PresenterMembershipID),
			"newPresenter", string(in.PresenterMembershipID),
		)
	}

	share := ScreenShare{
		ID:                    NewScreenShareID(s.ids),
		LayupID:               in.LayupID,
		PresenterMembershipID: in.PresenterMembershipID,
		SourceID:              in.SourceID,
		StartedAt:             now,
		AllowDrawing:          layup.DrawingDefault,
		AllowPointer:          layup.ControlDefault,
		AllowKeyboard:         layup.ControlDefault,
	}
	if err := s.repo.SaveScreenShare(share); err != nil {
		return TakeoverResult{}, err
	}

	layup.ActiveScreenShareID = &share.ID
	if err := s.repo.SaveLayup(layup); err != nil {
		return TakeoverResult{}, err
	}

	s.log.InfoContext(ctx, "screen share started",
		"layupId", string(in.LayupID),
		"shareId", string(share.ID),
		"presenterMembershipId", string(in.PresenterMembershipID),
	)
	return TakeoverResult{Share: share, Replaced: replaced}, nil
}

// mayTakeOver applies the visibility-dependent takeover rule.
func (s *LayupService) mayTakeOver(layup Layup, current ScreenShare, actor MembershipID) error {
	if !layup.Visibility.Open() {
		// Social convention over permission theatre: in a private layup anyone
		// may take the screen, and the previous presenter is simply told.
		return nil
	}
	if layup.IsCreatorMembership(actor) {
		return nil
	}
	if current.PresenterMembershipID == actor {
		return nil
	}
	return fmt.Errorf("%w: ask the current presenter to hand over the screen", ErrForbidden)
}

// StopScreenShare ends a share. Only the presenter may stop their own share.
// The layup continues as a perfectly valid audio/video space (SPEC.md §7.1).
func (s *LayupService) StopScreenShare(ctx context.Context, layupID LayupID, actor MembershipID) (ScreenShare, error) {
	current, err := s.ActiveScreenShare(ctx, layupID)
	if err != nil {
		return ScreenShare{}, err
	}
	if current == nil {
		return ScreenShare{}, fmt.Errorf("%w: nobody is sharing", ErrConflict)
	}
	if current.PresenterMembershipID != actor {
		return ScreenShare{}, fmt.Errorf("%w: only the presenter may stop their own share", ErrForbidden)
	}

	ended := s.now()
	current.EndedAt = &ended
	if err := s.repo.SaveScreenShare(*current); err != nil {
		return ScreenShare{}, err
	}

	layup, err := s.repo.GetLayup(layupID)
	if err != nil {
		return ScreenShare{}, err
	}
	layup.ActiveScreenShareID = nil
	if err := s.repo.SaveLayup(layup); err != nil {
		return ScreenShare{}, err
	}

	s.log.InfoContext(ctx, "screen share stopped",
		"layupId", string(layupID), "shareId", string(current.ID))
	return *current, nil
}

// ActiveScreenShare returns the layup's live share, or nil when nobody is
// sharing. A share whose presenter has left is not live.
func (s *LayupService) ActiveScreenShare(_ context.Context, layupID LayupID) (*ScreenShare, error) {
	shares, err := s.repo.ScreenSharesForLayup(layupID)
	if err != nil {
		return nil, err
	}
	for i := range shares {
		share := shares[i]
		if !share.Active() {
			continue
		}
		membership, err := s.repo.GetMembership(share.PresenterMembershipID)
		if err != nil || !membership.Active() {
			continue
		}
		return &share, nil
	}
	return nil, nil
}

// EndSharesForMembership stops any share owned by a membership that is leaving,
// so a presenter walking out never leaves a phantom share behind.
func (s *LayupService) EndSharesForMembership(ctx context.Context, membershipID MembershipID) error {
	membership, err := s.repo.GetMembership(membershipID)
	if err != nil {
		return err
	}
	shares, err := s.repo.ScreenSharesForLayup(membership.LayupID)
	if err != nil {
		return err
	}
	for _, share := range shares {
		if !share.Active() || share.PresenterMembershipID != membershipID {
			continue
		}
		ended := s.now()
		share.EndedAt = &ended
		if err := s.repo.SaveScreenShare(share); err != nil {
			return err
		}
		layup, err := s.repo.GetLayup(membership.LayupID)
		if err == nil {
			layup.ActiveScreenShareID = nil
			_ = s.repo.SaveLayup(layup)
		}
		s.log.InfoContext(ctx, "share ended because the presenter left",
			"layupId", string(membership.LayupID), "shareId", string(share.ID))
	}
	return nil
}

// ShareSettings are the presenter's safety switches for their own machine.
// They are rights over your own screen, not moderation rights (ADR-0005).
type ShareSettings struct {
	AllowDrawing  *bool
	AllowPointer  *bool
	AllowKeyboard *bool
}

// UpdateShareSettings changes the active share's permissions.
//
// Only the presenter may change them, and the change applies immediately: it is
// enforced here, so a participant whose drawing is switched off is *rejected*
// rather than merely hidden in someone's UI (SPEC.md §7.3).
func (s *LayupService) UpdateShareSettings(
	ctx context.Context,
	layupID LayupID,
	actor MembershipID,
	settings ShareSettings,
) (ScreenShare, error) {
	current, err := s.ActiveScreenShare(ctx, layupID)
	if err != nil {
		return ScreenShare{}, err
	}
	if current == nil {
		return ScreenShare{}, fmt.Errorf("%w: nobody is sharing", ErrConflict)
	}
	if current.PresenterMembershipID != actor {
		return ScreenShare{}, fmt.Errorf("%w: only the presenter controls their own screen", ErrForbidden)
	}

	if settings.AllowDrawing != nil {
		current.AllowDrawing = *settings.AllowDrawing
	}
	if settings.AllowPointer != nil {
		current.AllowPointer = *settings.AllowPointer
	}
	if settings.AllowKeyboard != nil {
		current.AllowKeyboard = *settings.AllowKeyboard
	}
	if err := s.repo.SaveScreenShare(*current); err != nil {
		return ScreenShare{}, err
	}

	s.log.InfoContext(ctx, "presenter changed share permissions",
		"layupId", string(layupID),
		"shareId", string(current.ID),
		"allowDrawing", current.AllowDrawing,
		"allowPointer", current.AllowPointer,
		"allowKeyboard", current.AllowKeyboard,
	)
	return *current, nil
}

// MayDraw reports whether a membership is currently allowed to draw on the
// active share. A non-participant, or anyone at all while drawing is off, is
// not - including the presenter's own peers who may not have noticed yet.
func (s *LayupService) MayDraw(ctx context.Context, layupID LayupID, actor MembershipID) (bool, error) {
	current, err := s.ActiveScreenShare(ctx, layupID)
	if err != nil || current == nil {
		return false, err
	}
	// The presenter may always annotate their own screen.
	if current.PresenterMembershipID == actor {
		return true, nil
	}
	if !current.AllowDrawing {
		return false, nil
	}
	membership, err := s.repo.GetMembership(actor)
	if err != nil {
		return false, nil
	}
	return membership.LayupID == layupID && membership.Active(), nil
}
