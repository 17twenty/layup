package domain

import (
	"context"
	"errors"
	"testing"
)

// The four statements of the invariant, one test each, plus the rejoin case.
// If any of these regress, creator authority has become transferable and the
// product model is broken.

func TestCreatorMembershipHoldsAuthorityWhileActive(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	creator := view.Participants[0].MembershipID

	if !view.HasCreatorAuthority {
		t.Fatal("the creating membership must hold creator authority")
	}
	if err := RequireCreator(view.Layup, creator); err != nil {
		t.Fatalf("creator membership must be authorised: %v", err)
	}

	other := f.join(t, view.Layup.ID, f.users[1])
	fresh, _ := f.svc.View(context.Background(), view.Layup.ID)
	if err := RequireCreator(fresh.Layup, other.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("an ordinary membership must not be authorised: %v", err)
	}
}

func TestCreatorLeavingElectsNobody(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	second := f.join(t, view.Layup.ID, f.users[1])
	third := f.join(t, view.Layup.ID, f.users[2])

	after, err := f.svc.Leave(context.Background(), view.Participants[0].MembershipID)
	if err != nil {
		t.Fatalf("leave: %v", err)
	}

	if after.HasCreatorAuthority {
		t.Fatal("creator authority must not survive the creator membership")
	}
	for _, p := range after.Participants {
		if p.IsCreatorMembership {
			t.Fatalf("membership %q inherited creator privilege", p.MembershipID)
		}
	}
	for _, candidate := range []MembershipID{second.ID, third.ID} {
		if err := RequireCreator(after.Layup, candidate); !errors.Is(err, ErrForbidden) {
			t.Fatalf("membership %q must not be authorised as creator: %v", candidate, err)
		}
	}

	authority, err := f.svc.AuthorityOf(context.Background(), view.Layup.ID)
	if err != nil {
		t.Fatalf("authority: %v", err)
	}
	if authority.Exists || !authority.Devolved {
		t.Fatalf("authority should be devolved: %+v", authority)
	}
}

func TestLayupRemainsActiveAfterDevolution(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	f.join(t, view.Layup.ID, f.users[1])

	after, err := f.svc.Leave(context.Background(), view.Participants[0].MembershipID)
	if err != nil {
		t.Fatalf("leave: %v", err)
	}
	if !after.Active() {
		t.Fatal("the layup must continue without any creator")
	}
	if len(after.ActiveParticipants()) != 1 {
		t.Fatalf("expected the remaining participant, got %d", len(after.ActiveParticipants()))
	}
}

func TestFormerCreatorRejoinsAsAnOrdinaryParticipant(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	f.join(t, view.Layup.ID, f.users[1])
	originalMembership := view.Participants[0].MembershipID

	if _, err := f.svc.Leave(context.Background(), originalMembership); err != nil {
		t.Fatalf("leave: %v", err)
	}

	rejoined := f.join(t, view.Layup.ID, f.users[0])
	after, _ := f.svc.View(context.Background(), view.Layup.ID)

	if rejoined.ID == originalMembership {
		t.Fatal("a rejoin must mint a new membership id")
	}
	if rejoined.IsCreatorMembership {
		t.Fatal("a rejoining former creator must be an ordinary membership")
	}
	if after.HasCreatorAuthority {
		t.Fatal("creator authority must not reappear when the original user returns")
	}
	if err := RequireCreator(after.Layup, rejoined.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("the returning user must not be authorised as creator: %v", err)
	}
	// ...and the same user identity gains nothing either: authority is not
	// addressable by user, only by membership.
	for _, p := range after.Participants {
		if p.UserID == f.users[0] && p.IsCreatorMembership {
			t.Fatal("creator privilege was resurrected via user identity")
		}
	}
}

func TestStoredCreatorFlagCannotGrantAuthorityAfterDevolution(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	f.join(t, view.Layup.ID, f.users[1])
	creator := view.Participants[0].MembershipID

	if _, err := f.svc.Leave(context.Background(), creator); err != nil {
		t.Fatalf("leave: %v", err)
	}

	// The historical membership still records that it was the creator...
	stored, err := f.repo.GetMembership(creator)
	if err != nil {
		t.Fatalf("get membership: %v", err)
	}
	if !stored.IsCreatorMembership {
		t.Fatal("history should still record which membership created the layup")
	}

	// ...but that record grants nothing: authority is read from the layup.
	after, _ := f.svc.View(context.Background(), view.Layup.ID)
	for _, p := range after.Participants {
		if p.MembershipID == creator && p.IsCreatorMembership {
			t.Fatal("a departed creator must not be rendered as privileged")
		}
	}
	if err := RequireCreator(after.Layup, creator); !errors.Is(err, ErrForbidden) {
		t.Fatalf("the departed creator must not be authorised: %v", err)
	}
}

func TestRequireCreatorOnALayupThatNeverHadOne(t *testing.T) {
	layup := Layup{}
	if err := RequireCreator(layup, MembershipID("mem_devaaaaab")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got %v", err)
	}
	if _, ok := CreatorMembership(layup); ok {
		t.Fatal("a layup without a creator membership has no creator")
	}
}
