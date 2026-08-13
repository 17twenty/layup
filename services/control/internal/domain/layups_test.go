package domain

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

type fixture struct {
	svc   *LayupService
	repo  *MemoryRepository
	ids   *SequentialIDs
	org   OrganisationID
	users []UserID
	clock time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ids := NewSequentialIDs()
	repo := NewMemoryRepository()
	f := &fixture{
		repo:  repo,
		ids:   ids,
		org:   NewOrganisationID(ids),
		clock: time.Date(2026, 8, 13, 9, 0, 0, 0, time.UTC),
	}
	for i := 0; i < 4; i++ {
		f.users = append(f.users, NewUserID(ids))
	}
	f.svc = NewLayupService(repo, LayupServiceOptions{
		IDs:    ids,
		Now:    func() time.Time { f.clock = f.clock.Add(time.Second); return f.clock },
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	return f
}

func (f *fixture) create(t *testing.T, user UserID) LayupView {
	t.Helper()
	view, err := f.svc.CreateLayup(context.Background(), CreateLayupInput{
		OrganisationID: f.org,
		CreatorUserID:  user,
		Title:          "Auth is doing something dumb",
		Visibility:     VisibilityPrivate,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return view
}

func (f *fixture) join(t *testing.T, layup LayupID, user UserID) Membership {
	t.Helper()
	_, membership, err := f.svc.Join(context.Background(), layup, user)
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	return membership
}

func TestFirstMembershipActivatesLayup(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])

	if !view.Active() {
		t.Fatal("a created layup must be active")
	}
	if len(view.ActiveParticipants()) != 1 {
		t.Fatalf("expected one participant, got %d", len(view.ActiveParticipants()))
	}
	if !view.HasCreatorAuthority {
		t.Fatal("the creator membership should hold creator authority")
	}
	if view.Participants[0].MembershipID == "" || string(view.Participants[0].UserID) != string(f.users[0]) {
		t.Fatalf("unexpected participant: %+v", view.Participants[0])
	}
}

func TestLayupRemainsActiveWhileAnyMembershipRemains(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	layupID := view.Layup.ID

	f.join(t, layupID, f.users[1])
	f.join(t, layupID, f.users[2])

	creatorMembership := view.Participants[0].MembershipID
	after, err := f.svc.Leave(context.Background(), creatorMembership)
	if err != nil {
		t.Fatalf("leave: %v", err)
	}
	if !after.Active() {
		t.Fatal("layup must survive the creator leaving while others remain")
	}
	if len(after.ActiveParticipants()) != 2 {
		t.Fatalf("expected two remaining participants, got %d", len(after.ActiveParticipants()))
	}
}

func TestFinalMembershipLeavingEndsLayup(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	layupID := view.Layup.ID
	second := f.join(t, layupID, f.users[1])

	if _, err := f.svc.Leave(context.Background(), view.Participants[0].MembershipID); err != nil {
		t.Fatalf("leave creator: %v", err)
	}
	final, err := f.svc.Leave(context.Background(), second.ID)
	if err != nil {
		t.Fatalf("leave last: %v", err)
	}

	if final.Active() {
		t.Fatal("a layup with no active memberships must end")
	}
	if final.Layup.EndedAt == nil {
		t.Fatal("EndedAt must be stamped")
	}
	if len(final.ActiveParticipants()) != 0 {
		t.Fatal("no participants should remain")
	}
}

func TestNoOwnerRequirementForAnActiveLayup(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	f.join(t, view.Layup.ID, f.users[1])

	after, err := f.svc.Leave(context.Background(), view.Participants[0].MembershipID)
	if err != nil {
		t.Fatalf("leave: %v", err)
	}

	if after.HasCreatorAuthority {
		t.Fatal("creator authority must be gone")
	}
	if !after.Active() {
		t.Fatal("an ownerless layup is still a valid layup")
	}
	// And it keeps working: another user can still join.
	if _, _, err := f.svc.Join(context.Background(), view.Layup.ID, f.users[2]); err != nil {
		t.Fatalf("joining an ownerless layup must work: %v", err)
	}
}

func TestJoinIsIdempotentForAPresentUser(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])

	first := f.join(t, view.Layup.ID, f.users[1])
	second := f.join(t, view.Layup.ID, f.users[1])

	if first.ID != second.ID {
		t.Fatalf("a present user must not gain a second membership: %q vs %q", first.ID, second.ID)
	}
	after, _ := f.svc.View(context.Background(), view.Layup.ID)
	if len(after.ActiveParticipants()) != 2 {
		t.Fatalf("expected two participants, got %d", len(after.ActiveParticipants()))
	}
}

func TestJoiningAnEndedLayupIsRejected(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	if _, err := f.svc.Leave(context.Background(), view.Participants[0].MembershipID); err != nil {
		t.Fatalf("leave: %v", err)
	}

	_, _, err := f.svc.Join(context.Background(), view.Layup.ID, f.users[1])
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
}

func TestLeaveIsIdempotent(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	f.join(t, view.Layup.ID, f.users[1])
	membership := view.Participants[0].MembershipID

	first, err := f.svc.Leave(context.Background(), membership)
	if err != nil {
		t.Fatalf("leave: %v", err)
	}
	second, err := f.svc.Leave(context.Background(), membership)
	if err != nil {
		t.Fatalf("second leave must not error: %v", err)
	}
	if len(first.ActiveParticipants()) != len(second.ActiveParticipants()) {
		t.Fatal("leaving twice must not change participant count")
	}
	if !second.Active() {
		t.Fatal("leaving twice must not end a layup that still has participants")
	}
}

func TestUnknownEntitiesReportNotFound(t *testing.T) {
	f := newFixture(t)
	if _, err := f.svc.View(context.Background(), LayupID("lay_devzzzzzz")); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound for an unknown layup, got %v", err)
	}
	if _, err := f.svc.Leave(context.Background(), MembershipID("mem_devzzzzzz")); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound for an unknown membership, got %v", err)
	}
}

func TestActiveLayupsForUser(t *testing.T) {
	f := newFixture(t)
	view := f.create(t, f.users[0])
	f.join(t, view.Layup.ID, f.users[1])

	active, err := f.svc.ActiveLayupsForUser(context.Background(), f.users[1])
	if err != nil {
		t.Fatalf("active layups: %v", err)
	}
	if len(active) != 1 || active[0].Layup.ID != view.Layup.ID {
		t.Fatalf("unexpected active layups: %+v", active)
	}

	memberships, _ := f.repo.MembershipsForUser(f.users[1])
	if _, err := f.svc.Leave(context.Background(), memberships[0].ID); err != nil {
		t.Fatalf("leave: %v", err)
	}
	active, _ = f.svc.ActiveLayupsForUser(context.Background(), f.users[1])
	if len(active) != 0 {
		t.Fatalf("a user who left is in no layup, got %+v", active)
	}
}

func TestRepositoryValidatesWhatItStores(t *testing.T) {
	repo := NewMemoryRepository()
	if err := repo.SaveLayup(Layup{ID: "nope"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected invalid layup to be rejected, got %v", err)
	}
	if err := repo.SaveMembership(Membership{ID: "nope"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected invalid membership to be rejected, got %v", err)
	}
}
