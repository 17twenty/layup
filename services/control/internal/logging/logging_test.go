package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func parse(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	line := strings.TrimSpace(buf.String())
	if line == "" {
		t.Fatal("expected a log line")
	}
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(line), &record); err != nil {
		t.Fatalf("log line is not machine-parseable JSON: %v (%q)", err, line)
	}
	return record
}

func TestLogsAreMachineParseable(t *testing.T) {
	var buf bytes.Buffer
	log := New(Options{Level: "info", Format: "json", Writer: &buf})
	log.Info("layup created", "layupId", "l1", "visibility", "PRIVATE")

	record := parse(t, &buf)
	if record["msg"] != "layup created" || record["layupId"] != "l1" || record["level"] != "INFO" {
		t.Fatalf("unexpected record: %#v", record)
	}
	if _, ok := record["time"]; !ok {
		t.Fatal("record must carry a timestamp")
	}
}

func TestCorrelationFieldsTravelOnTheContext(t *testing.T) {
	var buf bytes.Buffer
	log := New(Options{Level: "info", Format: "json", Writer: &buf})
	ctx := WithFields(context.Background(),
		slog.String("requestId", "req-1"),
		slog.String("sessionId", "sess-2"),
	)
	log.InfoContext(ctx, "membership joined")

	record := parse(t, &buf)
	if record["requestId"] != "req-1" || record["sessionId"] != "sess-2" {
		t.Fatalf("correlation fields missing: %#v", record)
	}
}

func TestForbiddenFieldsAreRedacted(t *testing.T) {
	var buf bytes.Buffer
	log := New(Options{Level: "info", Format: "json", Writer: &buf})
	log.Info("remote input",
		"turnPassword", "hunter2",
		"keystrokes", "rm -rf /",
		"clipboard", "secret plan",
		"cursorX", 0.42,
		"authorization", "Bearer abc",
		"layupId", "l1",
	)

	record := parse(t, &buf)
	for _, key := range []string{"turnPassword", "keystrokes", "clipboard", "cursorX", "authorization"} {
		if record[key] != Redacted {
			t.Errorf("%s must be redacted, got %#v", key, record[key])
		}
	}
	if record["layupId"] != "l1" {
		t.Errorf("non-sensitive fields must survive: %#v", record["layupId"])
	}
	if strings.Contains(buf.String(), "hunter2") || strings.Contains(buf.String(), "rm -rf") {
		t.Fatal("sensitive values leaked into the log line")
	}
}

func TestRedactionSurvivesWithAttrsAndGroups(t *testing.T) {
	var buf bytes.Buffer
	log := New(Options{Level: "info", Format: "json", Writer: &buf}).With("apiKey", "abc123")
	log.Info("startup", slog.Group("turn", slog.String("password", "hunter2"), slog.String("realm", "layup")))

	if strings.Contains(buf.String(), "hunter2") || strings.Contains(buf.String(), "abc123") {
		t.Fatalf("sensitive values leaked: %s", buf.String())
	}
	if !strings.Contains(buf.String(), "layup") {
		t.Fatalf("safe values must survive: %s", buf.String())
	}
}

func TestIsForbiddenKeyIgnoresSeparatorsAndCase(t *testing.T) {
	for _, key := range []string{"API_KEY", "api-key", "Turn.Password", "TypedText", "screenshot"} {
		if !IsForbiddenKey(key) {
			t.Errorf("%q should be forbidden", key)
		}
	}
	for _, key := range []string{"layupId", "membershipId", "durationMs", "iceCandidateType"} {
		if IsForbiddenKey(key) {
			t.Errorf("%q should be allowed", key)
		}
	}
}

func TestMiddlewareCorrelatesAndLogsOutcome(t *testing.T) {
	var buf bytes.Buffer
	log := New(Options{Level: "info", Format: "json", Writer: &buf})

	handler := Middleware(log)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.InfoContext(r.Context(), "handler ran")
		w.WriteHeader(http.StatusTeapot)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	requestID := rec.Header().Get(HeaderRequestID)
	if requestID == "" {
		t.Fatal("response must carry a request id")
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected handler line + request line, got %d", len(lines))
	}
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("not JSON: %v", err)
		}
		if record["requestId"] != requestID {
			t.Errorf("line missing correlation id: %#v", record)
		}
	}
	var last map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &last); err != nil {
		t.Fatal(err)
	}
	if last["status"] != float64(http.StatusTeapot) || last["path"] != "/healthz" {
		t.Errorf("unexpected request line: %#v", last)
	}
}

func TestSuppliedRequestIDIsHonoured(t *testing.T) {
	var buf bytes.Buffer
	log := New(Options{Level: "info", Format: "json", Writer: &buf})
	handler := Middleware(log)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set(HeaderRequestID, "client-supplied")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Header().Get(HeaderRequestID) != "client-supplied" {
		t.Fatalf("client request id must be reused, got %q", rec.Header().Get(HeaderRequestID))
	}
	if parse(t, &buf)["requestId"] != "client-supplied" {
		t.Fatal("log line must use the client request id")
	}
}
