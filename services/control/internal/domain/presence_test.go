package domain

import (
	"context"
	"errors"
	"testing"
)

func TestPersonalPresenceStatesExistAndAreValidated(t *testing.T) {
	f := newFixture(t)
	p := NewPresenceService(f.svc, nil)

	for _, state := range []PersonalPresence{PresenceAvailable, PresenceAway, PresenceDND, PresenceOffline} {
		if !state.Valid() {
			t.Errorf("%q should be valid", state)
		}
		if err := p.SetPersonal(f.users[0], state); err != nil {
			t.Fatalf("set %q: %v", state, err)
		}
		if got := p.Personal(f.users[0]); got != state {
			t.Fatalf("expected %q, got %q", state, got)
		}
	}

	if err := p.SetPersonal(f.users[0], PersonalPresence("BUSY")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected unknown presence to be rejected, got %v", err)
	}
	if got := p.Personal(f.users[3]); got != PresenceOffline {
		t.Fatalf("an unknown user is OFFLINE, got %q", got)
	}
}

func TestActivityIsOrthogonalToPersonalPresence(t *testing.T) {
	f := newFixture(t)
	p := NewPresenceService(f.svc, nil)
	ctx := context.Background()

	if err := p.SetPersonal(f.users[0], PresenceDND); err != nil {
		t.Fatal(err)
	}
	view, err := p.ViewFor(ctx, f.users[0], f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if view.Personal != PresenceDND || view.Activity != ActivityNone {
		t.Fatalf("DND with no layup: %+v", view)
	}

	f.create(t, f.users[0])
	view, err = p.ViewFor(ctx, f.users[0], f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	// Personal presence is unchanged by joining a layup; only activity moves.
	if view.Personal != PresenceDND || view.Activity != ActivityInPrivateLayup {
		t.Fatalf("expected DND + IN_PRIVATE_LAYUP, got %+v", view)
	}
}

func TestOpenLayupActivityIsDistinctFromPrivate(t *testing.T) {
	f := newFixture(t)
	p := NewPresenceService(f.svc, nil)
	ctx := context.Background()

	view, err := f.svc.CreateLayup(ctx, CreateLayupInput{
		OrganisationID: f.org,
		CreatorUserID:  f.users[0],
		Title:          "Debugging the capture path",
		Visibility:     VisibilityOrganisation,
	})
	if err != nil {
		t.Fatal(err)
	}

	outsider, err := p.ViewFor(ctx, f.users[2], f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if outsider.Activity != ActivityInOpenLayup {
		t.Fatalf("expected IN_OPEN_LAYUP, got %q", outsider.Activity)
	}
	if outsider.LayupID == nil || *outsider.LayupID != view.Layup.ID {
		t.Fatal("an organisation-open layup is discoverable")
	}
	if outsider.LayupTitle != "Debugging the capture path" || outsider.ParticipantCount != 1 {
		t.Fatalf("open layup detail should be visible: %+v", outsider)
	}
}

func TestPrivateLayupDetailIsRedactedForOutsiders(t *testing.T) {
	f := newFixture(t)
	p := NewPresenceService(f.svc, nil)
	ctx := context.Background()

	created := f.create(t, f.users[0]) // private, titled
	f.join(t, created.Layup.ID, f.users[1])

	outsider, err := p.ViewFor(ctx, f.users[2], f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if outsider.Activity != ActivityInPrivateLayup {
		t.Fatalf("outsider should see coarse busy state, got %q", outsider.Activity)
	}
	if outsider.LayupID != nil || outsider.LayupTitle != "" || outsider.ParticipantCount != 0 {
		t.Fatalf("private layup detail leaked to an outsider: %+v", outsider)
	}

	// A participant sees the detail.
	insider, err := p.ViewFor(ctx, f.users[1], f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if insider.LayupID == nil || insider.LayupTitle == "" || insider.ParticipantCount != 2 {
		t.Fatalf("a participant should see layup detail: %+v", insider)
	}

	// So does the person themselves.
	self, err := p.ViewFor(ctx, f.users[0], f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if self.LayupID == nil {
		t.Fatal("a person can see their own layup")
	}

	// An anonymous viewer sees the least.
	anonymous, err := p.ViewFor(ctx, UserID(""), f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if anonymous.LayupID != nil {
		t.Fatal("an unidentified viewer must not see layup detail")
	}
}

func TestActivityReturnsToNoneWhenTheLayupEnds(t *testing.T) {
	f := newFixture(t)
	p := NewPresenceService(f.svc, nil)
	ctx := context.Background()

	created := f.create(t, f.users[0])
	if _, err := f.svc.Leave(ctx, created.Participants[0].MembershipID); err != nil {
		t.Fatal(err)
	}

	view, err := p.ViewFor(ctx, f.users[1], f.users[0])
	if err != nil {
		t.Fatal(err)
	}
	if view.Activity != ActivityNone || view.LayupID != nil {
		t.Fatalf("expected NONE after leaving, got %+v", view)
	}
}

func TestSnapshotRendersEveryoneForOneViewer(t *testing.T) {
	f := newFixture(t)
	p := NewPresenceService(f.svc, nil)
	ctx := context.Background()

	if err := p.SetPersonal(f.users[0], PresenceAvailable); err != nil {
		t.Fatal(err)
	}
	if err := p.SetPersonal(f.users[1], PresenceAway); err != nil {
		t.Fatal(err)
	}
	f.create(t, f.users[1])

	snapshot, err := p.SnapshotFor(ctx, f.users[0], []UserID{f.users[0], f.users[1], f.users[2]})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot) != 3 {
		t.Fatalf("expected three entries, got %d", len(snapshot))
	}
	if snapshot[0].Personal != PresenceAvailable || snapshot[0].Activity != ActivityNone {
		t.Fatalf("unexpected self view: %+v", snapshot[0])
	}
	if snapshot[1].Personal != PresenceAway || snapshot[1].Activity != ActivityInPrivateLayup {
		t.Fatalf("unexpected busy view: %+v", snapshot[1])
	}
	if snapshot[1].LayupID != nil {
		t.Fatal("private layup detail must stay redacted in snapshots too")
	}
	if snapshot[2].Personal != PresenceOffline {
		t.Fatalf("unknown users are offline: %+v", snapshot[2])
	}
}

func TestViewerRelativeActivityStatesExist(t *testing.T) {
	// INVITING_YOU / WAITING_FOR_YOU are set by the request lifecycle in
	// Phase C; the model must already carry them.
	for _, a := range []ActivityPresence{
		ActivityNone, ActivityInPrivateLayup, ActivityInOpenLayup,
		ActivityInvitingYou, ActivityWaitingForYou,
	} {
		if !a.Valid() {
			t.Errorf("%q should be a valid activity", a)
		}
	}
	if ActivityPresence("PARTYING").Valid() {
		t.Error("unknown activity states must be rejected")
	}
}
