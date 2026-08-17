// Command control is the Layup control plane: identity, presence, layup
// membership, social requests and WebRTC signalling. It is never in the 1:1
// media path.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/buildinfo"
	"github.com/layup-app/layup/services/control/internal/config"
	"github.com/layup-app/layup/services/control/internal/directory"
	"github.com/layup-app/layup/services/control/internal/httpapi"
	"github.com/layup-app/layup/services/control/internal/logging"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "layup-control: %v\n", err)
		os.Exit(1)
	}
}

// openDirectory picks who this server's people are.
//
// A hosted directory - identities that register themselves and are remembered
// across restarts - needs somewhere to write them and a join code to gate who
// may write. With either missing there is nothing to host, so this falls back
// to the development directory, whose declared identities the server only
// honours from a genuinely local caller (httpapi/auth.go). That fallback is
// therefore safe but useless in production: a deployment that forgets
// LAYUP_JOIN_CODE or LAYUP_STATE_DIR is closed to everybody rather than open
// to everybody, and the startup log says which one is in force.
func openDirectory(cfg config.Config, log *slog.Logger) (directory.Directory, error) {
	if cfg.StateDir == "" || cfg.JoinCode == "" {
		log.Warn("using the development directory: nobody can register",
			"reason", "LAYUP_STATE_DIR and LAYUP_JOIN_CODE must both be set",
			"stateDir", cfg.StateDir, "joinCodeConfigured", cfg.JoinCode != "")
		return directory.NewDev(), nil
	}
	path := filepath.Join(cfg.StateDir, "identities.json")
	hosted, err := directory.NewHosted(path)
	if err != nil {
		return nil, err
	}
	// The path, never the code.
	log.Info("using the hosted directory", "identityStore", path,
		"identities", len(hosted.Users()))
	return hosted, nil
}

func run() error {
	cfg, err := config.LoadFromOS()
	if err != nil {
		return err
	}

	log := logging.New(logging.Options{Level: cfg.LogLevel, Format: cfg.LogFormat, Writer: os.Stdout})
	slog.SetDefault(log)
	build := buildinfo.Get()
	// Startup log carries build and listen address, never secrets.
	log.Info("starting layup control plane",
		"version", build.Version,
		"commit", build.Commit,
		"goVersion", build.GoVersion,
		"platform", build.Platform,
		"protocolVersion", protocol.Version,
		"listenAddr", cfg.ListenAddr,
		"environment", cfg.Environment,
	)

	dir, err := openDirectory(cfg, log)
	if err != nil {
		return err
	}

	api := httpapi.New(cfg, httpapi.Options{Logger: log, Directory: dir})
	server := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: logging.Middleware(log)(api),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Requests expire on their own deadline; this only decides how promptly
	// both sides are told.
	api.StartExpirySweeper(ctx, httpapi.DefaultExpirySweep)

	errCh := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Info("shutting down", "timeout", cfg.ShutdownTimeout.String())
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}
