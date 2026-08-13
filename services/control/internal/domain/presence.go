package domain

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Personal and activity presence are orthogonal (SPEC.md §3.2): a person can be
// DND while in an open layup, or AVAILABLE while in nothing. Presence is
// advisory - it changes what the UI suggests, not what is permitted.

// PersonalPresence is what the person says about themselves.
type PersonalPresence string

const (
	PresenceAvailable PersonalPresence = "AVAILABLE"
	PresenceAway      PersonalPresence = "AWAY"
	PresenceDND       PersonalPresence = "DND"
	PresenceOffline   PersonalPresence = "OFFLINE"
)

// Valid reports whether p is a known personal presence.
func (p PersonalPresence) Valid() bool {
	switch p {
	case PresenceAvailable, PresenceAway, PresenceDND, PresenceOffline:
		return true
	}
	return false
}

// ActivityPresence is what the person is currently doing in Layup.
type ActivityPresence string

const (
	ActivityNone           ActivityPresence = "NONE"
	ActivityInPrivateLayup ActivityPresence = "IN_PRIVATE_LAYUP"
	ActivityInOpenLayup    ActivityPresence = "IN_OPEN_LAYUP"
	// ActivityInvitingYou and ActivityWaitingForYou are viewer-relative: they
	// describe this person's relationship to the viewer, not a global state.
	ActivityInvitingYou   ActivityPresence = "INVITING_YOU"
	ActivityWaitingForYou ActivityPresence = "WAITING_FOR_YOU"
)

// Valid reports whether a is a known activity presence.
func (a ActivityPresence) Valid() bool {
	switch a {
	case ActivityNone, ActivityInPrivateLayup, ActivityInOpenLayup, ActivityInvitingYou, ActivityWaitingForYou:
		return true
	}
	return false
}

// PresenceView is one person as seen by one viewer. Everything optional here is
// omitted rather than blanked when the viewer is not entitled to it.
type PresenceView struct {
	UserID   UserID           `json:"userId"`
	Personal PersonalPresence `json:"personal"`
	Activity ActivityPresence `json:"activity"`

	// Layup details are present only for a layup this viewer may see:
	// their own layup, or an organisation-open one. A private layup an
	// outsider is not in shows coarse busy state and nothing else
	// (SPEC.md §5.3).
	LayupID          *LayupID `json:"layupId,omitempty"`
	LayupTitle       string   `json:"layupTitle,omitempty"`
	ParticipantCount int      `json:"participantCount,omitempty"`

	UpdatedAt time.Time `json:"updatedAt"`
}

// PresenceService owns personal presence and derives activity presence from
// layup membership.
type PresenceService struct {
	mu       sync.RWMutex
	personal map[UserID]personalRecord
	layups   *LayupService
	now      func() time.Time
}

type personalRecord struct {
	state     PersonalPresence
	updatedAt time.Time
}

// NewPresenceService builds the service. Unknown users are OFFLINE.
func NewPresenceService(layups *LayupService, now func() time.Time) *PresenceService {
	if now == nil {
		now = time.Now
	}
	return &PresenceService{
		personal: map[UserID]personalRecord{},
		layups:   layups,
		now:      now,
	}
}

// SetPersonal records what a person says about themselves.
func (s *PresenceService) SetPersonal(user UserID, state PersonalPresence) error {
	if err := user.Validate(); err != nil {
		return err
	}
	if !state.Valid() {
		return fmt.Errorf("%w: unknown personal presence %q", ErrInvalid, state)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.personal[user] = personalRecord{state: state, updatedAt: s.now()}
	return nil
}

// Personal returns the stored personal presence, defaulting to OFFLINE.
func (s *PresenceService) Personal(user UserID) PersonalPresence {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if record, ok := s.personal[user]; ok {
		return record.state
	}
	return PresenceOffline
}

// ViewFor renders subject's presence as viewer is entitled to see it.
//
// viewer may equal subject. An empty viewer means "an outsider", which is the
// most restrictive case.
func (s *PresenceService) ViewFor(ctx context.Context, viewer, subject UserID) (PresenceView, error) {
	s.mu.RLock()
	record, known := s.personal[subject]
	s.mu.RUnlock()

	view := PresenceView{
		UserID:    subject,
		Personal:  PresenceOffline,
		Activity:  ActivityNone,
		UpdatedAt: record.updatedAt,
	}
	if known {
		view.Personal = record.state
	}

	active, err := s.layups.ActiveLayupsForUser(ctx, subject)
	if err != nil {
		return PresenceView{}, err
	}
	if len(active) == 0 {
		return view, nil
	}

	// PLAN-1 is 1:1-first: a person is in at most one layup, but if that ever
	// stops holding, the first (oldest) layup is the one we describe.
	layup := active[0]
	viewerIsParticipant := false
	for _, participant := range layup.ActiveParticipants() {
		if participant.UserID == viewer {
			viewerIsParticipant = true
			break
		}
	}

	if layup.Layup.Visibility.Open() {
		view.Activity = ActivityInOpenLayup
	} else {
		view.Activity = ActivityInPrivateLayup
	}

	sameOrganisation := viewer != "" && layup.Layup.OrganisationID != ""
	maySeeDetail := viewerIsParticipant || (layup.Layup.Visibility.Open() && sameOrganisation)
	if !maySeeDetail {
		// Coarse busy state only: no id, no title, no participant count.
		return view, nil
	}

	id := layup.Layup.ID
	view.LayupID = &id
	view.LayupTitle = layup.Layup.Title
	view.ParticipantCount = len(layup.ActiveParticipants())
	return view, nil
}

// SnapshotFor renders every listed subject for one viewer.
func (s *PresenceService) SnapshotFor(ctx context.Context, viewer UserID, subjects []UserID) ([]PresenceView, error) {
	out := make([]PresenceView, 0, len(subjects))
	for _, subject := range subjects {
		view, err := s.ViewFor(ctx, viewer, subject)
		if err != nil {
			return nil, err
		}
		out = append(out, view)
	}
	return out, nil
}
