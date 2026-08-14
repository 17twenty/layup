// Command layup-input-helper is the only component permitted to inject OS
// input (ADR-0006, SPEC.md §13.2).
//
// It is a separate process on purpose. The Electron renderer never reaches it:
// the renderer has no socket path, no session secret, and no IPC channel that
// forwards to it. The Electron main process starts it with a per-run secret on
// its environment and talks to it over a local socket.
//
// It reads newline-delimited JSON requests and writes newline-delimited JSON
// responses. Every request is authenticated and checked against an allow-list
// before anything happens.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/layup-app/layup/native/input-helper/internal/commands"
	"github.com/layup-app/layup/native/input-helper/internal/inject"
	"github.com/layup-app/layup/protocol"
)

const (
	// envSecret carries the per-run session secret from the desktop. It is
	// never written to disk and never passed on the command line, where other
	// processes could read it.
	envSecret = "LAYUP_HELPER_SECRET"
	// envSocket is where the helper listens.
	envSocket = "LAYUP_HELPER_SOCKET"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	secret := os.Getenv(envSecret)
	socketPath := os.Getenv(envSocket)
	if secret == "" || socketPath == "" {
		fmt.Fprintf(os.Stderr, "layup-input-helper: %s and %s are required\n", envSecret, envSocket)
		os.Exit(2)
	}
	// The secret lives only in this process's memory from here on.
	_ = os.Unsetenv(envSecret)

	// A stale socket from a crashed run would stop us binding.
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "layup-input-helper: cannot listen on %s: %v\n", socketPath, err)
		os.Exit(1)
	}
	defer listener.Close()
	// Owner-only: another user on the machine cannot even connect.
	if err := os.Chmod(socketPath, 0o600); err != nil {
		log.Warn("could not restrict socket permissions", "error", err.Error())
	}

	injector := inject.New()
	log.Info("input helper listening",
		"socket", socketPath,
		"platform", runtime.GOOS,
		"protocolVersion", protocol.HelperProtocolVersion,
		"capabilities", injector.Capabilities(),
	)

	// Exit with the desktop: closing the listener ends Accept below.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		<-signals
		log.Info("input helper shutting down")
		_ = listener.Close()
		_ = os.Remove(socketPath)
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Warn("accept failed", "error", err.Error())
			continue
		}
		go serve(conn, secret, injector, log)
	}
}

func serve(conn net.Conn, secret string, injector inject.Injector, log *slog.Logger) {
	defer conn.Close()
	// A disconnecting controller must never leave a key or button held down.
	defer func() {
		if released := injector.ReleaseAll(); released > 0 {
			log.Warn("released stuck input after disconnect", "count", released)
		}
	}()

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 4096), 64*1024)
	encoder := json.NewEncoder(conn)

	for scanner.Scan() {
		var request protocol.HelperRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			_ = encoder.Encode(protocol.HelperResponse{
				Version: protocol.HelperProtocolVersion,
				OK:      false,
				Code:    protocol.HelperErrMalformed,
				Error:   "request is not valid JSON",
			})
			continue
		}

		if err := protocol.VerifyHelperRequest(secret, request); err != nil {
			// Never echo the payload of a rejected request: it may contain
			// keystrokes we must not log or reflect (SPEC.md §13.4).
			log.Warn("rejected helper request",
				"id", request.ID, "command", request.Command, "reason", codeFor(err))
			_ = encoder.Encode(protocol.HelperResponse{
				Version: protocol.HelperProtocolVersion,
				ID:      request.ID,
				OK:      false,
				Code:    codeFor(err),
				Error:   err.Error(),
			})
			continue
		}

		_ = encoder.Encode(commands.Handle(request, injector))
	}
}

func codeFor(err error) string {
	switch {
	case errors.Is(err, protocol.ErrHelperUnauthenticated):
		return protocol.HelperErrUnauthenticated
	case errors.Is(err, protocol.ErrHelperUnknownCommand):
		return protocol.HelperErrUnknownCommand
	default:
		return protocol.HelperErrMalformed
	}
}
