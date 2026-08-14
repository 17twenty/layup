//go:build darwin && cgo

package inject

import (
	"os"
	"testing"
	"time"
)

// The unit tests below never post an event. Real injection moves the machine's
// actual pointer and posts a real click, so it is opt-in:
//
//	LAYUP_ALLOW_REAL_INPUT=1 go test ./internal/inject
//
// Never make this the default. A test suite that silently drives somebody's
// mouse is worse than an untested code path.
const allowRealInput = "LAYUP_ALLOW_REAL_INPUT"

func requireRealInput(t *testing.T) {
	t.Helper()
	if os.Getenv(allowRealInput) != "1" {
		t.Skipf("set %s=1 to run the real-injection proof (it moves your pointer)", allowRealInput)
	}
	if !New().(*darwinInjector).trusted() {
		t.Skip("Accessibility permission is not granted for the test runner")
	}
}

func TestCapabilitiesReportTheRealPermissionState(t *testing.T) {
	// Safe to run anywhere: reads the permission, injects nothing.
	capabilities := New().Capabilities()

	if capabilities.Platform != "darwin" {
		t.Fatalf("unexpected platform %q", capabilities.Platform)
	}
	if capabilities.Keyboard {
		t.Fatal("keyboard must not be claimed before P1-0504 implements it")
	}
	if capabilities.PointerMove != capabilities.PointerButton {
		t.Fatal("pointer move and button both depend on the same permission")
	}
	// Whichever way the permission falls, an unavailable capability must say
	// what to do about it.
	if !capabilities.PointerMove && capabilities.Detail == "" {
		t.Fatal("a missing permission needs an actionable explanation")
	}
}

func TestWithoutPermissionNothingIsPosted(t *testing.T) {
	if New().(*darwinInjector).trusted() {
		t.Skip("this runner has Accessibility permission; the refusal path is covered elsewhere")
	}
	injector := New()
	if err := injector.MoveTo(10, 10); err == nil {
		t.Fatal("a move without permission must return an error, not silently do nothing")
	}
	if err := injector.Button(ButtonLeft, true); err == nil {
		t.Fatal("a click without permission must return an error")
	}
}

func TestRealPointerCanBePositionedAndClicked(t *testing.T) {
	requireRealInput(t)

	injector := New()
	startX, startY := cursorPosition()
	// Put the pointer back where the person left it, whatever happens.
	defer func() {
		_ = injector.MoveTo(startX, startY)
	}()
	defer injector.ReleaseAll()

	targetX, targetY := startX+60, startY+40
	if err := injector.MoveTo(targetX, targetY); err != nil {
		t.Fatal(err)
	}
	if x, y := settled(); !near(x, targetX) || !near(y, targetY) {
		t.Fatalf("pointer did not move: wanted (%.0f, %.0f), got (%.0f, %.0f)", targetX, targetY, x, y)
	}

	// The middle button is used for the click proof because macOS applications
	// almost universally ignore it - the event is real, the side effects are not.
	if err := injector.Button(ButtonMiddle, true); err != nil {
		t.Fatal(err)
	}
	if !eventually(func() bool { return buttonDown(ButtonMiddle) }) {
		t.Fatal("the window server never saw the button go down")
	}
	if err := injector.Button(ButtonMiddle, false); err != nil {
		t.Fatal(err)
	}
	if !eventually(func() bool { return !buttonDown(ButtonMiddle) }) {
		t.Fatal("the button was never released")
	}

	// Right-click and wheel are posted at the same place.
	if err := injector.Button(ButtonRight, true); err != nil {
		t.Fatal(err)
	}
	if !eventually(func() bool { return buttonDown(ButtonRight) }) {
		t.Fatal("the window server never saw the right button go down")
	}
	// Released by ReleaseAll, which is the guarantee that matters on disconnect.
	if released := injector.ReleaseAll(); released != 1 {
		t.Fatalf("expected one held button to be released, got %d", released)
	}
	if !eventually(func() bool { return !buttonDown(ButtonRight) }) {
		t.Fatal("ReleaseAll left the right button held")
	}

	if err := injector.Wheel(0, -2); err != nil {
		t.Fatal(err)
	}
}

// settled reads the pointer after the window server has had a moment to apply
// the event; CGEventPost is asynchronous.
func settled() (x, y float64) {
	for attempt := 0; attempt < 50; attempt++ {
		x, y = cursorPosition()
		time.Sleep(10 * time.Millisecond)
		if nx, ny := cursorPosition(); nx == x && ny == y {
			return x, y
		}
	}
	return x, y
}

func eventually(condition func() bool) bool {
	for attempt := 0; attempt < 50; attempt++ {
		if condition() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// near allows a pixel of slack: a display with a scale factor can round.
func near(got, want float64) bool { return got-want < 1.5 && want-got < 1.5 }
