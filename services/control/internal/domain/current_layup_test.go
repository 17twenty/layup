package domain

import (
	"context"
	"testing"
)

func TestAPersonIsInOneLayupAtATime(t *testing.T) {
	f := newFixture(t)
	first := f.create(t, f.users[0])
	f.join(t, first.Layup.ID, f.users[1])

	// Nick walks into another layup. That is leaving the first, not opening a
	// second window onto himself: a membership left behind is a phantom
	// participant nobody can talk to.
	second := f.create(t, f.users[0])

	views, err := f.svc.ActiveLayupsForUser(context.Background(), f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(views) != 1 || views[0].Layup.ID != second.Layup.ID {
		t.Fatalf("expected exactly the new layup, got %d: %+v", len(views), views)
	}

	// The layup he left carries on for the person still in it.
	after, err := f.svc.View(context.Background(), first.Layup.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.Active() || len(after.ActiveParticipants()) != 1 {
		t.Fatalf("the first layup should still hold one person: %+v", after.Participants)
	}
}

func TestLeavingForAnotherLayupEndsAnEmptyOne(t *testing.T) {
	f := newFixture(t)
	alone := f.create(t, f.users[0])

	f.create(t, f.users[0])

	after, err := f.svc.View(context.Background(), alone.Layup.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Nobody is left in it, so it is over rather than lingering in Happening
	// Now as somewhere nobody is.
	if after.Active() {
		t.Fatal("an emptied layup must end")
	}
}

func TestAPresenterWhoWalksOutTakesTheirShareWithThem(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	f.join(t, view.Layup.ID, f.users[1])
	f.startShare(t, view.Layup.ID, view.Participants[0].MembershipID)

	// Joining somewhere else is a real leave, with all its consequences.
	f.create(t, f.users[0])

	share, err := f.svc.ActiveScreenShare(context.Background(), view.Layup.ID)
	if err != nil {
		t.Fatal(err)
	}
	if share != nil {
		t.Fatalf("a phantom share survived the presenter leaving: %+v", share)
	}
}

func TestTheDesktopCanFindTheLayupItIsAlreadyIn(t *testing.T) {
	f := newFixture(t)

	// Nothing yet: a fresh desktop is in no layup, and says so.
	view, membership, err := f.svc.CurrentLayupForUser(context.Background(), f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if view != nil || membership != nil {
		t.Fatalf("expected nothing, got %+v %+v", view, membership)
	}

	created := f.create(t, f.users[0])

	// Restarting the application must not look like being thrown out of the
	// room you are standing in.
	view, membership, err = f.svc.CurrentLayupForUser(context.Background(), f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if view == nil || view.Layup.ID != created.Layup.ID {
		t.Fatalf("expected the layup they are in, got %+v", view)
	}
	if membership == nil || membership.ID != created.Participants[0].MembershipID {
		t.Fatalf("expected their own membership, got %+v", membership)
	}
	if !membership.IsCreatorMembership {
		t.Fatal("the creator membership must be reported as such, or authority looks lost")
	}

	// And after leaving, nothing again.
	if _, err := f.svc.Leave(context.Background(), membership.ID); err != nil {
		t.Fatal(err)
	}
	view, membership, err = f.svc.CurrentLayupForUser(context.Background(), f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if view != nil || membership != nil {
		t.Fatalf("expected nothing after leaving, got %+v %+v", view, membership)
	}
}
