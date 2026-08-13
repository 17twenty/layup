package config

import (
	"strings"
	"testing"
	"time"
)

func env(values map[string]string) Getenv {
	return func(key string) string { return values[key] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("expected defaults to be valid: %v", err)
	}
	if cfg.ListenAddr != "127.0.0.1:8787" || cfg.LogFormat != "json" || cfg.Environment != "dev" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.ShutdownTimeout != 5*time.Second {
		t.Fatalf("unexpected shutdown timeout: %v", cfg.ShutdownTimeout)
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"LAYUP_LISTEN_ADDR":              "0.0.0.0:9000",
		"LAYUP_ENV":                      "staging",
		"LAYUP_LOG_LEVEL":                "DEBUG",
		"LAYUP_LOG_FORMAT":               "text",
		"LAYUP_SHUTDOWN_TIMEOUT_SECONDS": "12",
		"LAYUP_ALLOWED_ORIGINS":          "http://localhost:5273, https://layup.example",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ListenAddr != "0.0.0.0:9000" || cfg.Environment != "staging" || cfg.LogLevel != "debug" || cfg.LogFormat != "text" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	if cfg.ShutdownTimeout != 12*time.Second {
		t.Fatalf("unexpected shutdown timeout: %v", cfg.ShutdownTimeout)
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.AllowedOrigins[0] != "http://localhost:5273" {
		t.Fatalf("unexpected origins: %#v", cfg.AllowedOrigins)
	}
}

func TestLoadFailsFastWithUsefulError(t *testing.T) {
	_, err := Load(env(map[string]string{
		"LAYUP_LISTEN_ADDR":              "not-an-address",
		"LAYUP_LOG_LEVEL":                "verbose",
		"LAYUP_LOG_FORMAT":               "yaml",
		"LAYUP_SHUTDOWN_TIMEOUT_SECONDS": "0",
		"LAYUP_ALLOWED_ORIGINS":          "layup.example",
	}))
	if err == nil {
		t.Fatal("expected invalid configuration to fail")
	}
	for _, want := range []string{"LISTEN_ADDR", "LOG_LEVEL", "LOG_FORMAT", "SHUTDOWN_TIMEOUT_SECONDS", "ALLOWED_ORIGINS"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should name %s: %v", want, err)
		}
	}
}
