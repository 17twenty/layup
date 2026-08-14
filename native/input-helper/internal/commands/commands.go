// Package commands turns authenticated helper requests into injection calls.
//
// It is deliberately separate from the socket and the platform code so the
// routing and payload validation can be tested without a socket, without a
// platform, and - importantly - without moving anybody's real mouse.
package commands

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"

	"github.com/layup-app/layup/native/input-helper/internal/inject"
	"github.com/layup-app/layup/protocol"
)

// PointerMove positions the OS pointer at absolute screen coordinates.
//
// The desktop maps a normalised cursor position onto the presenter's display
// before sending, because only the presenter's machine knows its own geometry.
type PointerMove struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// PointerButton presses or releases a mouse button.
type PointerButton struct {
	Button string `json:"button"`
	Down   bool   `json:"down"`
}

// PointerWheel scrolls by whole lines.
type PointerWheel struct {
	DeltaX int `json:"deltaX"`
	DeltaY int `json:"deltaY"`
}

// Key presses or releases a key.
type Key struct {
	Code string `json:"code"`
	Down bool   `json:"down"`
}

// Handle executes one already-authenticated request.
//
// Every payload is validated here: the helper is the last line before the OS,
// so "it was signed" is not enough - it must also be sane.
func Handle(request protocol.HelperRequest, injector inject.Injector) protocol.HelperResponse {
	ok := protocol.HelperResponse{
		Version: protocol.HelperProtocolVersion,
		ID:      request.ID,
		OK:      true,
	}

	switch request.Command {
	case protocol.HelperCommandHello:
		return ok

	case protocol.HelperCommandCapabilities:
		payload, err := json.Marshal(injector.Capabilities())
		if err != nil {
			return fail(request, protocol.HelperErrMalformed, err)
		}
		ok.Payload = payload
		return ok

	case protocol.HelperCommandPointerMove:
		var move PointerMove
		if err := decode(request, &move); err != nil {
			return fail(request, protocol.HelperErrMalformed, err)
		}
		if !finite(move.X) || !finite(move.Y) {
			return fail(request, protocol.HelperErrMalformed, fmt.Errorf("x and y must be finite"))
		}
		if err := injector.MoveTo(move.X, move.Y); err != nil {
			return fail(request, protocol.HelperErrNotPermitted, err)
		}
		return ok

	case protocol.HelperCommandPointerButton:
		var button PointerButton
		if err := decode(request, &button); err != nil {
			return fail(request, protocol.HelperErrMalformed, err)
		}
		which, err := parseButton(button.Button)
		if err != nil {
			return fail(request, protocol.HelperErrMalformed, err)
		}
		if err := injector.Button(which, button.Down); err != nil {
			return fail(request, protocol.HelperErrNotPermitted, err)
		}
		return ok

	case protocol.HelperCommandPointerWheel:
		var wheel PointerWheel
		if err := decode(request, &wheel); err != nil {
			return fail(request, protocol.HelperErrMalformed, err)
		}
		// A runaway sender must not be able to scroll a thousand pages.
		if abs(wheel.DeltaX) > 120 || abs(wheel.DeltaY) > 120 {
			return fail(request, protocol.HelperErrMalformed, fmt.Errorf("wheel delta is out of range"))
		}
		if err := injector.Wheel(wheel.DeltaX, wheel.DeltaY); err != nil {
			return fail(request, protocol.HelperErrNotPermitted, err)
		}
		return ok

	case protocol.HelperCommandKey:
		var key Key
		if err := decode(request, &key); err != nil {
			return fail(request, protocol.HelperErrMalformed, err)
		}
		if key.Code == "" {
			return fail(request, protocol.HelperErrMalformed, fmt.Errorf("a key needs a code"))
		}
		if err := injector.Key(key.Code, key.Down); err != nil {
			return fail(request, protocol.HelperErrNotPermitted, err)
		}
		return ok

	case protocol.HelperCommandReleaseAll:
		injector.ReleaseAll()
		return ok

	default:
		// Unreachable: the allow-list runs first. Refuse rather than assume.
		return fail(request, protocol.HelperErrUnknownCommand,
			fmt.Errorf("%s is not handled", request.Command))
	}
}

func decode(request protocol.HelperRequest, target any) error {
	if len(request.Payload) == 0 {
		return fmt.Errorf("%s needs a payload", request.Command)
	}
	decoder := json.NewDecoder(bytes.NewReader(request.Payload))
	// Unknown fields are a protocol mismatch, not something to ignore.
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func parseButton(name string) (inject.Button, error) {
	switch inject.Button(name) {
	case inject.ButtonLeft:
		return inject.ButtonLeft, nil
	case inject.ButtonRight:
		return inject.ButtonRight, nil
	case inject.ButtonMiddle:
		return inject.ButtonMiddle, nil
	default:
		return "", fmt.Errorf("unknown mouse button %q", name)
	}
}

func fail(request protocol.HelperRequest, code string, err error) protocol.HelperResponse {
	return protocol.HelperResponse{
		Version: protocol.HelperProtocolVersion,
		ID:      request.ID,
		OK:      false,
		Code:    code,
		Error:   err.Error(),
	}
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
