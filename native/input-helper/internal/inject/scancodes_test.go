package inject

import "testing"

// The Windows keyboard path cannot be run from this build host, so the table it
// depends on is checked here instead. A typo in a scan code types the wrong
// character into somebody else's machine.

func TestScanCodesCoverTypingAndShortcuts(t *testing.T) {
	for _, code := range []string{
		"KeyA", "KeyZ", "Digit0", "Digit9", "Space", "Enter", "Tab", "Backspace",
		"Escape", "Minus", "Equal", "Comma", "Period", "Slash", "Semicolon",
		"Quote", "BracketLeft", "BracketRight", "Backslash", "Backquote",
		"ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End",
		"PageUp", "PageDown", "Delete", "Insert", "F1", "F12",
		"ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
		"AltLeft", "AltRight", "MetaLeft", "MetaRight",
	} {
		if _, _, known := windowsScanCode(code); !known {
			t.Errorf("%s is missing from the scan code table", code)
		}
	}
}

func TestExtendedKeysAreFlaggedNotConfused(t *testing.T) {
	// ArrowUp and Numpad8 are both scan code 0x48. Without the extended flag an
	// arrow key types an 8.
	arrow, arrowExtended, known := windowsScanCode("ArrowUp")
	if !known || !arrowExtended {
		t.Fatal("ArrowUp must be an extended key")
	}
	numpad, numpadExtended, known := windowsScanCode("Numpad8")
	if !known || numpadExtended {
		t.Fatal("Numpad8 must not be an extended key")
	}
	if arrow != numpad {
		t.Fatalf("these keys really do share a scan code; got %#x and %#x", arrow, numpad)
	}

	// The same trap on the other pairs that share a code.
	for _, pair := range [][2]string{
		{"NumpadEnter", "Enter"},
		{"ControlRight", "ControlLeft"},
		{"NumpadDivide", "Slash"},
		{"AltRight", "AltLeft"},
		{"Home", "Numpad7"},
		{"Delete", "NumpadDecimal"},
	} {
		extendedCode, isExtended, _ := windowsScanCode(pair[0])
		plainCode, isPlain, _ := windowsScanCode(pair[1])
		if !isExtended || isPlain {
			t.Errorf("%s should be extended and %s should not", pair[0], pair[1])
		}
		if extendedCode != plainCode {
			t.Errorf("%s and %s should share scan code, got %#x and %#x",
				pair[0], pair[1], extendedCode, plainCode)
		}
	}
}

func TestNoTwoKeysShareAScanCodeWithinATable(t *testing.T) {
	for name, table := range map[string]map[string]uint16{
		"plain":    windowsScanCodes,
		"extended": windowsExtendedScanCodes,
	} {
		seen := map[uint16]string{}
		for code, scan := range table {
			if previous, clash := seen[scan]; clash {
				t.Errorf("%s table: %s and %s both map to %#x", name, code, previous, scan)
			}
			seen[scan] = code
		}
	}
}

func TestUnknownKeysAreNotGuessed(t *testing.T) {
	for _, code := range []string{"", "KeyÅ", "Again", "MediaPlay", "F19"} {
		if _, _, known := windowsScanCode(code); known {
			t.Errorf("%q should not be in the table", code)
		}
	}
}

func TestLatchingKeysAreNotHeld(t *testing.T) {
	// Releasing Caps Lock on disconnect would switch it on, not tidy it away.
	for _, code := range []string{"CapsLock", "NumLock", "ScrollLock"} {
		if !windowsLatchingKeys[code] {
			t.Errorf("%s latches and must not be tracked as held", code)
		}
	}
	if windowsLatchingKeys["ShiftLeft"] {
		t.Error("Shift is held, not latched - it must be released on disconnect")
	}
}
