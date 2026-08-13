// Package buildinfo exposes build/version metadata for logs and /healthz.
package buildinfo

import (
	"runtime"
	"runtime/debug"
	"sync"
)

// Version is overridden at release time with -ldflags.
var Version = "dev"

// Commit is overridden at release time with -ldflags; otherwise it is read from
// the embedded VCS stamp when the binary was built from a repository.
var Commit = ""

var once sync.Once

// Info describes this build.
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit,omitempty"`
	GoVersion string `json:"goVersion"`
	Platform  string `json:"platform"`
}

// Get returns the build metadata for this binary.
func Get() Info {
	once.Do(func() {
		if Commit != "" {
			return
		}
		info, ok := debug.ReadBuildInfo()
		if !ok {
			return
		}
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				Commit = setting.Value
			}
		}
	})
	return Info{
		Version:   Version,
		Commit:    Commit,
		GoVersion: runtime.Version(),
		Platform:  runtime.GOOS + "/" + runtime.GOARCH,
	}
}
