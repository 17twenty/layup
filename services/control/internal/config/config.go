// Package config loads control-plane configuration from the environment.
//
// Configuration is validated once at startup and fails fast with an actionable
// error rather than degrading into a half-configured service.
package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// EnvPrefix namespaces every configuration variable.
const EnvPrefix = "LAYUP_"

// Config is the fully validated control-plane configuration.
type Config struct {
	// ListenAddr is the host:port the HTTP/WS server binds to.
	ListenAddr string
	// Environment is a free-form deployment label used in logs (dev, staging, ...).
	Environment string
	// LogLevel is one of debug, info, warn, error.
	LogLevel string
	// LogFormat is json or text.
	LogFormat string
	// ShutdownTimeout bounds graceful shutdown.
	ShutdownTimeout time.Duration
	// AllowedOrigins are the browser origins permitted to open a WebSocket.
	// The desktop sends its own origin; an empty list means "desktop only".
	AllowedOrigins []string
}

// Default values chosen for local development on a single machine.
func defaults() Config {
	return Config{
		ListenAddr:      "127.0.0.1:8787",
		Environment:     "dev",
		LogLevel:        "info",
		LogFormat:       "json",
		ShutdownTimeout: 5 * time.Second,
		AllowedOrigins:  nil,
	}
}

// Getenv abstracts the environment so tests do not mutate the process.
type Getenv func(key string) string

// Load reads configuration using the supplied lookup function. Pass os.Getenv
// in production.
func Load(getenv Getenv) (Config, error) {
	cfg := defaults()
	var problems []string

	if v := getenv(EnvPrefix + "LISTEN_ADDR"); v != "" {
		cfg.ListenAddr = v
	}
	if _, _, err := net.SplitHostPort(cfg.ListenAddr); err != nil {
		problems = append(problems, fmt.Sprintf("%sLISTEN_ADDR %q is not host:port", EnvPrefix, cfg.ListenAddr))
	}

	if v := getenv(EnvPrefix + "ENV"); v != "" {
		cfg.Environment = v
	}

	if v := getenv(EnvPrefix + "LOG_LEVEL"); v != "" {
		cfg.LogLevel = strings.ToLower(v)
	}
	switch cfg.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		problems = append(problems, fmt.Sprintf("%sLOG_LEVEL %q must be debug|info|warn|error", EnvPrefix, cfg.LogLevel))
	}

	if v := getenv(EnvPrefix + "LOG_FORMAT"); v != "" {
		cfg.LogFormat = strings.ToLower(v)
	}
	switch cfg.LogFormat {
	case "json", "text":
	default:
		problems = append(problems, fmt.Sprintf("%sLOG_FORMAT %q must be json|text", EnvPrefix, cfg.LogFormat))
	}

	if v := getenv(EnvPrefix + "SHUTDOWN_TIMEOUT_SECONDS"); v != "" {
		seconds, err := strconv.Atoi(v)
		if err != nil || seconds <= 0 || seconds > 120 {
			problems = append(problems, fmt.Sprintf("%sSHUTDOWN_TIMEOUT_SECONDS %q must be an integer in 1..120", EnvPrefix, v))
		} else {
			cfg.ShutdownTimeout = time.Duration(seconds) * time.Second
		}
	}

	if v := getenv(EnvPrefix + "ALLOWED_ORIGINS"); v != "" {
		for _, origin := range strings.Split(v, ",") {
			origin = strings.TrimSpace(origin)
			if origin == "" {
				continue
			}
			if !strings.HasPrefix(origin, "http://") && !strings.HasPrefix(origin, "https://") {
				problems = append(problems, fmt.Sprintf("%sALLOWED_ORIGINS entry %q must include a scheme", EnvPrefix, origin))
				continue
			}
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, origin)
		}
	}

	if len(problems) > 0 {
		return Config{}, fmt.Errorf("invalid configuration:\n  - %s", strings.Join(problems, "\n  - "))
	}
	return cfg, nil
}

// LoadFromOS is the production entry point.
func LoadFromOS() (Config, error) { return Load(os.Getenv) }

// ErrNotConfigured is returned by helpers that need configuration that is absent.
var ErrNotConfigured = errors.New("not configured")
