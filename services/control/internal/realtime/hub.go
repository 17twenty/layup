// Package realtime is the control plane's WebSocket fan-out: presence,
// membership, social requests and (later) signalling.
//
// It never carries media, cursor motion or input events - those live on the
// peer-to-peer data plane (ARCHITECTURE.md §3.2).
package realtime

import (
	"log/slog"
	"sync"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
)

// Sink is anything a hub can deliver an envelope to.
type Sink interface {
	ID() string
	UserID() domain.UserID
	OrganisationID() domain.OrganisationID
	// Send delivers without blocking the caller. A sink whose queue is full is
	// closed: a stalled client must never stall the control plane.
	Send(protocol.Envelope) bool
	Close(reason string)
}

// Hub tracks live connections and fans envelopes out to them.
type Hub struct {
	mu    sync.RWMutex
	conns map[string]Sink
	log   *slog.Logger
}

// NewHub builds an empty hub.
func NewHub(log *slog.Logger) *Hub {
	if log == nil {
		log = slog.Default()
	}
	return &Hub{conns: map[string]Sink{}, log: log}
}

// Add registers a connection.
func (h *Hub) Add(sink Sink) {
	h.mu.Lock()
	h.conns[sink.ID()] = sink
	count := len(h.conns)
	h.mu.Unlock()
	h.log.Info("realtime connection opened",
		"connectionId", sink.ID(),
		"userId", string(sink.UserID()),
		"organisationId", string(sink.OrganisationID()),
		"connections", count,
	)
}

// Remove deregisters a connection.
func (h *Hub) Remove(id string) {
	h.mu.Lock()
	sink, ok := h.conns[id]
	delete(h.conns, id)
	count := len(h.conns)
	h.mu.Unlock()
	if ok {
		h.log.Info("realtime connection closed",
			"connectionId", id,
			"userId", string(sink.UserID()),
			"connections", count,
		)
	}
}

// Connections returns the number of live connections.
func (h *Hub) Connections() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns)
}

// BroadcastToOrganisation sends to every connection in one organisation.
// The organisation boundary is enforced here, not by the caller.
func (h *Hub) BroadcastToOrganisation(org domain.OrganisationID, env protocol.Envelope) int {
	return h.send(env, func(s Sink) bool { return s.OrganisationID() == org })
}

// SendToUser sends to every connection belonging to one user (they may have
// more than one client open).
func (h *Hub) SendToUser(user domain.UserID, env protocol.Envelope) int {
	return h.send(env, func(s Sink) bool { return s.UserID() == user })
}

// SendToUsers sends to a set of users.
func (h *Hub) SendToUsers(users []domain.UserID, env protocol.Envelope) int {
	wanted := make(map[domain.UserID]bool, len(users))
	for _, u := range users {
		wanted[u] = true
	}
	return h.send(env, func(s Sink) bool { return wanted[s.UserID()] })
}

// BroadcastPerRecipient builds a separate envelope for each connection in an
// organisation. Presence is redacted per viewer, so one shared payload would
// leak private layup detail to someone not entitled to it (SPEC.md §5.3).
func (h *Hub) BroadcastPerRecipient(
	org domain.OrganisationID,
	build func(recipient domain.UserID) (protocol.Envelope, bool),
) int {
	h.mu.RLock()
	targets := make([]Sink, 0, len(h.conns))
	for _, sink := range h.conns {
		if sink.OrganisationID() == org {
			targets = append(targets, sink)
		}
	}
	h.mu.RUnlock()

	delivered := 0
	for _, sink := range targets {
		env, ok := build(sink.UserID())
		if !ok {
			continue
		}
		if sink.Send(env) {
			delivered++
			continue
		}
		h.log.Warn("dropping slow realtime connection",
			"connectionId", sink.ID(), "userId", string(sink.UserID()), "type", env.Type)
		sink.Close("client too slow")
	}
	return delivered
}

// ConnectionsForUser counts live connections belonging to one user.
func (h *Hub) ConnectionsForUser(user domain.UserID) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	count := 0
	for _, sink := range h.conns {
		if sink.UserID() == user {
			count++
		}
	}
	return count
}

func (h *Hub) send(env protocol.Envelope, match func(Sink) bool) int {
	h.mu.RLock()
	targets := make([]Sink, 0, len(h.conns))
	for _, sink := range h.conns {
		if match(sink) {
			targets = append(targets, sink)
		}
	}
	h.mu.RUnlock()

	delivered := 0
	for _, sink := range targets {
		if sink.Send(env) {
			delivered++
			continue
		}
		// Backpressure: a client that cannot keep up is disconnected rather
		// than allowed to grow an unbounded queue.
		h.log.Warn("dropping slow realtime connection",
			"connectionId", sink.ID(), "userId", string(sink.UserID()), "type", env.Type)
		sink.Close("client too slow")
	}
	return delivered
}
