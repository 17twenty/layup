//go:build !darwin && !windows

package inject

import "runtime"

// New returns the platform injector.
//
// PLAN-1 targets macOS and Windows first (SPEC.md §17, Stage 5). On anything
// else the helper still runs, authenticates and reports capabilities - it
// simply cannot inject, and says so.
func New() Injector {
	return unsupported{
		platform: runtime.GOOS,
		detail:   "remote control is not implemented on " + runtime.GOOS + " in PLAN-1",
	}
}
