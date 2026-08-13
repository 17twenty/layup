package httpapi

import (
	"context"
	"errors"
	"fmt"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
)

// Signalling message types. The control plane relays these between two
// participants of the same layup and does nothing else with them: it never
// inspects, rewrites, stores or logs SDP or candidates, and it is never in the
// media path itself (ARCHITECTURE.md §3.2).
const (
	TypeSignalOffer     = "signal.offer"
	TypeSignalAnswer    = "signal.answer"
	TypeSignalCandidate = "signal.candidate"
	// TypeSignalBye ends a peer connection deliberately, so the far side can
	// tear down instead of waiting for ICE to fail.
	TypeSignalBye = "signal.bye"
)

// SignalDTO is the envelope payload for every signalling message.
type SignalDTO struct {
	LayupID string `json:"layupId"`
	// ToMembershipID is the intended recipient. Addressing by membership, not
	// user, keeps a rejoin from inheriting a half-finished negotiation.
	ToMembershipID string `json:"toMembershipId"`
	// FromMembershipID is filled in by the server. A client cannot claim to be
	// someone else.
	FromMembershipID string `json:"fromMembershipId,omitempty"`
	FromUserID       string `json:"fromUserId,omitempty"`
	// SDP carries an offer or answer; Candidate carries one ICE candidate.
	SDP           string `json:"sdp,omitempty"`
	Candidate     string `json:"candidate,omitempty"`
	SDPMid        string `json:"sdpMid,omitempty"`
	SDPMLineIndex *int   `json:"sdpMLineIndex,omitempty"`
	// Reason is used by signal.bye.
	Reason string `json:"reason,omitempty"`
}

// isSignalType reports whether a realtime message is signalling.
func isSignalType(msgType string) bool {
	switch msgType {
	case TypeSignalOffer, TypeSignalAnswer, TypeSignalCandidate, TypeSignalBye:
		return true
	}
	return false
}

// relaySignal validates and forwards one signalling message.
func (s *Server) relaySignal(ctx context.Context, sender domain.User, env protocol.Envelope) error {
	var payload SignalDTO
	if err := protocol.DecodePayload(env, &payload); err != nil {
		return err
	}
	if payload.LayupID == "" || payload.ToMembershipID == "" {
		return errors.New("a signalling message needs layupId and toMembershipId")
	}
	switch env.Type {
	case TypeSignalOffer, TypeSignalAnswer:
		if payload.SDP == "" {
			return errors.New(env.Type + " needs an sdp")
		}
	case TypeSignalCandidate:
		if payload.Candidate == "" {
			return errors.New("signal.candidate needs a candidate")
		}
	}

	view, err := s.layups.View(ctx, domain.LayupID(payload.LayupID))
	if err != nil {
		return err
	}

	// Both ends must currently be in that layup. Signalling is not a way to
	// reach someone who is not in the room with you.
	var fromMembership, toMembership *domain.Participant
	for i := range view.Participants {
		participant := view.Participants[i]
		if participant.LeftAt != nil {
			continue
		}
		if participant.UserID == sender.ID {
			fromMembership = &view.Participants[i]
		}
		if participant.MembershipID == domain.MembershipID(payload.ToMembershipID) {
			toMembership = &view.Participants[i]
		}
	}
	if fromMembership == nil {
		return fmt.Errorf("%w: you are not in that layup", domain.ErrForbidden)
	}
	if toMembership == nil {
		return fmt.Errorf("%w: that membership is not in the layup", domain.ErrNotFound)
	}
	if fromMembership.MembershipID == toMembership.MembershipID {
		return errors.New("a peer cannot signal itself")
	}

	// The server stamps the sender: a client cannot spoof who an offer is from.
	payload.FromMembershipID = string(fromMembership.MembershipID)
	payload.FromUserID = string(sender.ID)

	relayed, err := protocol.NewEnvelope(env.Type, payload)
	if err != nil {
		return err
	}
	delivered := s.hub.SendToUser(toMembership.UserID, relayed)

	// Route metadata only: no SDP, no candidates, ever.
	s.log.DebugContext(ctx, "relayed signalling message",
		"type", env.Type,
		"layupId", payload.LayupID,
		"fromMembershipId", payload.FromMembershipID,
		"toMembershipId", payload.ToMembershipID,
		"delivered", delivered,
	)
	if delivered == 0 {
		return fmt.Errorf("%w: that participant has no live connection", domain.ErrConflict)
	}
	return nil
}
