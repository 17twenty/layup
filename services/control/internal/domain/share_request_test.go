package domain

import (
	"context"
	"errors"
	"testing"
)

func TestAskingToShareOnlyExistsWhereTakingIsRefused(t *testing.T) {
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

	// Nobody is presenting: asking would be teaching people to ask for
	// something they already have.
	if _, err := f.svc.RequestScreenShare(context.Background(), view.Layup.ID, guest.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict with nobody presenting, got %v", err)
	}

	f.startShare(t, view.Layup.ID, creator)

	request, err := f.svc.RequestScreenShare(context.Background(), view.Layup.ID, guest.ID)
	if err != nil {
		t.Fatalf("a guest in an advertised session should be able to ask: %v", err)
	}
	if request.PresenterMembershipID != creator {
		t.Fatalf("the presenter is who has to decide, got %q", request.PresenterMembershipID)
	}

	// Asking changes nothing: the presenter is asked, not overruled.
	active, _ := f.svc.ActiveScreenShare(context.Background(), view.Layup.ID)
	if active == nil || active.PresenterMembershipID != creator {
		t.Fatalf("the share must be untouched: %+v", active)
	}
	if _, err := f.svc.StartScreenShare(context.Background(), StartShareInput{
		LayupID:               view.Layup.ID,
		PresenterMembershipID: guest.ID,
		SourceID:              "screen:1:0",
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("asking must not grant anything, got %v", err)
	}

	// And once the presenter stops, the asker simply shares.
	if _, err := f.svc.StopScreenShare(context.Background(), view.Layup.ID, creator); err != nil {
		t.Fatal(err)
	}
	f.startShare(t, view.Layup.ID, guest.ID)
}

func TestNobodyAsksInAPrivateLayup(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	guest := f.join(t, view.Layup.ID, f.users[1])
	f.startShare(t, view.Layup.ID, view.Participants[0].MembershipID)

	// Social convention over permission theatre: you take the screen and the
	// previous presenter is told (SPEC.md §7.2).
	if _, err := f.svc.RequestScreenShare(context.Background(), view.Layup.ID, guest.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict where taking is allowed, got %v", err)
	}

	// The presenter asking about their own share is a no-op, not a request.
	presenter := view.Participants[0].MembershipID
	if _, err := f.svc.RequestScreenShare(context.Background(), view.Layup.ID, presenter); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict for the presenter, got %v", err)
	}
}

func TestOnlyParticipantsMayAsk(t *testing.T) {
	f := newFixture(t)
	view, err := f.svc.CreateLayup(context.Background(), CreateLayupInput{
		OrganisationID: f.org,
		CreatorUserID:  f.users[0],
		Visibility:     VisibilityOrganisation,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.startShare(t, view.Layup.ID, view.Participants[0].MembershipID)

	outsider := f.create(t, f.users[2])
	if _, err := f.svc.RequestScreenShare(
		context.Background(), view.Layup.ID, outsider.Participants[0].MembershipID,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden for a membership from another layup, got %v", err)
	}
}
