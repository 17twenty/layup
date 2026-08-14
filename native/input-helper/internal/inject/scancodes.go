package inject

// Windows key data, kept out of a `_windows.go` file on purpose.
//
// A file named `*_windows.go` only compiles on Windows, which would mean this
// table - the part most likely to contain a typo, and the part where a typo
// types the wrong character into somebody else's machine - could never be
// checked from this build host. The Win32 calls that use it stay in
// inject_windows.go.
//
// As on macOS, keys are identified by *physical position*: the desktop sends
// `KeyboardEvent.code`, and these are set-1 scan codes, which name the same
// positions. Injecting by scan code rather than by virtual key means the
// presenter's own keyboard layout decides which character appears - so a guest
// on a US layout and a presenter on a German one both get the key they can see.

// windowsScanCodes maps a KeyboardEvent.code to its set-1 scan code.
//
// Anything absent is refused rather than guessed.
var windowsScanCodes = map[string]uint16{
	"Escape": 0x01,

	"Digit1": 0x02, "Digit2": 0x03, "Digit3": 0x04, "Digit4": 0x05, "Digit5": 0x06,
	"Digit6": 0x07, "Digit7": 0x08, "Digit8": 0x09, "Digit9": 0x0A, "Digit0": 0x0B,
	"Minus": 0x0C, "Equal": 0x0D, "Backspace": 0x0E, "Tab": 0x0F,

	"KeyQ": 0x10, "KeyW": 0x11, "KeyE": 0x12, "KeyR": 0x13, "KeyT": 0x14,
	"KeyY": 0x15, "KeyU": 0x16, "KeyI": 0x17, "KeyO": 0x18, "KeyP": 0x19,
	"BracketLeft": 0x1A, "BracketRight": 0x1B, "Enter": 0x1C, "ControlLeft": 0x1D,

	"KeyA": 0x1E, "KeyS": 0x1F, "KeyD": 0x20, "KeyF": 0x21, "KeyG": 0x22,
	"KeyH": 0x23, "KeyJ": 0x24, "KeyK": 0x25, "KeyL": 0x26,
	"Semicolon": 0x27, "Quote": 0x28, "Backquote": 0x29,
	"ShiftLeft": 0x2A, "Backslash": 0x2B,

	"KeyZ": 0x2C, "KeyX": 0x2D, "KeyC": 0x2E, "KeyV": 0x2F, "KeyB": 0x30,
	"KeyN": 0x31, "KeyM": 0x32,
	"Comma": 0x33, "Period": 0x34, "Slash": 0x35, "ShiftRight": 0x36,
	"NumpadMultiply": 0x37, "AltLeft": 0x38, "Space": 0x39, "CapsLock": 0x3A,

	"F1": 0x3B, "F2": 0x3C, "F3": 0x3D, "F4": 0x3E, "F5": 0x3F, "F6": 0x40,
	"F7": 0x41, "F8": 0x42, "F9": 0x43, "F10": 0x44, "F11": 0x57, "F12": 0x58,
	"NumLock": 0x45, "ScrollLock": 0x46,

	"Numpad7": 0x47, "Numpad8": 0x48, "Numpad9": 0x49, "NumpadSubtract": 0x4A,
	"Numpad4": 0x4B, "Numpad5": 0x4C, "Numpad6": 0x4D, "NumpadAdd": 0x4E,
	"Numpad1": 0x4F, "Numpad2": 0x50, "Numpad3": 0x51, "Numpad0": 0x52,
	"NumpadDecimal": 0x53,
}

// windowsExtendedScanCodes are the keys that share a scan code with one above
// and are distinguished only by the E0 prefix.
//
// Getting this wrong is not a cosmetic bug: ArrowUp and Numpad8 are both 0x48,
// so an arrow key without the extended flag types an 8.
var windowsExtendedScanCodes = map[string]uint16{
	"NumpadEnter": 0x1C, "ControlRight": 0x1D, "NumpadDivide": 0x35, "AltRight": 0x38,
	"Home": 0x47, "ArrowUp": 0x48, "PageUp": 0x49,
	"ArrowLeft": 0x4B, "ArrowRight": 0x4D,
	"End": 0x4F, "ArrowDown": 0x50, "PageDown": 0x51,
	"Insert": 0x52, "Delete": 0x53,
	"MetaLeft": 0x5B, "MetaRight": 0x5C, "ContextMenu": 0x5D,
}

// windowsScanCode reports the scan code for a key and whether it needs the
// extended-key flag.
func windowsScanCode(code string) (scan uint16, extended, known bool) {
	if scan, known = windowsExtendedScanCodes[code]; known {
		return scan, true, true
	}
	scan, known = windowsScanCodes[code]
	return scan, false, known
}

// windowsLatchingKeys toggle rather than hold. Releasing one on disconnect would
// turn it on, not tidy it away.
var windowsLatchingKeys = map[string]bool{
	"CapsLock": true, "NumLock": true, "ScrollLock": true,
}
