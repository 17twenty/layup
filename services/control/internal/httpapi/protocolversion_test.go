package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/layup-app/layup/protocol"
)

func request(t *testing.T, s *Server, method, path, version string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if version != "" {
		req.Header.Set(protocol.HeaderVersion, version)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) protocol.ErrorPayload {
	t.Helper()
	var env protocol.Envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("response is not an envelope: %v (%s)", err, rec.Body.String())
	}
	if env.Type != protocol.TypeError || env.Version != protocol.Version {
		t.Fatalf("unexpected envelope: %+v", env)
	}
	var payload protocol.ErrorPayload
	if err := protocol.DecodePayload(env, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	return payload
}

func TestVersionedRouteAcceptsSupportedVersion(t *testing.T) {
	rec := request(t, testServer(t), http.MethodGet, "/api/protocol", strconv.Itoa(protocol.Version))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get(protocol.HeaderVersion); got != strconv.Itoa(protocol.Version) {
		t.Fatalf("server must advertise its version, got %q", got)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not an envelope: %v", err)
	}
	if err := env.Validate(); err != nil {
		t.Fatalf("response envelope invalid: %v", err)
	}
}

func TestVersionedRouteRejectsUnsupportedVersion(t *testing.T) {
	rec := request(t, testServer(t), http.MethodGet, "/api/protocol", "99")
	if rec.Code != http.StatusUpgradeRequired {
		t.Fatalf("expected 426, got %d", rec.Code)
	}
	payload := decodeError(t, rec)
	if payload.Code != protocol.CodeUnsupportedProtocolVersion {
		t.Fatalf("unexpected code %q", payload.Code)
	}
	if payload.ReceivedVersion != 99 || payload.ServerVersion != protocol.Version {
		t.Fatalf("error must name both versions: %+v", payload)
	}
}

func TestVersionedRouteRejectsMissingOrGarbageVersion(t *testing.T) {
	for _, header := range []string{"", "banana", "0", "-1"} {
		rec := request(t, testServer(t), http.MethodGet, "/api/protocol", header)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("header %q: expected 400, got %d", header, rec.Code)
			continue
		}
		if payload := decodeError(t, rec); payload.Code != protocol.CodeMalformedMessage {
			t.Errorf("header %q: unexpected code %q", header, payload.Code)
		}
	}
}

func TestHealthzStaysReachableWithoutAVersionHeader(t *testing.T) {
	rec := request(t, testServer(t), http.MethodGet, "/healthz", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("discovery endpoint must not require the version header, got %d", rec.Code)
	}
}
