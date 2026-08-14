package protocol

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
)

// The native input helper protocol (ADR-0006, SPEC.md §13.2).
//
// The helper is the only component that can inject OS input. It therefore
// speaks a deliberately tiny, explicitly versioned protocol over a local socket,
// authenticated with a per-run secret that only the Electron main process
// knows. The renderer never has the secret, never has the socket path, and
// cannot reach the helper except through the narrow main-process flow.

// HelperProtocolVersion is independent of the wire protocol between desktop and
// control plane: the helper ships with the desktop and they upgrade together.
const HelperProtocolVersion = 1

// Helper command names. Anything not on this list is rejected outright, so a
// new capability cannot be smuggled in by a crafted message.
const (
	HelperCommandHello         = "helper.hello"
	HelperCommandCapabilities  = "helper.capabilities"
	HelperCommandPointerMove   = "pointer.move"
	HelperCommandPointerButton = "pointer.button"
	HelperCommandPointerWheel  = "pointer.wheel"
	HelperCommandKey           = "key"
	HelperCommandReleaseAll    = "input.release_all"
)

// AllowedHelperCommands is the complete set the helper will act on.
var AllowedHelperCommands = map[string]bool{
	HelperCommandHello:         true,
	HelperCommandCapabilities:  true,
	HelperCommandPointerMove:   true,
	HelperCommandPointerButton: true,
	HelperCommandPointerWheel:  true,
	HelperCommandKey:           true,
	HelperCommandReleaseAll:    true,
}

// HelperRequest is one command sent to the helper.
type HelperRequest struct {
	Version int             `json:"v"`
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Payload json.RawMessage `json:"payload,omitempty"`
	// Auth is an HMAC over version, id and command, proving the sender holds
	// the session secret. A stolen socket connection without the secret is
	// useless.
	Auth string `json:"auth"`
}

// HelperResponse is the helper's reply.
type HelperResponse struct {
	Version int             `json:"v"`
	ID      string          `json:"id"`
	OK      bool            `json:"ok"`
	Error   string          `json:"error,omitempty"`
	Code    string          `json:"code,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Helper error codes.
const (
	HelperErrUnauthenticated = "unauthenticated"
	HelperErrUnknownCommand  = "unknown_command"
	HelperErrUnsupported     = "unsupported_platform"
	HelperErrMalformed       = "malformed"
	HelperErrNotPermitted    = "not_permitted"
)

var (
	// ErrHelperUnauthenticated means the request did not prove it holds the secret.
	ErrHelperUnauthenticated = errors.New("helper: unauthenticated request")
	// ErrHelperUnknownCommand means the command is not on the allow-list.
	ErrHelperUnknownCommand = errors.New("helper: unknown command")
	// ErrHelperMalformed means the request could not be understood.
	ErrHelperMalformed = errors.New("helper: malformed request")
)

// SignHelperRequest computes the auth tag for a request.
func SignHelperRequest(secret string, version int, id, command string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d\n%s\n%s", version, id, command)
	return fmt.Sprintf("%x", mac.Sum(nil))
}

// VerifyHelperRequest checks version, authentication and the command allow-list,
// in that order. It is the only way a request becomes actionable.
func VerifyHelperRequest(secret string, request HelperRequest) error {
	if request.Version != HelperProtocolVersion {
		return fmt.Errorf("%w: helper speaks v%d, got v%d",
			ErrHelperMalformed, HelperProtocolVersion, request.Version)
	}
	if request.ID == "" || request.Command == "" {
		return fmt.Errorf("%w: id and command are required", ErrHelperMalformed)
	}
	expected := SignHelperRequest(secret, request.Version, request.ID, request.Command)
	// Constant time: an attacker must not be able to discover the tag byte by byte.
	if !hmac.Equal([]byte(expected), []byte(request.Auth)) {
		return ErrHelperUnauthenticated
	}
	if !AllowedHelperCommands[request.Command] {
		return fmt.Errorf("%w: %q", ErrHelperUnknownCommand, request.Command)
	}
	return nil
}

// HelperCapabilities describes what this helper build can actually do.
type HelperCapabilities struct {
	Platform      string `json:"platform"`
	PointerMove   bool   `json:"pointerMove"`
	PointerButton bool   `json:"pointerButton"`
	PointerWheel  bool   `json:"pointerWheel"`
	Keyboard      bool   `json:"keyboard"`
	// Detail explains a missing capability in words a person can act on, e.g.
	// an unticked accessibility permission.
	Detail string `json:"detail,omitempty"`
}
