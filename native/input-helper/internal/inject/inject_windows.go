//go:build windows

// Windows pointer injection via SendInput (ADR-0006).
//
// # Integrity boundary
//
// Windows will not let a process inject input into a window running at a higher
// integrity level (User Interface Privilege Isolation). In practice that means:
//
//   - an application started with "Run as administrator" ignores everything this
//     helper sends, unless the helper itself is elevated;
//   - UAC consent prompts, the lock screen, the Ctrl+Alt+Del screen and the
//     login screen live on the secure desktop, where no ordinary process can
//     inject at all - elevation does not help;
//   - the block is per *focused window*, so remote control can work perfectly
//     and then stop the moment the presenter focuses an elevated tool.
//
// None of that can be worked around, and trying would mean shipping something
// that looks like malware. What the helper can do is notice it and say so
// clearly, which is what the ERROR_ACCESS_DENIED handling below is for: the
// alternative is a guest clicking into a void with no explanation.
//
// This file uses the Win32 API directly through syscall rather than cgo, so the
// helper still cross-compiles for Windows from a macOS or Linux build host.
package inject

import (
	"fmt"
	"sync"
	"syscall"
	"unsafe"

	"github.com/layup-app/layup/protocol"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	procSendInput        = user32.NewProc("SendInput")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
)

// Win32 constants.
const (
	inputMouse = 0

	eventMouseMove       = 0x0001
	eventLeftDown        = 0x0002
	eventLeftUp          = 0x0004
	eventRightDown       = 0x0008
	eventRightUp         = 0x0010
	eventMiddleDown      = 0x0020
	eventMiddleUp        = 0x0040
	eventWheel           = 0x0800
	eventHorizontalWheel = 0x1000
	eventAbsolute        = 0x8000
	eventVirtualDesk     = 0x4000

	// One notch of a wheel, in the units SendInput expects.
	wheelDelta = 120

	metricVirtualLeft   = 76
	metricVirtualTop    = 77
	metricVirtualWidth  = 78
	metricVirtualHeight = 79

	errorAccessDenied = syscall.Errno(5)
)

// mouseInput mirrors Win32's MOUSEINPUT.
type mouseInput struct {
	dx        int32
	dy        int32
	mouseData uint32
	flags     uint32
	time      uint32
	extraInfo uintptr
}

// input mirrors Win32's INPUT union, sized for its largest member (the mouse
// variant). Go's alignment rules give exactly the 40 bytes SendInput expects on
// amd64; a mismatched size makes every call fail, so the size is asserted at
// compile time below.
type input struct {
	inputType uint32
	_         uint32 // union alignment on 64-bit
	mouse     mouseInput
}

var _ [40]byte = [unsafe.Sizeof(input{})]byte{}

type windowsInjector struct {
	mu   sync.Mutex
	held map[Button]bool
}

// New returns the Windows injector.
func New() Injector {
	return &windowsInjector{held: map[Button]bool{}}
}

func (w *windowsInjector) Capabilities() protocol.HelperCapabilities {
	return protocol.HelperCapabilities{
		Platform:      "windows",
		PointerMove:   true,
		PointerButton: true,
		PointerWheel:  true,
		// Keyboard injection arrives in P1-0506.
		Keyboard: false,
		Detail: "Windows ignores injected input aimed at an elevated window, and at the " +
			"secure desktop (UAC prompts, the lock screen) it is blocked outright. Remote " +
			"control pauses while one of those is focused.",
	}
}

func (w *windowsInjector) MoveTo(x, y float64) error {
	dx, dy := absoluteCoordinates(x, y, virtualScreen())
	event := mouseEvent(eventMouseMove|eventAbsolute|eventVirtualDesk, 0)
	event.mouse.dx, event.mouse.dy = dx, dy
	return w.send(event)
}

func (w *windowsInjector) Button(button Button, down bool) error {
	flag, err := buttonFlag(button, down)
	if err != nil {
		return err
	}

	w.mu.Lock()
	defer w.mu.Unlock()

	if err := w.send(mouseEvent(flag, 0)); err != nil {
		return err
	}
	if down {
		w.held[button] = true
	} else {
		delete(w.held, button)
	}
	return nil
}

func (w *windowsInjector) Wheel(deltaX, deltaY int) error {
	// Positive deltaY scrolls the content up on every platform we speak to, and
	// Windows' wheel is measured in notches of 120.
	if deltaY != 0 {
		if err := w.send(mouseEvent(eventWheel, uint32(int32(deltaY*wheelDelta)))); err != nil {
			return err
		}
	}
	if deltaX != 0 {
		if err := w.send(mouseEvent(eventHorizontalWheel, uint32(int32(deltaX*wheelDelta)))); err != nil {
			return err
		}
	}
	return nil
}

func (w *windowsInjector) Key(string, bool) error {
	return fmt.Errorf("keyboard injection is not implemented yet (P1-0506)")
}

func (w *windowsInjector) ReleaseAll() int {
	w.mu.Lock()
	buttons := make([]Button, 0, len(w.held))
	for button := range w.held {
		buttons = append(buttons, button)
	}
	w.mu.Unlock()

	released := 0
	for _, button := range buttons {
		if err := w.Button(button, false); err == nil {
			released++
		}
	}
	return released
}

func mouseEvent(flags, data uint32) input {
	event := input{inputType: inputMouse}
	event.mouse.flags = flags
	event.mouse.mouseData = data
	return event
}

// send posts one event and turns Win32's failure modes into something a person
// can act on.
func (w *windowsInjector) send(event input) error {
	sent, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&event)), unsafe.Sizeof(event))
	if sent == 1 {
		return nil
	}
	if errno, ok := err.(syscall.Errno); ok && errno == errorAccessDenied {
		return fmt.Errorf("windows blocked this input: the focused window runs at a higher " +
			"integrity level (an elevated application, a UAC prompt or the lock screen). " +
			"Remote control resumes when an ordinary window is focused")
	}
	return fmt.Errorf("windows rejected the input event: %w", err)
}

func virtualScreen() Screen {
	return Screen{
		Left:   systemMetric(metricVirtualLeft),
		Top:    systemMetric(metricVirtualTop),
		Width:  systemMetric(metricVirtualWidth),
		Height: systemMetric(metricVirtualHeight),
	}
}

func systemMetric(index int) int {
	value, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int(int32(value))
}

func buttonFlag(button Button, down bool) (uint32, error) {
	switch button {
	case ButtonLeft:
		if down {
			return eventLeftDown, nil
		}
		return eventLeftUp, nil
	case ButtonRight:
		if down {
			return eventRightDown, nil
		}
		return eventRightUp, nil
	case ButtonMiddle:
		if down {
			return eventMiddleDown, nil
		}
		return eventMiddleUp, nil
	default:
		return 0, fmt.Errorf("unknown mouse button %q", button)
	}
}
