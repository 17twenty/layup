package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/layup-app/layup/native/input-helper/internal/inject"
	"github.com/layup-app/layup/protocol"
)

// recorder is an Injector that records instead of touching the OS, so the
// routing and validation rules are testable without moving a real pointer.
type recorder struct {
	moves    []PointerMove
	buttons  []PointerButton
	wheels   []PointerWheel
	keys     []Key
	released int
	err      error
	caps     protocol.HelperCapabilities
}

func (r *recorder) Capabilities() protocol.HelperCapabilities { return r.caps }

func (r *recorder) MoveTo(x, y float64) error {
	if r.err != nil {
		return r.err
	}
	r.moves = append(r.moves, PointerMove{X: x, Y: y})
	return nil
}

func (r *recorder) Button(button inject.Button, down bool) error {
	if r.err != nil {
		return r.err
	}
	r.buttons = append(r.buttons, PointerButton{Button: string(button), Down: down})
	return nil
}

func (r *recorder) Wheel(deltaX, deltaY int) error {
	if r.err != nil {
		return r.err
	}
	r.wheels = append(r.wheels, PointerWheel{DeltaX: deltaX, DeltaY: deltaY})
	return nil
}

func (r *recorder) Key(code string, down bool) error {
	if r.err != nil {
		return r.err
	}
	r.keys = append(r.keys, Key{Code: code, Down: down})
	return nil
}

func (r *recorder) ReleaseAll() int {
	r.released++
	return len(r.buttons)
}

func request(command string, payload any) protocol.HelperRequest {
	raw, _ := json.Marshal(payload)
	return protocol.HelperRequest{
		Version: protocol.HelperProtocolVersion,
		ID:      "1",
		Command: command,
		Payload: raw,
	}
}

func TestPointerCommandsReachTheInjector(t *testing.T) {
	r := &recorder{}

	if got := Handle(request(protocol.HelperCommandPointerMove, PointerMove{X: 100.5, Y: 250}), r); !got.OK {
		t.Fatalf("move should succeed: %+v", got)
	}
	if len(r.moves) != 1 || r.moves[0].X != 100.5 {
		t.Fatalf("unexpected moves: %+v", r.moves)
	}

	// Click, right-click and middle-click all route through.
	for _, button := range []string{"left", "right", "middle"} {
		if got := Handle(request(protocol.HelperCommandPointerButton,
			PointerButton{Button: button, Down: true}), r); !got.OK {
			t.Fatalf("%s down should succeed: %+v", button, got)
		}
		if got := Handle(request(protocol.HelperCommandPointerButton,
			PointerButton{Button: button, Down: false}), r); !got.OK {
			t.Fatalf("%s up should succeed: %+v", button, got)
		}
	}
	if len(r.buttons) != 6 {
		t.Fatalf("expected three press/release pairs, got %+v", r.buttons)
	}

	if got := Handle(request(protocol.HelperCommandPointerWheel, PointerWheel{DeltaY: -3}), r); !got.OK {
		t.Fatalf("wheel should succeed: %+v", got)
	}
	if len(r.wheels) != 1 || r.wheels[0].DeltaY != -3 {
		t.Fatalf("unexpected wheel: %+v", r.wheels)
	}
}

func TestMissingPermissionProducesAnActionableState(t *testing.T) {
	// What the injector does when macOS has not granted Accessibility.
	r := &recorder{
		err: errors.New("accessibility permission is not granted; macOS would ignore this event"),
		caps: protocol.HelperCapabilities{
			Platform: "darwin",
			Detail: "macOS Accessibility permission is missing: open Privacy & Security → " +
				"Accessibility, tick Layup, then restart it.",
		},
	}

	response := Handle(request(protocol.HelperCommandPointerMove, PointerMove{X: 1, Y: 1}), r)
	if response.OK {
		t.Fatal("a move without permission must fail rather than appear to work")
	}
	if response.Code != protocol.HelperErrNotPermitted {
		t.Fatalf("unexpected code %q", response.Code)
	}

	// The capability report tells the person exactly what to do.
	caps := Handle(request(protocol.HelperCommandCapabilities, nil), r)
	var reported protocol.HelperCapabilities
	if err := json.Unmarshal(caps.Payload, &reported); err != nil {
		t.Fatal(err)
	}
	if reported.PointerMove {
		t.Fatal("capabilities must not claim pointer control without permission")
	}
	if reported.Detail == "" {
		t.Fatal("a missing permission needs an actionable explanation")
	}
}

func TestPayloadsAreValidatedBeforeTheOSIsTouched(t *testing.T) {
	r := &recorder{}

	cases := []struct {
		name    string
		request protocol.HelperRequest
	}{
		{"no payload", protocol.HelperRequest{Version: 1, ID: "1", Command: protocol.HelperCommandPointerMove}},
		{"unknown button", request(protocol.HelperCommandPointerButton, PointerButton{Button: "extra"})},
		{"non-finite move", request(protocol.HelperCommandPointerMove, map[string]any{"x": "NaN", "y": 1})},
		{"unknown field", request(protocol.HelperCommandPointerMove, map[string]any{"x": 1, "y": 1, "z": 1})},
		{"runaway wheel", request(protocol.HelperCommandPointerWheel, PointerWheel{DeltaY: 100000})},
		{"key with no code", request(protocol.HelperCommandKey, Key{Down: true})},
	}

	for _, testCase := range cases {
		response := Handle(testCase.request, r)
		if response.OK || response.Code != protocol.HelperErrMalformed {
			t.Errorf("%s: expected a malformed rejection, got %+v", testCase.name, response)
		}
	}

	// Nothing reached the OS.
	if len(r.moves)+len(r.buttons)+len(r.wheels)+len(r.keys) != 0 {
		t.Fatalf("a rejected payload must not be injected: %+v", r)
	}
}

func TestReleaseAllIsAlwaysAvailable(t *testing.T) {
	r := &recorder{}
	if got := Handle(request(protocol.HelperCommandReleaseAll, nil), r); !got.OK {
		t.Fatalf("release_all should always succeed: %+v", got)
	}
	if r.released != 1 {
		t.Fatalf("expected the injector to be told to release, got %d", r.released)
	}
}

func TestKeyboardIsNotClaimedYet(t *testing.T) {
	// P1-0504 implements it; until then the helper refuses honestly.
	r := &recorder{err: fmt.Errorf("keyboard injection is not implemented yet (P1-0504)")}
	response := Handle(request(protocol.HelperCommandKey, Key{Code: "KeyA", Down: true}), r)
	if response.OK {
		t.Fatal("keyboard injection must not claim success before it exists")
	}
}
