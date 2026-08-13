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
}

// Options configures a Server. Zero values fall back to production defaults.
type Options struct {
	Logger    *slog.Logger
	Now       Clock
	Directory directory.Directory
	Layups    *domain.LayupService
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
	s := &Server{
		cfg:       cfg,
		log:       log,
		now:       now,
		startedAt: now(),
		mux:       http.NewServeMux(),
		directory: dir,
		layups:    layups,
	}
	s.routes()
	return s
}

func (s *Server) routes() {
	// Unversioned discovery: reachable by any client, including one whose
	// protocol version this build cannot serve.
	s.mux.HandleFunc("GET /healthz", s.handleHealth)

	// Versioned but unauthenticated: how a client learns what we speak.
	public := http.NewServeMux()
	public.HandleFunc("GET /api/protocol", s.handleProtocolInfo)

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
