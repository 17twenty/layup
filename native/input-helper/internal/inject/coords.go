package inject

import "math"

// Screen is a rectangle in the OS's own coordinate space.
//
// On Windows the virtual desktop can start at a negative origin - a second
// monitor placed to the left of the primary one gives a negative Left - so the
// origin is carried explicitly rather than assumed to be zero.
type Screen struct {
	Left, Top, Width, Height int
}

// absoluteCoordinates converts a screen position into Windows' normalised
// absolute range (0..65535 across the whole virtual desktop).
//
// This is the one piece of the Windows path that is pure arithmetic, so it is
// kept separate and tested on any platform: the off-by-one in the divisor below
// puts a click on the wrong monitor edge, and that is not something to discover
// on a machine nobody here can run.
func absoluteCoordinates(x, y float64, screen Screen) (int32, int32) {
	return normaliseAxis(x, screen.Left, screen.Width), normaliseAxis(y, screen.Top, screen.Height)
}

func normaliseAxis(value float64, origin, size int) int32 {
	if size <= 1 {
		return 0
	}
	// A position outside the desktop is clamped rather than rejected: the
	// presenter's display geometry can change mid-session, and a pointer pinned
	// to the edge is far better than one that stops responding.
	offset := value - float64(origin)
	if offset < 0 {
		offset = 0
	}
	if limit := float64(size - 1); offset > limit {
		offset = limit
	}
	// Windows maps 65535 to the last pixel, so the span is size-1.
	return int32(math.Round(offset * 65535 / float64(size-1)))
}
