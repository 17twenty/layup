// Package presencefeed publishes presence and activity changes to the
// organisation's connected clients.
//
// Every recipient gets its own rendering: presence is redacted per viewer, so a
// single shared payload would leak private layup detail to an outsider
// (SPEC.md §5.3).
package presencefeed

import (
	"context"
	"log/slog"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/directory"
	"github.com/layup-app/layup/services/control/internal/domain"
	"github.com/layup-app/layup/services/control/internal/realtime"
)

// Realtime message types published by this feed.
const (
	// TypePresenceSnapshot is the full picture sent when a client connects.
	TypePresenceSnapshot = "presence.snapshot"
	// TypePresenceUpdate is one person changing, pushed without polling.
	TypePresenceUpdate = "presence.update"
)

// PresenceDTO is the wire shape of one person's presence for one viewer.
type PresenceDTO struct {
	UserID           string `json:"userId"`
	DisplayName      string `json:"displayName"`
	StatusMessage    string `json:"statusMessage,omitempty"`
	Personal         string `json:"personal"`
	Activity         string `json:"activity"`
	LayupID          string `json:"layupId,omitempty"`
	LayupTitle       string `json:"layupTitle,omitempty"`
	ParticipantCount int    `json:"participantCount,omitempty"`
}

// SnapshotDTO is the payload of presence.snapshot.
type SnapshotDTO struct {
	People []PresenceDTO `json:"people"`
}

// UpdateDTO is the payload of presence.update.
type UpdateDTO struct {
	Person PresenceDTO `json:"person"`
}

// Feed publishes presence to connected clients.
type Feed struct {
	hub       *realtime.Hub
	presence  *domain.PresenceService
	directory directory.Directory
	log       *slog.Logger
}

// New builds a Feed.
func New(hub *realtime.Hub, presence *domain.PresenceService, dir directory.Directory, log *slog.Logger) *Feed {
	if log == nil {
		log = slog.Default()
	}
	return &Feed{hub: hub, presence: presence, directory: dir, log: log}
}

// UserConnected marks a user available and tells the organisation.
func (f *Feed) UserConnected(ctx context.Context, user domain.User) {
	// A client being open is what "online" means in PLAN-1; a person can still
	// set themselves AWAY or DND afterwards.
	if err := f.presence.SetPersonal(user.ID, domain.PresenceAvailable); err != nil {
		f.log.WarnContext(ctx, "could not set presence on connect", "userId", string(user.ID), "error", err.Error())
		return
	}
	f.PublishUser(ctx, user)
}

// UserDisconnected marks a user offline once their last client goes away.
func (f *Feed) UserDisconnected(ctx context.Context, user domain.User) {
	if f.hub.ConnectionsForUser(user.ID) > 0 {
		// Another window is still open: the person is not offline.
		return
	}
	if err := f.presence.SetPersonal(user.ID, domain.PresenceOffline); err != nil {
		f.log.WarnContext(ctx, "could not set presence on disconnect", "userId", string(user.ID), "error", err.Error())
		return
	}
	f.PublishUser(ctx, user)
}

// PublishUser pushes one person's presence to everyone in their organisation,
// rendered separately for each recipient.
func (f *Feed) PublishUser(ctx context.Context, subject domain.User) {
	delivered := f.hub.BroadcastPerRecipient(subject.OrganisationID, func(recipient domain.UserID) (protocol.Envelope, bool) {
		dto, err := f.dtoFor(ctx, recipient, subject)
		if err != nil {
			return protocol.Envelope{}, false
		}
		env, err := protocol.NewEnvelope(TypePresenceUpdate, UpdateDTO{Person: dto})
		if err != nil {
			return protocol.Envelope{}, false
		}
		return env, true
	})
	f.log.DebugContext(ctx, "presence published",
		"userId", string(subject.ID), "recipients", delivered)
}

// PublishUserByID looks the user up before publishing.
func (f *Feed) PublishUserByID(ctx context.Context, id domain.UserID) {
	user, err := f.directory.UserByID(id)
	if err != nil {
		return
	}
	f.PublishUser(ctx, user)
}

// Snapshot renders everyone in the organisation for one viewer.
func (f *Feed) Snapshot(ctx context.Context, viewer domain.User) (protocol.Envelope, error) {
	people := make([]PresenceDTO, 0, 8)
	for _, subject := range f.directory.Users() {
		if subject.OrganisationID != viewer.OrganisationID {
			continue
		}
		dto, err := f.dtoFor(ctx, viewer.ID, subject)
		if err != nil {
			return protocol.Envelope{}, err
		}
		people = append(people, dto)
	}
	return protocol.NewEnvelope(TypePresenceSnapshot, SnapshotDTO{People: people})
}

func (f *Feed) dtoFor(ctx context.Context, viewer domain.UserID, subject domain.User) (PresenceDTO, error) {
	view, err := f.presence.ViewFor(ctx, viewer, subject.ID)
	if err != nil {
		return PresenceDTO{}, err
	}
	dto := PresenceDTO{
		UserID:           string(subject.ID),
		DisplayName:      subject.DisplayName,
		StatusMessage:    subject.StatusMessage,
		Personal:         string(view.Personal),
		Activity:         string(view.Activity),
		ParticipantCount: view.ParticipantCount,
		LayupTitle:       view.LayupTitle,
	}
	if view.LayupID != nil {
		dto.LayupID = string(*view.LayupID)
	}
	return dto, nil
}
