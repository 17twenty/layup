//go:build darwin && !cgo

package inject

// macOS injection needs CoreGraphics, which needs cgo. A CGO_ENABLED=0 build
// (cross-compilation, some CI jobs) still produces a working helper - it simply
// reports that it cannot inject, rather than failing to build or pretending.
func New() Injector {
	return unsupported{
		platform: "darwin",
		detail:   "this helper was built without cgo, so macOS input injection is unavailable",
	}
}
