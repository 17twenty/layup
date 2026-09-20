package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
	"github.com/layup-app/layup/services/control/internal/logging"
)

// HeaderDevUser carries the development identity: a handle ("karl") or a user
// id. PLAN-1 has no password, token or identity provider - two local clients
// simply declare who they are. Anything stronger is PLAN-2 (SPEC.md §17).
const HeaderDevUser = "X-Layup-Dev-User"

// HeaderAuthorization carries a bearer token issued by registration.
const HeaderAuthorization = "Authorization"

// Identity is the authenticated caller.
type Identity struct {
	User domain.User
	// Guest is set only when the caller proved themselves with a guest token
	// rather than a registered credential. It is nil for everyone else, which
	// is what every existing consumer of IdentityFrom continues to see.
	Guest *GuestSession
}

// IsGuest reports whether this caller is a browser visitor who arrived by
// link, rather than someone this server knows.
func (i Identity) IsGuest() bool { return i.Guest != nil }

// OrganisationID is always taken from the directory entry, never from the
// request: a client cannot talk its way into another organisation.
func (i Identity) OrganisationID() domain.OrganisationID { return i.User.OrganisationID }

type identityContextKey struct{}

// IdentityFrom returns the caller identity attached by requireIdentity.
func IdentityFrom(ctx context.Context) (Identity, bool) {
	identity, ok := ctx.Value(identityContextKey{}).(Identity)
	return identity, ok
}

// requireIdentity resolves the caller for a request and rejects unknown or
// missing credentials. It runs inside the protocol-version guard, and defers
// every rule about who counts as authenticated to s.authenticate.
func (s *Server) requireIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity, err := s.authenticate(r)
		if err != nil {
			status := http.StatusUnauthorized
			if !errors.Is(err, domain.ErrNotFound) {
				status = http.StatusInternalServerError
			}
			s.writeAPIError(w, r, status, "unauthenticated", err.Error())
			return
		}

		// A guest is authorised by allow-list, and this is the single gate:
		// it runs before routing, so a route nobody remembered to list is
		// refused rather than reached (guest_auth.go).
		if identity.IsGuest() && !guestMayCall(r.Method, r.URL.Path, *identity.Guest) {
			s.writeAPIError(w, r, http.StatusForbidden, "forbidden",
				"a guest may not do that")
			return
		}

		user := identity.User
		ctx := context.WithValue(r.Context(), identityContextKey{}, identity)
		// Correlate every log line for this request with the caller.
		ctx = logging.WithFields(ctx,
			slog.String("userId", string(user.ID)),
			slog.String("organisationId", string(user.OrganisationID)),
		)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// writeAPIError renders a protocol error envelope with a stable code.
func (s *Server) writeAPIError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	s.log.WarnContext(r.Context(), "request rejected",
		"path", r.URL.Path, "status", status, "code", code)
	env, err := protocol.NewEnvelope(protocol.TypeError, map[string]any{
		"code":    code,
		"message": message,
	})
	if err != nil {
		http.Error(w, message, status)
		return
	}
	writeJSON(w, status, env)
}

// statusForDomainError maps domain sentinels onto HTTP.
func statusForDomainError(err error) (int, string) {
	switch {
	case errors.Is(err, domain.ErrInvalid):
		return http.StatusBadRequest, "invalid_request"
	case errors.Is(err, domain.ErrNotFound):
		return http.StatusNotFound, "not_found"
	case errors.Is(err, domain.ErrConflict):
		return http.StatusConflict, "conflict"
	case errors.Is(err, domain.ErrForbidden):
		return http.StatusForbidden, "forbidden"
	default:
		return http.StatusInternalServerError, "internal_error"
	}
}
