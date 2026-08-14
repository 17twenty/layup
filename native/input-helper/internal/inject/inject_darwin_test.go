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
	if capabilities.Keyboard != capabilities.PointerMove {
		t.Fatal("keyboard and pointer both depend on the same Accessibility grant")
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
	if err := injector.Key("KeyA", true); err == nil {
		t.Fatal("a keystroke without permission must return an error")
	}
}

func TestUnknownKeysAreRefusedRatherThanGuessed(t *testing.T) {
	// A wrong key code types the wrong thing into somebody else's machine, so
	// an unmapped code is an error even before the permission check matters.
	injector := New()
	for _, code := range []string{"", "KeyÅ", "F19", "Again", "MediaPlay"} {
		if err := injector.Key(code, true); err == nil {
			t.Fatalf("%q should have been refused", code)
		}
	}
}

func TestKeyMapCoversTypingAndShortcuts(t *testing.T) {
	// Enough to type, navigate and drive the usual shortcuts.
	for _, code := range []string{
		"KeyA", "KeyZ", "Digit0", "Digit9", "Space", "Enter", "Tab", "Backspace",
		"Escape", "Minus", "Equal", "Comma", "Period", "Slash", "Semicolon",
		"Quote", "BracketLeft", "BracketRight", "Backslash", "Backquote",
		"ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End",
		"PageUp", "PageDown", "Delete", "F1", "F12",
		"ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
		"AltLeft", "AltRight", "MetaLeft", "MetaRight",
	} {
		if _, known := darwinKeyCodes[code]; !known {
			t.Errorf("%s is missing from the key map", code)
		}
	}

	// No two codes may share a virtual key code, or one of them types the wrong
	// character.
	seen := map[int]string{}
	for code, virtual := range darwinKeyCodes {
		if previous, clash := seen[virtual]; clash {
			t.Errorf("%s and %s both map to virtual key %d", code, previous, virtual)
		}
		seen[virtual] = code
	}
}

func TestBothPlatformsSpeakTheSameKeyVocabulary(t *testing.T) {
	// One protocol, two platforms: a guest on macOS controlling Windows sends
	// the same KeyboardEvent.code either way, so a key either platform cannot
	// map is a key that silently stops working across the pair.
	for code := range darwinKeyCodes {
		if _, _, known := windowsScanCode(code); !known {
			// Keys with no PC equivalent are the exception, not a gap.
			if code == "NumpadEqual" {
				continue
			}
			t.Errorf("%s is mapped on macOS but not on Windows", code)
		}
	}
	for code := range windowsScanCodes {
		if _, known := darwinKeyCodes[code]; !known {
			// Keys with no Mac equivalent.
			if code == "NumLock" || code == "ScrollLock" {
				continue
			}
			t.Errorf("%s is mapped on Windows but not on macOS", code)
		}
	}
}

func TestModifiersAreCarriedAsFlagsNotJustKeystrokes(t *testing.T) {
	// Cmd+C is a *flag* on the 'c' event. Posting three plain key events would
	// arrive as a bare 'c' - which, in an editor, replaces the selection.
	injector := New().(*darwinInjector)

	injector.trackKey("MetaLeft", true)
	if injector.flags()&flagCommand == 0 {
		t.Fatal("holding Cmd must set the command flag")
	}
	injector.trackKey("ShiftLeft", true)
	if injector.flags()&flagShift == 0 || injector.flags()&flagCommand == 0 {
		t.Fatal("two held modifiers must combine")
	}
	injector.trackKey("ShiftLeft", false)
	if injector.flags()&flagShift != 0 {
		t.Fatal("releasing Shift must clear its flag")
	}
	if injector.flags()&flagCommand == 0 {
		t.Fatal("releasing Shift must not clear Cmd")
	}

	// Caps Lock latches; "releasing" it on disconnect would toggle it on.
	injector.trackKey("CapsLock", true)
	for _, held := range injector.heldKeys {
		if held == "CapsLock" {
			t.Fatal("Caps Lock must not be tracked as held")
		}
	}
}

func TestEveryKeyDownHasACleanupPath(t *testing.T) {
	injector := New().(*darwinInjector)

	// Whatever the guest was holding when the connection dropped.
	injector.trackKey("MetaLeft", true)
	injector.trackKey("ShiftLeft", true)
	injector.trackKey("KeyA", true)
	injector.held[ButtonLeft] = true

	// Untrusted here, so nothing is posted - but the release *order* is the
	// guarantee under test: reverse press order, so an intermediate release is
	// never seen as a bare keystroke.
	order := releaseOrder(injector)
	want := []string{"KeyA", "ShiftLeft", "MetaLeft"}
	for index, code := range want {
		if order[index] != code {
			t.Fatalf("expected release order %v, got %v", want, order)
		}
	}

	// A key released normally is no longer owed a cleanup.
	injector.trackKey("KeyA", false)
	if len(injector.heldKeys) != 2 {
		t.Fatalf("a released key must be forgotten, still holding %v", injector.heldKeys)
	}
}

// releaseOrder mirrors the order ReleaseAll walks, without posting events.
func releaseOrder(injector *darwinInjector) []string {
	order := make([]string, 0, len(injector.heldKeys))
	for index := len(injector.heldKeys) - 1; index >= 0; index-- {
		order = append(order, injector.heldKeys[index])
	}
	return order
}

func TestRealModifierReachesTheWindowServer(t *testing.T) {
	requireRealInput(t)

	// Modifiers are used for the real keyboard proof because holding Shift
	// types nothing: the event is real, but it cannot land text in whatever
	// window happens to be focused.
	injector := New()
	defer injector.ReleaseAll()

	if err := injector.Key("ShiftLeft", true); err != nil {
		t.Fatal(err)
	}
	if !eventually(func() bool { return modifierFlags()&flagShift != 0 }) {
		t.Fatal("the window server never saw Shift go down")
	}

	if released := injector.ReleaseAll(); released != 1 {
		t.Fatalf("expected one held key to be released, got %d", released)
	}
	if !eventually(func() bool { return modifierFlags()&flagShift == 0 }) {
		t.Fatal("ReleaseAll left Shift held - the presenter's machine would be stuck")
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
