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
	"syscall"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/buildinfo"
	"github.com/layup-app/layup/services/control/internal/config"
	"github.com/layup-app/layup/services/control/internal/httpapi"
	"github.com/layup-app/layup/services/control/internal/logging"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "layup-control: %v\n", err)
		os.Exit(1)
	}
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

	server := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: logging.Middleware(log)(httpapi.New(cfg, httpapi.Options{Logger: log})),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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
