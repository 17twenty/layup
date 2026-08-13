package domain

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"
)

// Invitations and knocks are one object with a direction, so the lifecycle is
// written once (SPEC.md §3.5). Nothing about a request starts media: media
// begins only after acceptance creates a membership (SPEC.md §4).

// RequestType distinguishes the direction and effect of a request.
type RequestType string

const (
	// RequestInviteToNewLayup is "I clicked you and we are not in anything yet".
	// Accepting creates the layup and both memberships atomically.
	RequestInviteToNewLayup RequestType = "INVITE_USER_TO_NEW_LAYUP"
	// RequestInviteToLayup invites someone into a layup that already exists.
	RequestInviteToLayup RequestType = "INVITE_USER_TO_LAYUP"
	// RequestKnock asks to be let into a layup you cannot see into.
	RequestKnock RequestType = "KNOCK_TO_JOIN"
)

// Valid reports whether t is a known request type.
func (t RequestType) Valid() bool {
	switch t {
	case RequestInviteToNewLayup, RequestInviteToLayup, RequestKnock:
		return true
	}
	return false
}

// RequestState is the lifecycle position of a request.
type RequestState string

const (
	RequestPending   RequestState = "PENDING"
	RequestAccepted  RequestState = "ACCEPTED"
	RequestDeclined  RequestState = "DECLINED"
	RequestExpired   RequestState = "EXPIRED"
	RequestCancelled RequestState = "CANCELLED"
)

// Terminal reports whether a state can never change again.
func (s RequestState) Terminal() bool {
	switch s {
	case RequestAccepted, RequestDeclined, RequestExpired, RequestCancelled:
		return true
	}
	return false
}

// Valid reports whether s is a known state.
func (s RequestState) Valid() bool {
	return s == RequestPending || s.Terminal()
}

// JoinRequest is an invitation or a knock.
type JoinRequest struct {
	ID         JoinRequestID
	Type       RequestType
	State      RequestState
	FromUserID UserID
	ToUserID   UserID  // empty for a knock, which targets a layup's members
	LayupID    LayupID // empty for INVITE_USER_TO_NEW_LAYUP
	Note       string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	ResolvedAt *time.Time
	// ResultLayupID is the layup the requester ended up in, set on acceptance.
	ResultLayupID LayupID
}

// Validate checks structural rules for a request.
func (r JoinRequest) Validate() error {
	if err := r.ID.Validate(); err != nil {
		return err
	}
	if !r.Type.Valid() {
		return fmt.Errorf("%w: unknown request type %q", ErrInvalid, r.Type)
	}
	if !r.State.Valid() {
		return fmt.Errorf("%w: unknown request state %q", ErrInvalid, r.State)
	}
	if err := r.FromUserID.Validate(); err != nil {
		return err
	}
	switch r.Type {
	case RequestInviteToNewLayup:
		if err := r.ToUserID.Validate(); err != nil {
			return fmt.Errorf("%w: an invitation needs a recipient", ErrInvalid)
		}
		if r.LayupID != "" {
			return fmt.Errorf("%w: an invitation to a new layup names no layup", ErrInvalid)
		}
	case RequestInviteToLayup:
		if err := r.ToUserID.Validate(); err != nil {
			return fmt.Errorf("%w: an invitation needs a recipient", ErrInvalid)
		}
		if err := r.LayupID.Validate(); err != nil {
			return fmt.Errorf("%w: an invitation into a layup needs that layup", ErrInvalid)
		}
	case RequestKnock:
		if err := r.LayupID.Validate(); err != nil {
			return fmt.Errorf("%w: a knock needs a target layup", ErrInvalid)
		}
	}
	if len(r.Note) > 140 {
		return fmt.Errorf("%w: request note is too long", ErrInvalid)
	}
	if r.ExpiresAt.Before(r.CreatedAt) {
		return fmt.Errorf("%w: request expires before it was created", ErrInvalid)
	}
	return nil
}

// Expired reports whether the request has passed its expiry at time now.
func (r JoinRequest) Expired(now time.Time) bool {
	return r.State == RequestPending && !now.Before(r.ExpiresAt)
}

// RequestService owns the request lifecycle.
type RequestService struct {
	mu       sync.Mutex
	requests map[JoinRequestID]JoinRequest
	order    []JoinRequestID

	ids IDGenerator
	now func() time.Time
	ttl time.Duration
	log *slog.Logger
}

// RequestServiceOptions configures a RequestService.
type RequestServiceOptions struct {
	IDs    IDGenerator
	Now    func() time.Time
	TTL    time.Duration
	Logger *slog.Logger
}

// NewRequestService builds the service. Requests are a lifecycle of their own:
// what an acceptance *does* to a layup is decided by the caller.
func NewRequestService(opts RequestServiceOptions) *RequestService {
	ids := opts.IDs
	if ids == nil {
		ids = NewRandomIDs()
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	ttl := opts.TTL
	if ttl <= 0 {
		ttl = DefaultPolicy().RequestTTL
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &RequestService{
		requests: map[JoinRequestID]JoinRequest{},
		ids:      ids,
		now:      now,
		ttl:      ttl,
		log:      log,
	}
}

// CreateInput describes a new request.
type CreateRequestInput struct {
	Type     RequestType
	FromUser UserID
	ToUser   UserID
	LayupID  LayupID
	Note     string
}

// Create records a new pending request.
//
// Duplicate collapse: an equivalent pending request from the same requester is
// returned instead of creating a second one, so repeated clicks never become
// repeated notifications (SPEC.md §6.5).
func (s *RequestService) Create(ctx context.Context, in CreateRequestInput) (JoinRequest, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	s.expireLocked(now)

	if existing, ok := s.findEquivalentLocked(in); ok {
		s.log.DebugContext(ctx, "collapsed duplicate request",
			"requestId", string(existing.ID), "type", string(existing.Type))
		return existing, false, nil
	}

	request := JoinRequest{
		ID:         NewJoinRequestID(s.ids),
		Type:       in.Type,
		State:      RequestPending,
		FromUserID: in.FromUser,
		ToUserID:   in.ToUser,
		LayupID:    in.LayupID,
		Note:       in.Note,
		CreatedAt:  now,
		ExpiresAt:  now.Add(s.ttl),
	}
	if err := request.Validate(); err != nil {
		return JoinRequest{}, false, err
	}
	if request.FromUserID == request.ToUserID {
		return JoinRequest{}, false, fmt.Errorf("%w: you cannot invite yourself", ErrInvalid)
	}

	s.requests[request.ID] = request
	s.order = append(s.order, request.ID)
	s.log.InfoContext(ctx, "join request created",
		"requestId", string(request.ID),
		"type", string(request.Type),
		"fromUserId", string(request.FromUserID),
		"toUserId", string(request.ToUserID),
		"layupId", string(request.LayupID),
	)
	return request, true, nil
}

// findEquivalentLocked returns a pending request that would produce the same
// notification. A pending knock is unique by (requester, target layup); an
// invitation is unique by (requester, recipient, layup).
func (s *RequestService) findEquivalentLocked(in CreateRequestInput) (JoinRequest, bool) {
	for _, id := range s.order {
		existing := s.requests[id]
		if existing.State != RequestPending || existing.Type != in.Type || existing.FromUserID != in.FromUser {
			continue
		}
		switch in.Type {
		case RequestKnock:
			if existing.LayupID == in.LayupID {
				return existing, true
			}
		default:
			if existing.ToUserID == in.ToUser && existing.LayupID == in.LayupID {
				return existing, true
			}
		}
	}
	return JoinRequest{}, false
}

// Get returns a request, expiring it first if its time has passed.
func (s *RequestService) Get(id JoinRequestID) (JoinRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.now())
	request, ok := s.requests[id]
	if !ok {
		return JoinRequest{}, fmt.Errorf("%w: request %q", ErrNotFound, id)
	}
	return request, nil
}

// Pending returns the live requests addressed to a user, newest last.
func (s *RequestService) PendingForUser(user UserID) []JoinRequest {
	return s.filter(func(r JoinRequest) bool {
		return r.State == RequestPending && r.ToUserID == user
	})
}

// PendingFromUser returns the live requests a user has sent.
func (s *RequestService) PendingFromUser(user UserID) []JoinRequest {
	return s.filter(func(r JoinRequest) bool {
		return r.State == RequestPending && r.FromUserID == user
	})
}

// PendingForLayup returns the live knocks against a layup.
func (s *RequestService) PendingForLayup(layup LayupID) []JoinRequest {
	return s.filter(func(r JoinRequest) bool {
		return r.State == RequestPending && r.Type == RequestKnock && r.LayupID == layup
	})
}

func (s *RequestService) filter(keep func(JoinRequest) bool) []JoinRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.now())

	out := make([]JoinRequest, 0, 4)
	for _, id := range s.order {
		if request := s.requests[id]; keep(request) {
			out = append(out, request)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

// Resolve moves a pending request to a terminal state.
//
// Terminal states are final: a request cannot be accepted twice, nor accepted
// after being declined, cancelled or expired.
func (s *RequestService) Resolve(ctx context.Context, id JoinRequestID, state RequestState) (JoinRequest, error) {
	if !state.Terminal() {
		return JoinRequest{}, fmt.Errorf("%w: %q is not a terminal state", ErrInvalid, state)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.expireLocked(now)

	request, ok := s.requests[id]
	if !ok {
		return JoinRequest{}, fmt.Errorf("%w: request %q", ErrNotFound, id)
	}
	if request.State.Terminal() {
		return JoinRequest{}, fmt.Errorf("%w: request %q is already %s", ErrConflict, id, request.State)
	}

	request.State = state
	resolved := now
	request.ResolvedAt = &resolved
	s.requests[id] = request

	s.log.InfoContext(ctx, "join request resolved",
		"requestId", string(id), "state", string(state), "type", string(request.Type))
	return request, nil
}

// MarkAccepted records the layup the requester ended up in.
func (s *RequestService) MarkAccepted(ctx context.Context, id JoinRequestID, layup LayupID) (JoinRequest, error) {
	request, err := s.Resolve(ctx, id, RequestAccepted)
	if err != nil {
		return JoinRequest{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	request.ResultLayupID = layup
	s.requests[id] = request
	return request, nil
}

// ExpireDue expires everything whose time has come and returns what changed.
// Expiry is deterministic: it depends only on the clock the service was given.
func (s *RequestService) ExpireDue(_ context.Context) []JoinRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.expireLocked(s.now())
}

func (s *RequestService) expireLocked(now time.Time) []JoinRequest {
	expired := make([]JoinRequest, 0, 2)
	for _, id := range s.order {
		request := s.requests[id]
		if !request.Expired(now) {
			continue
		}
		request.State = RequestExpired
		at := request.ExpiresAt
		request.ResolvedAt = &at
		s.requests[id] = request
		expired = append(expired, request)
	}
	return expired
}
