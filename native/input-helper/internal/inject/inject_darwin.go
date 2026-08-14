//go:build darwin && cgo

// macOS pointer injection via CoreGraphics events (ADR-0006).
//
// Injection requires the Accessibility permission. Without it CGEventPost
// silently does nothing, which is the worst possible failure: the guest clicks
// and the presenter's machine ignores it with no explanation. The helper
// therefore checks the permission explicitly and reports an actionable state
// instead of appearing to work.
package inject

/*
#cgo LDFLAGS: -framework ApplicationServices -framework CoreGraphics
#include <ApplicationServices/ApplicationServices.h>

// Trusted reports whether this process may post input events.
static int layupProcessTrusted(void) {
    return AXIsProcessTrusted() ? 1 : 0;
}

// PostMouse posts a mouse event of `type` for `button` at absolute (x, y).
static void layupPostMouse(int type, int button, double x, double y, int clickCount) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, (CGEventType)type,
                                               CGPointMake(x, y), (CGMouseButton)button);
    if (event == NULL) return;
    if (clickCount > 0) {
        CGEventSetIntegerValueField(event, kCGMouseEventClickState, clickCount);
    }
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

// PostWheel scrolls by whole lines.
static void layupPostWheel(int deltaY, int deltaX) {
    CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, deltaY, deltaX);
    if (event == NULL) return;
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

// CursorPosition reports where the pointer is now, so a click can be posted
// without moving it first.
static CGPoint layupCursorPosition(void) {
    CGEventRef event = CGEventCreate(NULL);
    CGPoint point = CGEventGetLocation(event);
    CFRelease(event);
    return point;
}

// ButtonState asks the window server whether a button is currently down. It is
// how the opt-in real-injection test proves a posted click actually landed.
static int layupButtonState(int button) {
    return CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState,
                                    (CGMouseButton)button) ? 1 : 0;
}
*/
import "C"

import (
	"fmt"
	"sync"

	"github.com/layup-app/layup/protocol"
)

// CoreGraphics event types used here.
const (
	eventMouseMoved     = 5  // kCGEventMouseMoved
	eventLeftMouseDown  = 1  // kCGEventLeftMouseDown
	eventLeftMouseUp    = 2  // kCGEventLeftMouseUp
	eventRightMouseDown = 3  // kCGEventRightMouseDown
	eventRightMouseUp   = 4  // kCGEventRightMouseUp
	eventOtherMouseDown = 25 // kCGEventOtherMouseDown
	eventOtherMouseUp   = 26 // kCGEventOtherMouseUp

	buttonLeft   = 0
	buttonRight  = 1
	buttonCentre = 2
)

type darwinInjector struct {
	mu sync.Mutex
	// held is what this helper is currently holding down, so a disconnect can
	// always let go (SPEC.md §13.3).
	held map[Button]bool
}

// New returns the macOS injector.
func New() Injector {
	return &darwinInjector{held: map[Button]bool{}}
}

func (d *darwinInjector) trusted() bool { return C.layupProcessTrusted() == 1 }

func (d *darwinInjector) Capabilities() protocol.HelperCapabilities {
	trusted := d.trusted()
	capabilities := protocol.HelperCapabilities{
		Platform:      "darwin",
		PointerMove:   trusted,
		PointerButton: trusted,
		PointerWheel:  trusted,
		// Keyboard injection arrives in P1-0504.
		Keyboard: false,
	}
	if !trusted {
		capabilities.Detail = "macOS Accessibility permission is missing: open Privacy & Security → " +
			"Accessibility, tick Layup, then restart it. Remote control does nothing until then."
	}
	return capabilities
}

// requireTrusted refuses rather than posting an event that macOS will silently
// discard.
func (d *darwinInjector) requireTrusted() error {
	if d.trusted() {
		return nil
	}
	return fmt.Errorf("accessibility permission is not granted; macOS would ignore this event")
}

func (d *darwinInjector) MoveTo(x, y float64) error {
	if err := d.requireTrusted(); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()

	// A move while a button is held is a drag, and must be posted as such or
	// the drag is dropped by the target application.
	switch {
	case d.held[ButtonLeft]:
		C.layupPostMouse(6, buttonLeft, C.double(x), C.double(y), 0) // kCGEventLeftMouseDragged
	case d.held[ButtonRight]:
		C.layupPostMouse(7, buttonRight, C.double(x), C.double(y), 0) // kCGEventRightMouseDragged
	default:
		C.layupPostMouse(eventMouseMoved, buttonLeft, C.double(x), C.double(y), 0)
	}
	return nil
}

func (d *darwinInjector) Button(button Button, down bool) error {
	if err := d.requireTrusted(); err != nil {
		return err
	}
	downType, upType, code, err := buttonEvents(button)
	if err != nil {
		return err
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	position := C.layupCursorPosition()
	eventType := upType
	if down {
		eventType = downType
	}
	C.layupPostMouse(C.int(eventType), C.int(code), position.x, position.y, 1)

	if down {
		d.held[button] = true
	} else {
		delete(d.held, button)
	}
	return nil
}

func (d *darwinInjector) Wheel(deltaX, deltaY int) error {
	if err := d.requireTrusted(); err != nil {
		return err
	}
	C.layupPostWheel(C.int(deltaY), C.int(deltaX))
	return nil
}

func (d *darwinInjector) Key(string, bool) error {
	return fmt.Errorf("keyboard injection is not implemented yet (P1-0504)")
}

func (d *darwinInjector) ReleaseAll() int {
	d.mu.Lock()
	held := make([]Button, 0, len(d.held))
	for button := range d.held {
		held = append(held, button)
	}
	d.mu.Unlock()

	released := 0
	for _, button := range held {
		if err := d.Button(button, false); err == nil {
			released++
		}
	}
	return released
}

// cursorPosition and buttonDown observe the window server rather than our own
// bookkeeping, so a test can tell the difference between "we posted an event"
// and "the OS acted on it".
func cursorPosition() (x, y float64) {
	point := C.layupCursorPosition()
	return float64(point.x), float64(point.y)
}

func buttonDown(button Button) bool {
	_, _, code, err := buttonEvents(button)
	if err != nil {
		return false
	}
	return C.layupButtonState(C.int(code)) == 1
}

func buttonEvents(button Button) (down, up, code int, err error) {
	switch button {
	case ButtonLeft:
		return eventLeftMouseDown, eventLeftMouseUp, buttonLeft, nil
	case ButtonRight:
		return eventRightMouseDown, eventRightMouseUp, buttonRight, nil
	case ButtonMiddle:
		return eventOtherMouseDown, eventOtherMouseUp, buttonCentre, nil
	default:
		return 0, 0, 0, fmt.Errorf("unknown mouse button %q", button)
	}
}
