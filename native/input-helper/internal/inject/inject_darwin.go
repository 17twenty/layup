//go:build darwin

package inject

// macOS injection arrives in P1-0503 (pointer) and P1-0504 (keyboard). Until
// then the helper reports the capability as unavailable rather than claiming an
// ability it does not have.
func New() Injector {
	return unsupported{
		platform: "darwin",
		detail:   "macOS input injection is not implemented yet (P1-0503, P1-0504)",
	}
}
