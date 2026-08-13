package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

// HeaderVersion carries the protocol version on control-plane HTTP requests.
// Unversioned discovery endpoints (/healthz) deliberately do not require it, so
// a mismatched client can still learn what the server speaks.
const HeaderVersion = "X-Layup-Protocol-Version"

// Envelope is the single wire shape for every realtime and API message.
//
//	{"v":1,"type":"presence.update","id":"...","payload":{...}}
//
// `id` is optional and correlates a reply with its request.
type Envelope struct {
	Version int             `json:"v"`
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// ErrorCode is a stable machine-readable failure reason.
type ErrorCode string

const (
	// CodeUnsupportedProtocolVersion is returned when the peer speaks a version
	// this build cannot serve.
	CodeUnsupportedProtocolVersion ErrorCode = "unsupported_protocol_version"
	// CodeMalformedMessage is returned when a message cannot be parsed or is
	// missing required fields. Messages are never coerced into shape.
	CodeMalformedMessage ErrorCode = "malformed_message"
	// CodeUnknownMessageType is returned for a well-formed envelope carrying a
	// type this build does not implement.
	CodeUnknownMessageType ErrorCode = "unknown_message_type"
)

// TypeError is the envelope type used to report a failure to a peer.
const TypeError = "error"

// ErrorPayload is the body of a TypeError envelope.
type ErrorPayload struct {
	Code            ErrorCode `json:"code"`
	Message         string    `json:"message"`
	ServerVersion   int       `json:"serverVersion,omitempty"`
	ReceivedVersion int       `json:"receivedVersion,omitempty"`
}

// Sentinel errors so callers can branch without string matching.
var (
	ErrUnsupportedVersion = errors.New("unsupported protocol version")
	ErrMalformed          = errors.New("malformed message")
)

// Validate checks structural requirements and the version. It never repairs a
// message: an unsupported or malformed envelope is an error, not a default.
func (e Envelope) Validate() error {
	if e.Version == 0 {
		return fmt.Errorf("%w: missing protocol version", ErrMalformed)
	}
	if !SupportsVersion(e.Version) {
		return fmt.Errorf("%w: peer speaks v%d, this build speaks v%d", ErrUnsupportedVersion, e.Version, Version)
	}
	if e.Type == "" {
		return fmt.Errorf("%w: missing type", ErrMalformed)
	}
	return nil
}

// SupportsVersion reports whether this build can serve the given version.
// PLAN-1 speaks exactly one version; the helper exists so widening support
// later is a single change.
func SupportsVersion(v int) bool { return v == Version }

// Decode parses and validates an envelope.
func Decode(data []byte) (Envelope, error) {
	var e Envelope
	if err := json.Unmarshal(data, &e); err != nil {
		return Envelope{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if err := e.Validate(); err != nil {
		return Envelope{}, err
	}
	return e, nil
}

// NewEnvelope builds an envelope stamped with this build's version.
func NewEnvelope(msgType string, payload any) (Envelope, error) {
	e := Envelope{Version: Version, Type: msgType}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return Envelope{}, err
		}
		e.Payload = raw
	}
	return e, nil
}

// NewErrorEnvelope builds a TypeError envelope.
func NewErrorEnvelope(code ErrorCode, message string) Envelope {
	e, err := NewEnvelope(TypeError, ErrorPayload{Code: code, Message: message, ServerVersion: Version})
	if err != nil {
		// ErrorPayload always marshals; keep a usable envelope regardless.
		return Envelope{Version: Version, Type: TypeError}
	}
	return e
}

// DecodePayload unmarshals the payload of an envelope into v.
func DecodePayload(e Envelope, v any) error {
	if len(e.Payload) == 0 {
		return fmt.Errorf("%w: %s has no payload", ErrMalformed, e.Type)
	}
	if err := json.Unmarshal(e.Payload, v); err != nil {
		return fmt.Errorf("%w: %s payload: %v", ErrMalformed, e.Type, err)
	}
	return nil
}
