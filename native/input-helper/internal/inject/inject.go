// Package inject is the OS input-injection boundary.
//
// Everything platform-specific lives behind this interface, so the protocol,
// authentication and lifecycle code is identical on every platform and the
// per-platform code stays small enough to audit.
//
// PLAN-1 implements macOS and Windows (SPEC.md §17, Stage 5). Linux reports the
// capability as unavailable rather than pretending.
package inject

import "github.com/layup-app/layup/protocol"

// Button identifies a mouse button.
type Button string

const (
	ButtonLeft   Button = "left"
	ButtonRight  Button = "right"
	ButtonMiddle Button = "middle"
)

// Injector performs OS input. Implementations must be safe to call from one
// goroutine at a time and must track what they are holding down, so a
// disconnect can always release it (SPEC.md §13.3).
type Injector interface {
	Capabilities() protocol.HelperCapabilities
	// MoveTo positions the OS pointer at absolute screen coordinates.
	MoveTo(x, y float64) error
	// Button presses or releases a mouse button at the current position.
	Button(button Button, down bool) error
	// Wheel scrolls by a number of lines.
	Wheel(deltaX, deltaY int) error
	// Key presses or releases a key by its platform-independent code.
	Key(code string, down bool) error
	// ReleaseAll releases everything currently held and returns how many
	// things it released. It must be safe to call at any time.
	ReleaseAll() int
}

// unsupported is used on platforms with no implementation. It refuses honestly
// rather than silently doing nothing, so the desktop can explain why remote
// control is unavailable.
type unsupported struct{ platform, detail string }

func (u unsupported) Capabilities() protocol.HelperCapabilities {
	return protocol.HelperCapabilities{Platform: u.platform, Detail: u.detail}
}

func (u unsupported) MoveTo(float64, float64) error { return errUnsupported(u) }
func (u unsupported) Button(Button, bool) error     { return errUnsupported(u) }
func (u unsupported) Wheel(int, int) error          { return errUnsupported(u) }
func (u unsupported) Key(string, bool) error        { return errUnsupported(u) }
func (u unsupported) ReleaseAll() int               { return 0 }

type unsupportedError struct{ detail string }

func (e unsupportedError) Error() string { return e.detail }

func errUnsupported(u unsupported) error {
	return unsupportedError{detail: u.detail}
}
