package httpapi

import (
	"fmt"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/layup-app/layup/services/control/internal/domain"
)

// maxGuestNameLength bounds the one piece of text a guest is allowed to put in
// front of other people's eyes. Long enough for a real name, short enough that
// nobody can use it as a billboard in someone else's call.
const maxGuestNameLength = 60

// guestJoinRequest is the body of POST /api/guest/join.
//
// The link token travels in the body for the same reason it does everywhere
// else now: Caddy's access-log filter redacts query strings but not paths, so
// a token in the URL would be written to disk in cleartext on every join.
type guestJoinRequest struct {
	Token       string `json:"token"`
	DisplayName string `json:"displayName"`
}

// GuestJoinDTO is what redeeming a link gets you: proof of who you now are, the
// room you are in, which participant is you, and how to reach the other side.
//
// Everything a browser needs to start a call arrives in this one response, so
// a guest is never left holding a seat they cannot connect from.
type GuestJoinDTO struct {
	GuestToken   string         `json:"guestToken"`
	Layup        LayupDTO       `json:"layup"`
	MembershipID string         `json:"membershipId"`
	IceServers   []IceServerDTO `json:"iceServers"`
}

// handleGuestJoin redeems an invitation link as a browser visitor.
//
// This is the only public route that creates anything, so it is written to
// give a stranger as little as possible: one message for every way a link can
// fail, no hint about whether the layup exists, and no credential beyond a
// session scoped to that single layup (guest_auth.go).
func (s *Server) handleGuestJoin(w http.ResponseWriter, r *http.Request) {
	if !s.directory.Organisation().Policy.LinkLayupsAllowed {
		// A policy fact about this deployment, not about any layup: an
		// operator who has turned links off wants the browser to say so
		// plainly rather than blame the link.
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden",
			"this server does not admit guests")
		return
	}

	var body guestJoinRequest
	if err := decodeJSON(r, &body); err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	name, err := guestDisplayName(body.DisplayName)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	record, ok := s.links.resolve(body.Token)
	if !ok {
		s.refuseGuestLink(w, r)
		return
	}
	view, err := s.layups.View(r.Context(), record.layupID)
	if err != nil || !view.Active() {
		// Unknown, revoked, expired, ended: one answer for all of them. A
		// stranger with a guessed token learns nothing about what is or was
		// happening here.
		s.refuseGuestLink(w, r)
		return
	}

	// A guest user id is minted per redemption, so two people opening the same
	// link are two different participants - not one seat they fight over.
	userID := newGuestUserID()
	joined, membership, err := s.layups.Join(r.Context(), record.layupID, userID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	session, err := s.guests.create(record.layupID, membership.ID, userID, name)
	if err != nil {
		s.writeAPIError(w, r, http.StatusInternalServerError, "internal_error",
			"could not start a guest session")
		return
	}

	// The layup DTO is rendered after the session exists, so the guest is
	// already named in the participant list everyone is about to receive.
	guest := guestIdentity(session)
	s.afterLayupChange(r.Context(), joined, guest.User)

	// Neither token is ever logged: not the link that was redeemed, not the
	// session that was issued.
	s.log.InfoContext(r.Context(), "guest joined by link",
		"layupId", string(record.layupID),
		"userId", string(userID),
		"membershipId", string(membership.ID),
	)

	expiresAt := s.now().Add(DefaultTurnCredentialTTL)
	s.writeEnvelope(w, r, "guest.joined", GuestJoinDTO{
		GuestToken:   session.Token,
		Layup:        s.layupDTO(joined),
		MembershipID: string(membership.ID),
		IceServers:   s.iceServers(userID, expiresAt),
	})
}

// refuseGuestLink is the single refusal for every way a link can fail to open.
// Keeping it in one place is what stops it drifting into an oracle.
func (s *Server) refuseGuestLink(w http.ResponseWriter, r *http.Request) {
	s.writeAPIError(w, r, http.StatusForbidden, "invalid_link",
		"this invitation link is not valid any more - ask for a new one")
}

// guestDisplayName cleans and checks the name a guest gives themselves.
//
// This name is the only thing the people already in the call will know them
// by, and the only string a stranger can put on their screens - so it must be
// present, it must be readable, and it must be short. Control characters are
// refused rather than stripped: a name that renders differently from what was
// typed is its own small deception.
func guestDisplayName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("%w: tell the others what to call you", domain.ErrInvalid)
	}
	if !utf8.ValidString(name) {
		return "", fmt.Errorf("%w: that name is not valid text", domain.ErrInvalid)
	}
	if utf8.RuneCountInString(name) > maxGuestNameLength {
		return "", fmt.Errorf("%w: that name is too long", domain.ErrInvalid)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("%w: that name contains characters that cannot be displayed",
				domain.ErrInvalid)
		}
	}
	return name, nil
}
