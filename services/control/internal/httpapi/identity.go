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

// Identity is the authenticated caller.
type Identity struct {
	User domain.User
}

// OrganisationID is always taken from the directory entry, never from the
// request: a client cannot talk its way into another organisation.
func (i Identity) OrganisationID() domain.OrganisationID { return i.User.OrganisationID }

type identityContextKey struct{}

// IdentityFrom returns the caller identity attached by requireIdentity.
func IdentityFrom(ctx context.Context) (Identity, bool) {
	identity, ok := ctx.Value(identityContextKey{}).(Identity)
	return identity, ok
}

// requireIdentity resolves the development identity for a request and rejects
// unknown or missing ones. It runs inside the protocol-version guard.
func (s *Server) requireIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reference := r.Header.Get(HeaderDevUser)
		if reference == "" {
			s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated",
				"missing "+HeaderDevUser+" header")
			return
		}
		user, err := s.directory.Resolve(reference)
		if err != nil {
			status := http.StatusUnauthorized
			if !errors.Is(err, domain.ErrNotFound) {
				status = http.StatusInternalServerError
			}
			s.writeAPIError(w, r, status, "unauthenticated", err.Error())
			return
		}

		identity := Identity{User: user}
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
