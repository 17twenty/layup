package inject

import "testing"

// The Windows pointer path cannot be run from this build host, so the piece of
// it that is pure arithmetic is tested here, on any platform. Everything else in
// inject_windows.go is a Win32 call.
func TestAbsoluteCoordinatesMapCornersExactly(t *testing.T) {
	screen := Screen{Left: 0, Top: 0, Width: 1920, Height: 1080}

	cases := []struct {
		name  string
		x, y  float64
		wantX int32
		wantY int32
	}{
		{name: "top left", x: 0, y: 0, wantX: 0, wantY: 0},
		// The last pixel must reach the end of the range, or a click on the
		// right-hand edge lands one pixel short - which on a multi-monitor
		// desktop is the wrong monitor.
		{name: "bottom right", x: 1919, y: 1079, wantX: 65535, wantY: 65535},
		{name: "centre", x: 959.5, y: 539.5, wantX: 32768, wantY: 32768},
	}

	for _, testCase := range cases {
		gotX, gotY := absoluteCoordinates(testCase.x, testCase.y, screen)
		if gotX != testCase.wantX || gotY != testCase.wantY {
			t.Errorf("%s: got (%d, %d), want (%d, %d)",
				testCase.name, gotX, gotY, testCase.wantX, testCase.wantY)
		}
	}
}

func TestAbsoluteCoordinatesHandleANegativeOrigin(t *testing.T) {
	// A second monitor placed to the left of the primary one gives the virtual
	// desktop a negative origin. Assuming (0,0) would put every click on the
	// wrong screen.
	screen := Screen{Left: -1920, Top: 0, Width: 3840, Height: 1080}

	if x, _ := absoluteCoordinates(-1920, 0, screen); x != 0 {
		t.Errorf("the left edge of the left monitor should be 0, got %d", x)
	}
	if x, _ := absoluteCoordinates(0, 0, screen); x < 32760 || x > 32780 {
		t.Errorf("the seam between the monitors should be mid-range, got %d", x)
	}
	if x, _ := absoluteCoordinates(1919, 0, screen); x != 65535 {
		t.Errorf("the right edge of the right monitor should be 65535, got %d", x)
	}
}

func TestPositionsOutsideTheDesktopAreClampedNotDropped(t *testing.T) {
	// Display geometry can change mid-session. A pointer pinned to the edge is
	// far better than one that stops responding.
	screen := Screen{Left: 0, Top: 0, Width: 1920, Height: 1080}

	x, y := absoluteCoordinates(-500, -500, screen)
	if x != 0 || y != 0 {
		t.Errorf("expected clamping to the origin, got (%d, %d)", x, y)
	}
	x, y = absoluteCoordinates(9999, 9999, screen)
	if x != 65535 || y != 65535 {
		t.Errorf("expected clamping to the far edge, got (%d, %d)", x, y)
	}
}

func TestADegenerateScreenDoesNotDivideByZero(t *testing.T) {
	// GetSystemMetrics can return 0 while displays are being reconfigured.
	if x, y := absoluteCoordinates(10, 10, Screen{}); x != 0 || y != 0 {
		t.Errorf("expected (0, 0) for an empty screen, got (%d, %d)", x, y)
	}
}
