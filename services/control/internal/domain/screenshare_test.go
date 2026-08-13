package domain

import (
	"context"
	"errors"
	"testing"
)

func (f *fixture) startShare(t *testing.T, layup LayupID, membership MembershipID) TakeoverResult {
	t.Helper()
	result, err := f.svc.StartScreenShare(context.Background(), StartShareInput{
		LayupID:               layup,
		PresenterMembershipID: membership,
		SourceID:              "screen:1:0",
	})
	if err != nil {
		t.Fatalf("start share: %v", err)
	}
	return result
}

func TestOnlyOneSharedDesktopExistsAtATime(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	second := f.join(t, view.Layup.ID, f.users[1])
	third := f.join(t, view.Layup.ID, f.users[2])

	first := f.startShare(t, view.Layup.ID, view.Participants[0].MembershipID)
	if first.Replaced != nil {
		t.Fatal("the first share replaces nothing")
	}

	// A private layup: anyone may take over, with no approval dialog.
	takeover := f.startShare(t, view.Layup.ID, second.ID)
	if takeover.Replaced == nil || takeover.Replaced.ID != first.Share.ID {
		t.Fatalf("taking over must end the previous share: %+v", takeover.Replaced)
	}
	if takeover.Replaced.Active() {
		t.Fatal("the replaced share must be ended")
	}

	active, err := f.svc.ActiveScreenShare(context.Background(), view.Layup.ID)
	if err != nil || active == nil {
		t.Fatalf("expected one active share: %v %+v", err, active)
	}
	if active.ID != takeover.Share.ID || active.PresenterMembershipID != second.ID {
		t.Fatalf("unexpected active share: %+v", active)
	}

	// And still exactly one after a third person takes it.
	f.startShare(t, view.Layup.ID, third.ID)
	shares, _ := f.repo.ScreenSharesForLayup(view.Layup.ID)
	live := 0
	for _, share := range shares {
		if share.Active() {
			live++
		}
	}
	if live != 1 {
		t.Fatalf("exactly one share may be live, found %d", live)
	}
}

func TestOpenLayupsRequireHandoverRatherThanHijack(t *testing.T) {
	f := newFixture(t)
	view, err := f.svc.CreateLayup(context.Background(), CreateLayupInput{
		OrganisationID: f.org,
		CreatorUserID:  f.users[0],
		Title:          "Advertised session",
		Visibility:     VisibilityOrganisation,
	})
	if err != nil {
		t.Fatal(err)
	}
	creator := view.Participants[0].MembershipID
	guest := f.join(t, view.Layup.ID, f.users[1])
	other := f.join(t, view.Layup.ID, f.users[2])

	f.startShare(t, view.Layup.ID, creator)

	// An ordinary participant cannot take an advertised session's screen.
	_, err = f.svc.StartScreenShare(context.Background(), StartShareInput{
		LayupID:               view.Layup.ID,
		PresenterMembershipID: guest.ID,
		SourceID:              "screen:1:0",
	})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden in an open layup, got %v", err)
	}

	// The creator membership may hand it over while it still exists.
	handover := f.startShare(t, view.Layup.ID, creator)
	if handover.Share.PresenterMembershipID != creator {
		t.Fatal("the creator should be able to keep presenting")
	}

	// With nobody presenting, anyone in the layup may start.
	if _, err := f.svc.StopScreenShare(context.Background(), view.Layup.ID, creator); err != nil {
		t.Fatalf("stop: %v", err)
	}
	f.startShare(t, view.Layup.ID, other.ID)
}

func TestStoppingAShareLeavesTheLayupAlone(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	f.join(t, view.Layup.ID, f.users[1])
	presenter := view.Participants[0].MembershipID
	f.startShare(t, view.Layup.ID, presenter)

	if _, err := f.svc.StopScreenShare(context.Background(), view.Layup.ID, presenter); err != nil {
		t.Fatalf("stop: %v", err)
	}

	after, _ := f.svc.View(context.Background(), view.Layup.ID)
	if !after.Active() || len(after.ActiveParticipants()) != 2 {
		t.Fatalf("the layup must survive the share ending: %+v", after.Layup)
	}
	if after.Layup.ActiveScreenShareID != nil {
		t.Fatal("no share should be marked active")
	}
	active, _ := f.svc.ActiveScreenShare(context.Background(), view.Layup.ID)
	if active != nil {
		t.Fatalf("nobody should be presenting: %+v", active)
	}
}

func TestOnlyThePresenterStopsTheirOwnShare(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	other := f.join(t, view.Layup.ID, f.users[1])
	f.startShare(t, view.Layup.ID, view.Participants[0].MembershipID)

	// There is no moderator who can stop someone else's share.
	if _, err := f.svc.StopScreenShare(context.Background(), view.Layup.ID, other.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got %v", err)
	}
	if _, err := f.svc.StopScreenShare(context.Background(), LayupID("lay_devzzzzzz"), other.ID); err == nil {
		t.Fatal("expected an error for an unknown layup")
	}
}

func TestAPresenterLeavingEndsTheirShare(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	f.join(t, view.Layup.ID, f.users[1])
	presenter := view.Participants[0].MembershipID
	f.startShare(t, view.Layup.ID, presenter)

	if _, err := f.svc.Leave(context.Background(), presenter); err != nil {
		t.Fatalf("leave: %v", err)
	}

	active, err := f.svc.ActiveScreenShare(context.Background(), view.Layup.ID)
	if err != nil {
		t.Fatal(err)
	}
	if active != nil {
		t.Fatalf("a presenter walking out must not leave a phantom share: %+v", active)
	}
	after, _ := f.svc.View(context.Background(), view.Layup.ID)
	if !after.Active() {
		t.Fatal("the layup continues after the presenter leaves")
	}
}

func TestShareCarriesPresenterSafetyDefaultsAndRejectsJunk(t *testing.T) {
	f := newFixture(t)
	created, err := f.svc.CreateLayup(context.Background(), CreateLayupInput{
		OrganisationID: f.org,
		CreatorUserID:  f.users[0],
		Visibility:     VisibilityPrivate,
		DrawingDefault: true,
		ControlDefault: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	share := f.startShare(t, created.Layup.ID, created.Participants[0].MembershipID).Share

	if !share.AllowDrawing || share.AllowPointer || share.AllowKeyboard {
		t.Fatalf("share should inherit the layup's defaults: %+v", share)
	}

	// A share needs a source, and an outsider cannot present.
	if _, err := f.svc.StartScreenShare(context.Background(), StartShareInput{
		LayupID:               created.Layup.ID,
		PresenterMembershipID: created.Participants[0].MembershipID,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected ErrInvalid without a source, got %v", err)
	}

	otherLayup := f.create(t, f.users[1])
	if _, err := f.svc.StartScreenShare(context.Background(), StartShareInput{
		LayupID:               created.Layup.ID,
		PresenterMembershipID: otherLayup.Participants[0].MembershipID,
		SourceID:              "screen:1:0",
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden for a membership from another layup, got %v", err)
	}
}

func TestChangingSourceIsNotATakeover(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	presenter := view.Participants[0].MembershipID
	first := f.startShare(t, view.Layup.ID, presenter)

	again, err := f.svc.StartScreenShare(context.Background(), StartShareInput{
		LayupID:               view.Layup.ID,
		PresenterMembershipID: presenter,
		SourceID:              "window:9:0",
	})
	if err != nil {
		t.Fatalf("changing source: %v", err)
	}
	if again.Replaced != nil {
		t.Fatal("changing your own source replaces nothing")
	}
	if again.Share.ID != first.Share.ID || again.Share.SourceID != "window:9:0" {
		t.Fatalf("expected the same share with a new source: %+v", again.Share)
	}
}
