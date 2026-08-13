package domain

import (
	"context"
	"fmt"
)

// Creator authority in Layup is deliberately weak and deliberately mortal.
//
//	creator membership leaves
//	  -> creator authority disappears permanently
//	  -> nobody inherits it
//	  -> the layup continues
//	  -> the same user rejoins as an ordinary participant
//
// There is no moderator role, no host election and no way to name a creator by
// user identity. This file is the only place that answers "who, if anyone, has
// creator authority?" so the rule cannot be re-implemented differently
// elsewhere (SPEC.md §2.2, ARCHITECTURE.md §4).

// CreatorMembership returns the membership that holds creator authority.
// The second result is false once authority has devolved - which is a normal,
// permanent state, not an error.
func CreatorMembership(layup Layup) (MembershipID, bool) {
	if layup.CreatorMembershipID == nil {
		return "", false
	}
	return *layup.CreatorMembershipID, true
}

// RequireCreator authorises an action reserved for the creator membership.
//
// It takes a MembershipID. There is no overload taking a UserID: an action can
// only be authorised by being *this* incarnation, never by being the person who
// once created the layup.
func RequireCreator(layup Layup, actor MembershipID) error {
	if layup.CreatorMembershipID == nil {
		return fmt.Errorf("%w: this layup has no creator authority", ErrForbidden)
	}
	if *layup.CreatorMembershipID != actor {
		return fmt.Errorf("%w: membership %q does not hold creator authority", ErrForbidden, actor)
	}
	return nil
}

// CreatorAuthority describes the authority state of a layup for callers that
// need to render or log it.
type CreatorAuthority struct {
	// Exists is false once the creator membership has left.
	Exists bool `json:"exists"`
	// MembershipID is set only while Exists is true.
	MembershipID MembershipID `json:"membershipId,omitempty"`
	// Devolved records that this layup once had a creator and no longer does.
	Devolved bool `json:"devolved"`
}

// AuthorityOf reports the creator-authority state of a layup.
//
// Devolved is derived from the memberships: if some membership was minted as
// the creator membership but the layup no longer points at it, authority has
// devolved. That stored flag is never used to *grant* anything.
func (s *LayupService) AuthorityOf(_ context.Context, layupID LayupID) (CreatorAuthority, error) {
	layup, err := s.repo.GetLayup(layupID)
	if err != nil {
		return CreatorAuthority{}, err
	}
	memberships, err := s.repo.MembershipsForLayup(layupID)
	if err != nil {
		return CreatorAuthority{}, err
	}

	if id, ok := CreatorMembership(layup); ok {
		return CreatorAuthority{Exists: true, MembershipID: id}, nil
	}
	for _, m := range memberships {
		if m.IsCreatorMembership {
			return CreatorAuthority{Exists: false, Devolved: true}, nil
		}
	}
	return CreatorAuthority{}, nil
}
