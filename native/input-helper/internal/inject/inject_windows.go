//go:build windows

package inject

// Windows injection arrives in P1-0505 (pointer) and P1-0506 (keyboard).
func New() Injector {
	return unsupported{
		platform: "windows",
		detail:   "Windows input injection is not implemented yet (P1-0505, P1-0506)",
	}
}
