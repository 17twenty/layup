package protocol

import (
	"errors"
	"strings"
	"testing"
)

func signed(secret, id, command string) HelperRequest {
	return HelperRequest{
		Version: HelperProtocolVersion,
		ID:      id,
		Command: command,
		Auth:    SignHelperRequest(secret, HelperProtocolVersion, id, command),
	}
}

func TestHelperAcceptsOnlyAuthenticatedAllowedCommands(t *testing.T) {
	const secret = "a-per-run-secret"

	for command := range AllowedHelperCommands {
		if err := VerifyHelperRequest(secret, signed(secret, "1", command)); err != nil {
			t.Fatalf("%s should be accepted: %v", command, err)
		}
	}
}

func TestHelperRejectsUnauthenticatedRequests(t *testing.T) {
	const secret = "a-per-run-secret"

	// No tag at all.
	unsigned := HelperRequest{Version: HelperProtocolVersion, ID: "1", Command: HelperCommandPointerMove}
	if err := VerifyHelperRequest(secret, unsigned); !errors.Is(err, ErrHelperUnauthenticated) {
		t.Fatalf("expected ErrHelperUnauthenticated, got %v", err)
	}

	// A tag from a different secret: knowing the socket is not enough.
	other := signed("someone-elses-secret", "1", HelperCommandPointerMove)
	if err := VerifyHelperRequest(secret, other); !errors.Is(err, ErrHelperUnauthenticated) {
		t.Fatalf("expected ErrHelperUnauthenticated, got %v", err)
	}

	// A tag for a *different command* cannot be replayed onto a stronger one.
	replay := signed(secret, "1", HelperCommandPointerMove)
	replay.Command = HelperCommandKey
	if err := VerifyHelperRequest(secret, replay); !errors.Is(err, ErrHelperUnauthenticated) {
		t.Fatalf("a signature must cover the command, got %v", err)
	}
}

func TestHelperRejectsUnknownCommands(t *testing.T) {
	const secret = "a-per-run-secret"
	// Correctly signed, but not on the allow-list: capability cannot be
	// smuggled in by naming it.
	request := signed(secret, "1", "shell.exec")
	err := VerifyHelperRequest(secret, request)
	if !errors.Is(err, ErrHelperUnknownCommand) {
		t.Fatalf("expected ErrHelperUnknownCommand, got %v", err)
	}
	if !strings.Contains(err.Error(), "shell.exec") {
		t.Fatalf("error should name the command: %v", err)
	}
}

func TestHelperRejectsMalformedRequests(t *testing.T) {
	const secret = "a-per-run-secret"

	for _, request := range []HelperRequest{
		{Version: 99, ID: "1", Command: HelperCommandPointerMove},
		{Version: HelperProtocolVersion, Command: HelperCommandPointerMove},
		{Version: HelperProtocolVersion, ID: "1"},
	} {
		if err := VerifyHelperRequest(secret, request); !errors.Is(err, ErrHelperMalformed) {
			t.Errorf("expected ErrHelperMalformed for %+v, got %v", request, err)
		}
	}
}

func TestHelperChecksAuthenticationBeforeTheAllowList(t *testing.T) {
	// An unauthenticated caller must not be able to probe which commands exist
	// by comparing error codes.
	err := VerifyHelperRequest("secret", HelperRequest{
		Version: HelperProtocolVersion,
		ID:      "1",
		Command: "shell.exec",
		Auth:    "not-a-real-tag",
	})
	if !errors.Is(err, ErrHelperUnauthenticated) {
		t.Fatalf("authentication must be checked first, got %v", err)
	}
}
