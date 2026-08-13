package domain

import (
	"fmt"
	"sort"
	"sync"
)

// Repository is the persistence boundary for layups and memberships.
//
// PLAN-1 runs entirely on the in-memory implementation below. Persistence must
// implement this interface rather than reshape the domain API
// (ARCHITECTURE.md §10).
type Repository interface {
	SaveLayup(Layup) error
	GetLayup(LayupID) (Layup, error)
	ListLayups(OrganisationID) ([]Layup, error)

	SaveMembership(Membership) error
	GetMembership(MembershipID) (Membership, error)
	MembershipsForLayup(LayupID) ([]Membership, error)
	MembershipsForUser(UserID) ([]Membership, error)

	SaveScreenShare(ScreenShare) error
	ScreenSharesForLayup(LayupID) ([]ScreenShare, error)
}

// MemoryRepository is a deterministic in-memory Repository. It is safe for
// concurrent use and returns copies, so callers cannot mutate stored state.
type MemoryRepository struct {
	mu          sync.RWMutex
	layups      map[LayupID]Layup
	memberships map[MembershipID]Membership
	shares      map[ScreenShareID]ScreenShare
	// Insertion order keeps listings stable, which keeps tests and the UI calm.
	layupOrder      []LayupID
	membershipOrder []MembershipID
	shareOrder      []ScreenShareID
}

// NewMemoryRepository returns an empty repository.
func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{
		layups:      map[LayupID]Layup{},
		memberships: map[MembershipID]Membership{},
		shares:      map[ScreenShareID]ScreenShare{},
	}
}

// SaveLayup inserts or replaces a layup.
func (r *MemoryRepository) SaveLayup(layup Layup) error {
	if err := layup.Validate(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.layups[layup.ID]; !exists {
		r.layupOrder = append(r.layupOrder, layup.ID)
	}
	r.layups[layup.ID] = layup
	return nil
}

// GetLayup returns a layup by ID.
func (r *MemoryRepository) GetLayup(id LayupID) (Layup, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	layup, ok := r.layups[id]
	if !ok {
		return Layup{}, fmt.Errorf("%w: layup %q", ErrNotFound, id)
	}
	return layup, nil
}

// ListLayups returns every layup in an organisation, oldest first.
func (r *MemoryRepository) ListLayups(org OrganisationID) ([]Layup, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Layup, 0, len(r.layupOrder))
	for _, id := range r.layupOrder {
		if layup := r.layups[id]; layup.OrganisationID == org {
			out = append(out, layup)
		}
	}
	return out, nil
}

// SaveMembership inserts or replaces a membership.
func (r *MemoryRepository) SaveMembership(m Membership) error {
	if err := m.Validate(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.memberships[m.ID]; !exists {
		r.membershipOrder = append(r.membershipOrder, m.ID)
	}
	r.memberships[m.ID] = m
	return nil
}

// GetMembership returns a membership by ID.
func (r *MemoryRepository) GetMembership(id MembershipID) (Membership, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.memberships[id]
	if !ok {
		return Membership{}, fmt.Errorf("%w: membership %q", ErrNotFound, id)
	}
	return m, nil
}

// MembershipsForLayup returns every membership of a layup, join order first.
func (r *MemoryRepository) MembershipsForLayup(id LayupID) ([]Membership, error) {
	return r.filterMemberships(func(m Membership) bool { return m.LayupID == id }), nil
}

// MembershipsForUser returns every membership held by a user.
func (r *MemoryRepository) MembershipsForUser(id UserID) ([]Membership, error) {
	return r.filterMemberships(func(m Membership) bool { return m.UserID == id }), nil
}

// SaveScreenShare inserts or replaces a screen share.
func (r *MemoryRepository) SaveScreenShare(share ScreenShare) error {
	if err := share.ID.Validate(); err != nil {
		return err
	}
	if err := share.LayupID.Validate(); err != nil {
		return err
	}
	if err := share.PresenterMembershipID.Validate(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.shares[share.ID]; !exists {
		r.shareOrder = append(r.shareOrder, share.ID)
	}
	r.shares[share.ID] = share
	return nil
}

// ScreenSharesForLayup returns every share of a layup, newest last.
func (r *MemoryRepository) ScreenSharesForLayup(id LayupID) ([]ScreenShare, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]ScreenShare, 0, 2)
	for _, shareID := range r.shareOrder {
		if share := r.shares[shareID]; share.LayupID == id {
			out = append(out, share)
		}
	}
	return out, nil
}

func (r *MemoryRepository) filterMemberships(keep func(Membership) bool) []Membership {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Membership, 0, 8)
	for _, id := range r.membershipOrder {
		if m := r.memberships[id]; keep(m) {
			out = append(out, m)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].JoinedAt.Before(out[j].JoinedAt) })
	return out
}
