// Package logging provides the control plane's structured logging baseline:
// machine-parseable output, request/session correlation, and a hard rule that
// sensitive material never reaches a log line (SPEC.md §13.4).
package logging

import (
	"context"
	"io"
	"log/slog"
	"strings"
)

// Redacted replaces the value of any attribute whose key is forbidden.
const Redacted = "[redacted]"

// forbiddenKeys are substrings of attribute keys that must never be logged.
// Layup audits *events*, never content: no credentials, no keystrokes, no
// clipboard, no pixels, no raw cursor coordinates, no media payloads.
var forbiddenKeys = []string{
	"password", "passwd", "secret", "token", "authorization", "credential",
	"apikey", "api_key", "cookie", "privatekey", "private_key",
	"keystroke", "keystrokes", "keytext", "typedtext", "clipboard",
	"pixels", "frame", "framedata", "screenshot", "audio", "video",
	"cursorx", "cursory", "cursortrail", "turnpassword",
}

// IsForbiddenKey reports whether an attribute key must be redacted.
func IsForbiddenKey(key string) bool {
	normalised := strings.ToLower(strings.NewReplacer("-", "", "_", "", ".", "").Replace(key))
	for _, forbidden := range forbiddenKeys {
		if strings.Contains(normalised, strings.ReplaceAll(forbidden, "_", "")) {
			return true
		}
	}
	return false
}

// Options configure a logger.
type Options struct {
	Level  string // debug|info|warn|error
	Format string // json|text
	Writer io.Writer
}

// New builds the process logger. Output is machine-parseable by default.
func New(opts Options) *slog.Logger {
	var level slog.Level
	switch strings.ToLower(opts.Level) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	handlerOpts := &slog.HandlerOptions{Level: level}
	var base slog.Handler
	if strings.ToLower(opts.Format) == "text" {
		base = slog.NewTextHandler(opts.Writer, handlerOpts)
	} else {
		base = slog.NewJSONHandler(opts.Writer, handlerOpts)
	}
	return slog.New(&redactingHandler{inner: base})
}

// redactingHandler enforces the "never log content" rule at the handler level,
// so a careless call site cannot leak by accident.
type redactingHandler struct{ inner slog.Handler }

func (h *redactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *redactingHandler) Handle(ctx context.Context, record slog.Record) error {
	safe := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	record.Attrs(func(attr slog.Attr) bool {
		safe.AddAttrs(redactAttr(attr))
		return true
	})
	// Correlation fields travel on the context so every line in a request or
	// session can be stitched together.
	for _, attr := range fromContext(ctx) {
		safe.AddAttrs(redactAttr(attr))
	}
	return h.inner.Handle(ctx, safe)
}

func (h *redactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	safe := make([]slog.Attr, 0, len(attrs))
	for _, attr := range attrs {
		safe = append(safe, redactAttr(attr))
	}
	return &redactingHandler{inner: h.inner.WithAttrs(safe)}
}

func (h *redactingHandler) WithGroup(name string) slog.Handler {
	return &redactingHandler{inner: h.inner.WithGroup(name)}
}

func redactAttr(attr slog.Attr) slog.Attr {
	if IsForbiddenKey(attr.Key) {
		return slog.String(attr.Key, Redacted)
	}
	if attr.Value.Kind() == slog.KindGroup {
		children := attr.Value.Group()
		safe := make([]any, 0, len(children))
		for _, child := range children {
			safe = append(safe, redactAttr(child))
		}
		return slog.Group(attr.Key, safe...)
	}
	return attr
}

type contextKey struct{}

// WithFields returns a context carrying correlation fields that are added to
// every log line emitted with it.
func WithFields(ctx context.Context, attrs ...slog.Attr) context.Context {
	existing := fromContext(ctx)
	combined := make([]slog.Attr, 0, len(existing)+len(attrs))
	combined = append(combined, existing...)
	combined = append(combined, attrs...)
	return context.WithValue(ctx, contextKey{}, combined)
}

func fromContext(ctx context.Context) []slog.Attr {
	if ctx == nil {
		return nil
	}
	attrs, _ := ctx.Value(contextKey{}).([]slog.Attr)
	return attrs
}
