package httpapi

import (
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
)

// TokenResolver is the half of a directory that can answer for a bearer token.
// The development directory does not implement it, which is the point: a
// server running on the dev directory has no tokens to be stolen.
type TokenResolver interface {
	ResolveToken(token string) (domain.User, bool)
}

// forwardingHeaders are the markers a reverse proxy leaves on a request.
//
// We never read them to decide *who* the caller is - an attacker sets them
// freely, so they carry no authority. We read only their presence, and only to
// withdraw trust. That direction is safe: adding one of these headers can make
// the server treat you as more remote, never as more local.
var forwardingHeaders = []string{
	"Forwarded",
	"X-Forwarded-For",
	"X-Forwarded-Host",
	"X-Forwarded-Proto",
	"X-Real-Ip",
}

// bearerToken extracts a token from the Authorization header, if there is one.
func bearerToken(r *http.Request) string {
	header := r.Header.Get(HeaderAuthorization)
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

// isLocalCaller reports whether a request came from this machine directly.
//
// r.RemoteAddr alone is not enough to answer that. layup.blah.au terminates
// TLS in Caddy and proxies to 127.0.0.1:8787, so *every* request off the
// public internet arrives with a loopback peer address. Trusting loopback
// blindly would therefore leave the impersonation hole exactly as wide open as
// it was, just harder to see.
//
// So a caller counts as local only when the peer address is a loopback address
// *and* the request carries none of the headers a reverse proxy adds. Caddy's
// reverse_proxy sets X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host
// on every request by default, and our Caddyfile (deploy/vm/Caddyfile) does
// not strip them, so proxied traffic is disqualified. A remote attacker cannot
// escape the check by omitting the headers, because Caddy sets them whatever
// the client sent; and setting them deliberately only makes them less trusted.
func isLocalCaller(r *http.Request) bool {
	for _, header := range forwardingHeaders {
		if r.Header.Get(header) != "" {
			return false
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// authenticate resolves the caller from a bearer token, falling back to the
// declared development identity only where that cannot be an impersonation
// risk. It is the single place the rules live: both the REST middleware and
// the WebSocket upgrade call it, because two copies of an authentication rule
// is how one of them gets missed.
//
// The token is never echoed into an error: an error message is a log line
// waiting to happen.
func (s *Server) authenticate(r *http.Request) (Identity, error) {
	token := bearerToken(r)
	if token == "" {
		// The desktop's WebSocket client cannot set headers, so the handshake
		// carries the token on the URL instead. Nothing here logs the query.
		token = r.URL.Query().Get(protocol.QueryToken)
	}
	if token != "" {
		// Two resolvers, one decision point. A guest token is checked here,
		// beside registered credentials, rather than in a second place that
		// could disagree with this one about who the caller is.
		//
		// The registered directory is asked first: a guest token is minted by
		// this process and cannot collide with one, and asking in this order
		// means a guest can never shadow a member.
		if resolver, ok := s.directory.(TokenResolver); ok {
			if user, ok := resolver.ResolveToken(token); ok {
				return Identity{User: user}, nil
			}
		}
		if session, ok := s.guests.resolve(token); ok {
			return guestIdentity(session), nil
		}
		return Identity{}, fmt.Errorf("%w: unrecognised token", domain.ErrNotFound)
	}

	reference := r.Header.Get(HeaderDevUser)
	if reference == "" {
		reference = r.URL.Query().Get(protocol.QueryDevUser)
	}
	if reference == "" {
		return Identity{}, fmt.Errorf("%w: no credentials", domain.ErrNotFound)
	}
	// A declared identity is a claim with no proof behind it, so it is only
	// ever trustworthy on a developer's own machine.
	if s.cfg.Environment != "dev" && !isLocalCaller(r) {
		return Identity{}, fmt.Errorf("%w: %s is not accepted from a remote caller",
			domain.ErrNotFound, HeaderDevUser)
	}
	user, err := s.directory.Resolve(reference)
	if err != nil {
		return Identity{}, err
	}
	return Identity{User: user}, nil
}
