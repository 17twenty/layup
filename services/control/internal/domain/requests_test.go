package domain

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

type requestFixture struct {
	*fixture
	requests *RequestService
	clock    time.Time
}

func newRequestFixture(t *testing.T) *requestFixture {
	t.Helper()
	f := newFixture(t)
	rf := &requestFixture{fixture: f, clock: time.Date(2026, 8, 13, 9, 0, 0, 0, time.UTC)}
	rf.requests = NewRequestService(f.svc, RequestServiceOptions{
		IDs:    f.ids,
		Now:    func() time.Time { return rf.clock },
		TTL:    60 * time.Second,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	return rf
}

func (f *requestFixture) invite(t *testing.T, from, to UserID) JoinRequest {
	t.Helper()
	request, _, err := f.requests.Create(context.Background(), CreateRequestInput{
		Type:     RequestInviteToNewLayup,
		FromUser: from,
		ToUser:   to,
		Note:     "Auth is doing something dumb",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	return request
}

func TestRequestLifecycleTransitions(t *testing.T) {
	f := newRequestFixture(t)
	request := f.invite(t, f.users[0], f.users[1])

	if request.State != RequestPending || request.Type != RequestInviteToNewLayup {
		t.Fatalf("unexpected new request: %+v", request)
	}
	if request.ExpiresAt.Sub(request.CreatedAt) != 60*time.Second {
		t.Fatalf("expiry should follow the TTL: %v", request.ExpiresAt.Sub(request.CreatedAt))
	}

	accepted, err := f.requests.Resolve(context.Background(), request.ID, RequestAccepted)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if accepted.State != RequestAccepted || accepted.ResolvedAt == nil {
		t.Fatalf("unexpected accepted request: %+v", accepted)
	}
}

func TestTerminalStatesAreFinal(t *testing.T) {
	f := newRequestFixture(t)

	for _, first := range []RequestState{RequestAccepted, RequestDeclined, RequestCancelled} {
		request := f.invite(t, f.users[0], f.users[1])
		if _, err := f.requests.Resolve(context.Background(), request.ID, first); err != nil {
			t.Fatalf("resolve %s: %v", first, err)
		}
		for _, second := range []RequestState{RequestAccepted, RequestDeclined, RequestCancelled} {
			_, err := f.requests.Resolve(context.Background(), request.ID, second)
			if !errors.Is(err, ErrConflict) {
				t.Fatalf("%s -> %s should conflict, got %v", first, second, err)
			}
		}
	}
}

func TestResolveRejectsNonTerminalTargets(t *testing.T) {
	f := newRequestFixture(t)
	request := f.invite(t, f.users[0], f.users[1])
	if _, err := f.requests.Resolve(context.Background(), request.ID, RequestPending); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected ErrInvalid, got %v", err)
	}
}

func TestExpiryIsDeterministic(t *testing.T) {
	f := newRequestFixture(t)
	request := f.invite(t, f.users[0], f.users[1])

	f.clock = f.clock.Add(59 * time.Second)
	if got, _ := f.requests.Get(request.ID); got.State != RequestPending {
		t.Fatalf("not yet expired, got %s", got.State)
	}

	f.clock = f.clock.Add(time.Second)
	expired, _ := f.requests.Get(request.ID)
	if expired.State != RequestExpired {
		t.Fatalf("expected EXPIRED at the boundary, got %s", expired.State)
	}
	if expired.ResolvedAt == nil || !expired.ResolvedAt.Equal(expired.ExpiresAt) {
		t.Fatalf("expiry time should be the deadline, got %+v", expired.ResolvedAt)
	}

	// An expired request can never be accepted.
	if _, err := f.requests.Resolve(context.Background(), request.ID, RequestAccepted); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict accepting an expired request, got %v", err)
	}
	if len(f.requests.PendingForUser(f.users[1])) != 0 {
		t.Fatal("an expired request must disappear from the recipient's list")
	}
}

func TestDuplicateRequestsCollapse(t *testing.T) {
	f := newRequestFixture(t)

	first := f.invite(t, f.users[0], f.users[1])
	second := f.invite(t, f.users[0], f.users[1])
	if first.ID != second.ID {
		t.Fatalf("repeated clicks must reuse one pending request: %q vs %q", first.ID, second.ID)
	}
	if len(f.requests.PendingForUser(f.users[1])) != 1 {
		t.Fatal("the recipient must see exactly one pending request")
	}

	// A different recipient is a different request.
	other := f.invite(t, f.users[0], f.users[2])
	if other.ID == first.ID {
		t.Fatal("different recipients must not collapse")
	}

	// Once resolved, a new click creates a fresh request.
	if _, err := f.requests.Resolve(context.Background(), first.ID, RequestDeclined); err != nil {
		t.Fatal(err)
	}
	third := f.invite(t, f.users[0], f.users[1])
	if third.ID == first.ID {
		t.Fatal("a resolved request must not be reused")
	}
}

func TestKnocksCollapseByRequesterAndLayup(t *testing.T) {
	f := newRequestFixture(t)
	view := f.create(t, f.users[0])

	knock := func(from UserID) (JoinRequest, bool) {
		request, created, err := f.requests.Create(context.Background(), CreateRequestInput{
			Type:     RequestKnock,
			FromUser: from,
			LayupID:  view.Layup.ID,
		})
		if err != nil {
			t.Fatalf("knock: %v", err)
		}
		return request, created
	}

	first, created := knock(f.users[1])
	if !created {
		t.Fatal("the first knock is new")
	}
	second, createdAgain := knock(f.users[1])
	if createdAgain || second.ID != first.ID {
		t.Fatal("a repeated knock must collapse onto the pending one")
	}
	third, _ := knock(f.users[2])
	if third.ID == first.ID {
		t.Fatal("a different requester is a different knock")
	}

	pending := f.requests.PendingForLayup(view.Layup.ID)
	if len(pending) != 2 {
		t.Fatalf("expected two pending knocks, got %d", len(pending))
	}
}

func TestRequestValidationRules(t *testing.T) {
	f := newRequestFixture(t)
	ctx := context.Background()

	// An invitation needs a recipient.
	if _, _, err := f.requests.Create(ctx, CreateRequestInput{
		Type: RequestInviteToNewLayup, FromUser: f.users[0],
	}); !errors.Is(err, ErrInvalid) {
		t.Errorf("expected ErrInvalid without a recipient, got %v", err)
	}

	// A knock needs a layup.
	if _, _, err := f.requests.Create(ctx, CreateRequestInput{
		Type: RequestKnock, FromUser: f.users[0],
	}); !errors.Is(err, ErrInvalid) {
		t.Errorf("expected ErrInvalid without a layup, got %v", err)
	}

	// An invitation to a new layup must not name a layup.
	view := f.create(t, f.users[0])
	if _, _, err := f.requests.Create(ctx, CreateRequestInput{
		Type: RequestInviteToNewLayup, FromUser: f.users[0], ToUser: f.users[1], LayupID: view.Layup.ID,
	}); !errors.Is(err, ErrInvalid) {
		t.Errorf("expected ErrInvalid naming a layup, got %v", err)
	}

	// You cannot invite yourself.
	if _, _, err := f.requests.Create(ctx, CreateRequestInput{
		Type: RequestInviteToNewLayup, FromUser: f.users[0], ToUser: f.users[0],
	}); !errors.Is(err, ErrInvalid) {
		t.Errorf("expected ErrInvalid inviting yourself, got %v", err)
	}

	// Unknown types are rejected.
	if _, _, err := f.requests.Create(ctx, CreateRequestInput{
		Type: RequestType("SUMMON"), FromUser: f.users[0], ToUser: f.users[1],
	}); !errors.Is(err, ErrInvalid) {
		t.Errorf("expected ErrInvalid for an unknown type, got %v", err)
	}
}

func TestCancelAndExpireLists(t *testing.T) {
	f := newRequestFixture(t)
	request := f.invite(t, f.users[0], f.users[1])

	if len(f.requests.PendingFromUser(f.users[0])) != 1 {
		t.Fatal("the sender should see their pending request")
	}
	if _, err := f.requests.Resolve(context.Background(), request.ID, RequestCancelled); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if len(f.requests.PendingFromUser(f.users[0])) != 0 || len(f.requests.PendingForUser(f.users[1])) != 0 {
		t.Fatal("a cancelled request disappears from both sides")
	}

	// ExpireDue reports what it changed, so a caller can publish it.
	next := f.invite(t, f.users[0], f.users[1])
	f.clock = f.clock.Add(2 * time.Minute)
	expired := f.requests.ExpireDue(context.Background())
	if len(expired) != 1 || expired[0].ID != next.ID {
		t.Fatalf("expected the expired request to be reported, got %+v", expired)
	}
	if second := f.requests.ExpireDue(context.Background()); len(second) != 0 {
		t.Fatal("expiring twice must not report the same request again")
	}
}

func TestMarkAcceptedRecordsTheResultingLayup(t *testing.T) {
	f := newRequestFixture(t)
	request := f.invite(t, f.users[0], f.users[1])
	view := f.create(t, f.users[0])

	accepted, err := f.requests.MarkAccepted(context.Background(), request.ID, view.Layup.ID)
	if err != nil {
		t.Fatalf("mark accepted: %v", err)
	}
	if accepted.ResultLayupID != view.Layup.ID {
		t.Fatalf("expected the resulting layup to be recorded, got %+v", accepted)
	}
	stored, _ := f.requests.Get(request.ID)
	if stored.ResultLayupID != view.Layup.ID || stored.State != RequestAccepted {
		t.Fatalf("stored request should carry the result: %+v", stored)
	}
}
