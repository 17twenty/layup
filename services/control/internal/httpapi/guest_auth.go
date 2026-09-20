package httpapi

import (
	"net/http"
	"strings"

	"github.com/layup-app/layup/services/control/internal/domain"
)

// A guest is a stranger holding a URL. Everything in this file exists to make
// that sentence safe.
//
// Two rules carry the whole containment design, and both are stated here
// rather than spread across handlers:
//
//  1. A guest belongs to no organisation. Not the layup's organisation - none.
//     Every organisation-scoped fan-out in this service (presence, the
//     directory, the Happening Now list) selects its audience by organisation
//     id, so a guest misses all of them by construction rather than because
//     someone remembered to write a check. See guestOrganisationID.
//
//  2. A guest may make exactly the requests named in guestMayCall, and
//     nothing else. It is an allow-list: a route added tomorrow by someone who
//     has never heard of guests is refused by default.

// guestIdentity renders a guest session as a caller.
//
// The user it builds is not in any directory and never will be: it exists so
// that handlers written for a registered caller have something of the right
// shape to read, not so that a guest can pass for a member.
func guestIdentity(session GuestSession) Identity {
	return Identity{
		User: domain.User{
			ID:             session.UserID,
			OrganisationID: guestOrganisationID(session.UserID),
			DisplayName:    session.DisplayName,
		},
		Guest: &session,
	}
}

// guestOrganisationID gives a guest an organisation of exactly one: themselves.
//
// The alternative - handing the guest the layup's organisation id - would make
// every organisation-scoped broadcast in the server deliver to them, and the
// roster would then be kept private only by whatever checks we remembered to
// add afterwards. presencefeed fans out with
// hub.BroadcastPerRecipient(subject.OrganisationID, ...) and renders its
// snapshot from directory.Users() filtered by the viewer's organisation; with
// an organisation of one, both return nothing for a guest without knowing
// guests exist. A leak would need someone to deliberately widen this, not
// merely to forget something.
//
// The id is derived from the guest's own user id, so it is unique per guest
// (two guests in one layup are not in one organisation either) and stable for
// the life of the session. It is shaped like a real organisation id - org_ and
// a body from the same alphabet - so nothing downstream chokes on it, but it
// names no organisation that exists.
func guestOrganisationID(userID domain.UserID) domain.OrganisationID {
	return domain.OrganisationID("org_" + strings.TrimPrefix(string(userID), "usr_"))
}

// guestMayCall is the complete list of REST requests a guest session may make.
//
// It is matched against the request itself, not against a route pattern,
// because a pattern is a promise about routing and this is a promise about
// authority. Scope is compared against the session's own LayupID - a
// server-issued value the caller cannot influence - so a guest cannot read or
// leave a layup other than the one their link let them into.
//
// The realtime endpoint is the fourth thing a guest may reach. It is not
// listed here because it is registered outside requireIdentity (it
// authenticates its own handshake); handleRealtime admits guests explicitly,
// and refuses them everything on that socket except signalling.
func guestMayCall(method, path string, session GuestSession) bool {
	layup := string(session.LayupID)
	if layup == "" {
		// A session with no layup has no scope, so nothing is in scope.
		return false
	}
	switch {
	case method == http.MethodGet && path == "/api/turn":
		return true
	case method == http.MethodGet && path == "/api/layups/"+layup:
		return true
	case method == http.MethodPost && path == "/api/layups/"+layup+"/leave":
		return true
	default:
		return false
	}
}

// isGuestUser reports whether a user id belongs to a live guest session. It is
// how code holding only a realtime connection - which carries a user, not an
// identity - can still tell a guest from a member.
func (s *Server) isGuestUser(id domain.UserID) bool {
	_, ok := s.guests.sessionForUser(id)
	return ok
}
