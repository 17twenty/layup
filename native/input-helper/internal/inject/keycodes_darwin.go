//go:build darwin

// Key codes are mapped by *physical position*, not by the character a key
// produces.
//
// The desktop sends the browser's `KeyboardEvent.code` ("KeyA", "Digit1",
// "ShiftLeft"), which names a position on the keyboard. macOS virtual key codes
// name the same positions. Mapping position to position means a guest on an
// AZERTY keyboard pressing the key where a QWERTY 'A' would be reaches the same
// key on the presenter's machine as their own layout describes - which is what a
// person watching their own screen expects. Mapping characters instead would
// silently break every non-US layout and every keyboard shortcut.
package inject

// darwinKeyCodes maps a KeyboardEvent.code to a macOS virtual key code.
//
// Anything absent is refused rather than guessed: a wrong key code types the
// wrong thing into somebody else's machine.
var darwinKeyCodes = map[string]int{
	// Letters.
	"KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5,
	"KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9, "KeyB": 11, "KeyQ": 12,
	"KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17, "KeyO": 31,
	"KeyU": 32, "KeyI": 34, "KeyP": 35, "KeyL": 37, "KeyJ": 38, "KeyK": 40,
	"KeyN": 45, "KeyM": 46,

	// Digits.
	"Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22,
	"Digit5": 23, "Digit9": 25, "Digit7": 26, "Digit8": 28, "Digit0": 29,

	// Punctuation.
	"Equal": 24, "Minus": 27, "BracketRight": 30, "BracketLeft": 33,
	"Quote": 39, "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44,
	"Period": 47, "Backquote": 50,

	// Editing and navigation.
	"Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53,
	"Delete": 117, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
	"ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
	"Insert": 114,

	// Modifiers.
	"MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "CapsLock": 57,
	"AltLeft": 58, "ControlLeft": 59, "ShiftRight": 60, "AltRight": 61,
	"ControlRight": 62,

	// Function keys.
	"F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
	"F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,

	// Numeric keypad.
	"Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85, "Numpad4": 86,
	"Numpad5": 87, "Numpad6": 88, "Numpad7": 89, "Numpad8": 91, "Numpad9": 92,
	"NumpadDecimal": 65, "NumpadMultiply": 67, "NumpadAdd": 69,
	"NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78,
	"NumpadEqual": 81,
}

// CoreGraphics modifier flag masks.
const (
	flagCapsLock  = 0x00010000
	flagShift     = 0x00020000
	flagControl   = 0x00040000
	flagAlternate = 0x00080000
	flagCommand   = 0x00100000
)

// darwinModifierFlags maps a modifier key to the flag it contributes.
//
// Modifiers are tracked and re-applied to every event because a shortcut is a
// *flag* on the key event, not a sequence of key presses: without this, Cmd+C
// posted as three events can arrive as a plain 'c'.
var darwinModifierFlags = map[string]uint64{
	"ShiftLeft":    flagShift,
	"ShiftRight":   flagShift,
	"ControlLeft":  flagControl,
	"ControlRight": flagControl,
	"AltLeft":      flagAlternate,
	"AltRight":     flagAlternate,
	"MetaLeft":     flagCommand,
	"MetaRight":    flagCommand,
	"CapsLock":     flagCapsLock,
}
