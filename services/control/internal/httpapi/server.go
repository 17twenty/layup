// Package httpapi is the control-plane HTTP surface: commands, queries and the
// realtime upgrade endpoint. It is never in the 1:1 media path.
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/buildinfo"
	"github.com/layup-app/layup/services/control/internal/config"
	"github.com/layup-app/layup/services/control/internal/directory"
	"github.com/layup-app/layup/services/control/internal/domain"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
	"github.com/layup-app/layup/services/control/internal/realtime"
)

// Clock lets tests control time without sleeping.
type Clock func() time.Time

// Server owns the control-plane routes.
type Server struct {
	cfg       config.Config
	log       *slog.Logger
	now       Clock
	startedAt time.Time
	mux       *http.ServeMux
	directory directory.Directory
	layups    *domain.LayupService
	hub       *realtime.Hub
	presence  *domain.PresenceService
	feed      *presencefeed.Feed
	// heartbeatInterval is overridable so tests do not wait seconds.
	heartbeatInterval time.Duration
	onRealtimeReady   func(*realtime.Conn)
}

// Options configures a Server. Zero values fall back to production defaults.
type Options struct {
	Logger            *slog.Logger
	Now               Clock
	Directory         directory.Directory
	Layups            *domain.LayupService
	Hub               *realtime.Hub
	Presence          *domain.PresenceService
	HeartbeatInterval time.Duration
}

// New builds a Server with every route registered.
func New(cfg config.Config, opts Options) *Server {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	dir := opts.Directory
	if dir == nil {
		dir = directory.NewDev()
	}
	layups := opts.Layups
	if layups == nil {
		layups = domain.NewLayupService(domain.NewMemoryRepository(), domain.LayupServiceOptions{Logger: log})
	}
	hub := opts.Hub
	if hub == nil {
		hub = realtime.NewHub(log)
	}
	heartbeat := opts.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = realtime.DefaultHeartbeatInterval
	}
	presence := opts.Presence
	if presence == nil {
		presence = domain.NewPresenceService(layups, nil)
	}
	s := &Server{
		cfg:               cfg,
		log:               log,
		now:               now,
		startedAt:         now(),
		mux:               http.NewServeMux(),
		directory:         dir,
		layups:            layups,
		hub:               hub,
		presence:          presence,
		heartbeatInterval: heartbeat,
	}
	s.feed = presencefeed.New(hub, presence, dir, log)
	s.routes()
	return s
}

// Hub exposes the realtime fan-out so other components can publish to it.
func (s *Server) Hub() *realtime.Hub { return s.hub }

// Layups exposes the layup service for wiring and tests.
func (s *Server) Layups() *domain.LayupService { return s.layups }

// Presence exposes the presence service for wiring and tests.
func (s *Server) Presence() *domain.PresenceService { return s.presence }

func (s *Server) routes() {
	// Unversioned discovery: reachable by any client, including one whose
	// protocol version this build cannot serve.
	s.mux.HandleFunc("GET /healthz", s.handleHealth)

	// Versioned but unauthenticated: how a client learns what we speak.
	public := http.NewServeMux()
	public.HandleFunc("GET /api/protocol", s.handleProtocolInfo)

	// The realtime endpoint authenticates itself (handshake on the query
	// string), so it sits beside the versioned REST routes.
	s.mux.HandleFunc("GET /api/realtime", s.handleRealtime)

	// Everything else additionally requires a resolvable identity.
	authed := http.NewServeMux()
	authed.HandleFunc("GET /api/me", s.handleMe)
	authed.HandleFunc("GET /api/directory", s.handleDirectory)
	public.Handle("/api/", s.requireIdentity(authed))

	s.mux.Handle("/api/", s.requireProtocolVersion(public))
}

// ServeHTTP makes Server a plain http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// HealthResponse is the payload of GET /healthz.
type HealthResponse struct {
	Status          string         `json:"status"`
	ProtocolVersion int            `json:"protocolVersion"`
	Environment     string         `json:"environment"`
	UptimeSeconds   float64        `json:"uptimeSeconds"`
	Build           buildinfo.Info `json:"build"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, HealthResponse{
		Status:          "ok",
		ProtocolVersion: protocol.Version,
		Environment:     s.cfg.Environment,
		UptimeSeconds:   s.now().Sub(s.startedAt).Seconds(),
		Build:           buildinfo.Get(),
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Default().Error("failed to encode response", "error", err)
	}
}
