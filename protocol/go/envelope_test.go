package protocol

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestVersionMatchesVersionFile(t *testing.T) {
	raw, err := os.ReadFile("../VERSION")
	if err != nil {
		t.Fatalf("read protocol/VERSION: %v", err)
	}
	want, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("protocol/VERSION is not an integer: %v", err)
	}
	if Version != want {
		t.Fatalf("Go binding speaks v%d but protocol/VERSION says v%d", Version, want)
	}
}

func TestDecodeAcceptsSupportedEnvelope(t *testing.T) {
	e, err := Decode([]byte(`{"v":1,"type":"presence.update","id":"m1","payload":{"a":1}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if e.Type != "presence.update" || e.ID != "m1" {
		t.Fatalf("unexpected envelope: %+v", e)
	}
	var payload struct {
		A int `json:"a"`
	}
	if err := DecodePayload(e, &payload); err != nil || payload.A != 1 {
		t.Fatalf("payload decode failed: %v %+v", err, payload)
	}
}

func TestDecodeRejectsUnsupportedVersion(t *testing.T) {
	_, err := Decode([]byte(`{"v":99,"type":"presence.update"}`))
	if !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("expected ErrUnsupportedVersion, got %v", err)
	}
	if !strings.Contains(err.Error(), "v99") || !strings.Contains(err.Error(), "v1") {
		t.Fatalf("error should name both versions: %v", err)
	}
}

func TestDecodeRejectsMalformedMessages(t *testing.T) {
	for _, raw := range []string{
		`not json`,
		`{"type":"presence.update"}`, // missing version
		`{"v":1}`,                    // missing type
	} {
		if _, err := Decode([]byte(raw)); !errors.Is(err, ErrMalformed) {
			t.Errorf("expected ErrMalformed for %q, got %v", raw, err)
		}
	}
}

func TestNewEnvelopeStampsThisVersion(t *testing.T) {
	e, err := NewEnvelope("layup.join", map[string]string{"layupId": "l1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if e.Version != Version {
		t.Fatalf("expected v%d, got v%d", Version, e.Version)
	}
	if err := e.Validate(); err != nil {
		t.Fatalf("built envelope must validate: %v", err)
	}
}

func TestErrorEnvelopeCarriesCodeAndServerVersion(t *testing.T) {
	e := NewErrorEnvelope(CodeUnsupportedProtocolVersion, "peer speaks v99")
	if e.Type != TypeError {
		t.Fatalf("unexpected type %q", e.Type)
	}
	var payload ErrorPayload
	if err := DecodePayload(e, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload.Code != CodeUnsupportedProtocolVersion || payload.ServerVersion != Version {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}
