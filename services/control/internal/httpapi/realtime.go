package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/coder/websocket"
	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
	"github.com/layup-app/layup/services/control/internal/logging"
	"github.com/layup-app/layup/services/control/internal/realtime"
)

// handleRealtime upgrades to WSS.
//
// The handshake travels on the query string because the WebSocket client in the
// desktop runtime cannot set request headers. Headers are still honoured when
// present, so tooling like curl behaves the same way. Neither the query string
// nor the error text is ever logged, because both can carry a token.
func (s *Server) handleRealtime(w http.ResponseWriter, r *http.Request) {
	version, err := realtimeVersion(r)
	if err != nil {
		s.writeProtocolError(w, r, http.StatusBadRequest, protocol.CodeMalformedMessage, err.Error(), 0)
		return
	}
	if !protocol.SupportsVersion(version) {
		s.writeProtocolError(w, r, http.StatusUpgradeRequired, protocol.CodeUnsupportedProtocolVersion,
			"client speaks v"+strconv.Itoa(version)+", this server speaks v"+strconv.Itoa(protocol.Version), version)
		return
	}

	// The same authenticator as the REST routes, deliberately: the upgrade
	// endpoint sits outside requireIdentity, and a second copy of the rules
	// here is how one of them would get missed.
	identity, err := s.authenticate(r)
	if err != nil {
		status := http.StatusUnauthorized
		if !errors.Is(err, domain.ErrNotFound) {
			status = http.StatusInternalServerError
		}
		s.writeAPIError(w, r, status, "unauthenticated", err.Error())
		return
	}
	// A guest is allowed here, deliberately and by name: signalling is how
	// their peer connection forms, so refusing the socket would refuse the
	// call itself. It is the one thing outside guestMayCall's list
	// (guest_auth.go), and what they may do once connected is narrowed below.
	user := identity.User
	isGuest := identity.IsGuest()

	socket, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The desktop connects from a file:// or vite origin; the origin check
		// is handled by the configured allow-list, empty meaning desktop-only.
		OriginPatterns:     originPatterns(s.cfg.AllowedOrigins),
		InsecureSkipVerify: len(s.cfg.AllowedOrigins) == 0,
	})
	if err != nil {
		s.log.WarnContext(r.Context(), "realtime upgrade failed", "error", err.Error())
		return
	}

	connectionID := logging.NewID()
	ctx := logging.WithFields(r.Context())
	s.log.InfoContext(ctx, "realtime client connected",
		"connectionId", connectionID, "userId", string(user.ID))

	serveCtx := context.WithoutCancel(ctx)
	realtime.Serve(serveCtx, socket, connectionID, user, s.hub, realtime.ServeOptions{
		Logger:            s.log,
		HeartbeatInterval: s.heartbeatInterval,
		OnReady: func(conn *realtime.Conn) {
			if isGuest {
				// A guest gets no presence, ever: not a snapshot, and not the
				// connect/disconnect publications that would follow. The
				// snapshot is the sharper edge of the two - it is built from
				// directory.Users() and would hand a stranger the whole
				// organisation roster in one message, which is precisely what
				// a link must never be worth.
				return
			}
			// The client sees the whole picture first, then only deltas.
			if snapshot, err := s.feed.Snapshot(serveCtx, conn.User()); err == nil {
				conn.Send(snapshot)
			} else {
				s.log.WarnContext(serveCtx, "could not build presence snapshot", "error", err.Error())
			}
			s.feed.UserConnected(serveCtx, conn.User())
		},
		OnMessage: s.handleRealtimeMessage,
		OnClosed: func(conn *realtime.Conn) {
			if isGuest {
				// Nothing was published when they arrived, so there is
				// nothing to retract. A guest is not a person the
				// organisation is told about.
				return
			}
			s.feed.UserDisconnected(serveCtx, conn.User())
		},
	})
}

// handleRealtimeMessage handles client-originated realtime messages.
func (s *Server) handleRealtimeMessage(ctx context.Context, conn *realtime.Conn, env protocol.Envelope) error {
	switch env.Type {
	case TypePresenceSet:
		if s.isGuestUser(conn.UserID()) {
			// Presence is an organisation-wide surface. A guest neither reads
			// it nor writes to it; signalling is all this socket is for them.
			return fmt.Errorf("%w: a guest may not publish presence", domain.ErrForbidden)
		}
		var payload struct {
			Personal string `json:"personal"`
		}
		if err := protocol.DecodePayload(env, &payload); err != nil {
			return err
		}
		state := domain.PersonalPresence(payload.Personal)
		if err := s.presence.SetPersonal(conn.UserID(), state); err != nil {
			return err
		}
		s.feed.PublishUser(ctx, conn.User())
		return nil
	default:
		if isSignalType(env.Type) {
			return s.relaySignal(ctx, conn.User(), env)
		}
		return errors.New("unsupported message type " + env.Type)
	}
}

// TypePresenceSet lets a client say AVAILABLE/AWAY/DND about itself.
const TypePresenceSet = "presence.set"

func realtimeVersion(r *http.Request) (int, error) {
	raw := r.Header.Get(protocol.HeaderVersion)
	if raw == "" {
		raw = r.URL.Query().Get(protocol.QueryProtocolVersion)
	}
	if raw == "" {
		return 0, errors.New("missing protocol version (" + protocol.HeaderVersion + " header or ?v=)")
	}
	version, err := strconv.Atoi(raw)
	if err != nil || version < 1 {
		return 0, errors.New("protocol version must be a positive integer")
	}
	return version, nil
}

func originPatterns(allowed []string) []string {
	if len(allowed) == 0 {
		return nil
	}
	out := make([]string, 0, len(allowed))
	for _, origin := range allowed {
		out = append(out, stripScheme(origin))
	}
	return out
}

func stripScheme(origin string) string {
	for _, prefix := range []string{"https://", "http://"} {
		if len(origin) > len(prefix) && origin[:len(prefix)] == prefix {
			return origin[len(prefix):]
		}
	}
	return origin
}
