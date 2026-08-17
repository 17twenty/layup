package directory_test

import (
	"path/filepath"
	"testing"

	"github.com/layup-app/layup/services/control/internal/directory"
)

func TestRegisteredUserAppearsInTheDirectory(t *testing.T) {
	dir, err := directory.NewHosted(filepath.Join(t.TempDir(), "identities.json"))
	if err != nil {
		t.Fatalf("NewHosted: %v", err)
	}

	user, token, err := dir.Register("Nick")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if user.DisplayName != "Nick" {
		t.Errorf("DisplayName = %q, want Nick", user.DisplayName)
	}
	if token == "" {
		t.Fatal("Register returned an empty token")
	}
	// Presence fans out over Users(); appearing here is what makes a
	// registered person visible to everybody else.
	if got := dir.Users(); len(got) != 1 || got[0].ID != user.ID {
		t.Errorf("Users() = %v, want the registered user", got)
	}
	if found, ok := dir.ResolveToken(token); !ok || found.ID != user.ID {
		t.Errorf("ResolveToken did not return the registered user")
	}
	if _, ok := dir.ResolveToken("not-a-token"); ok {
		t.Error("ResolveToken accepted a forged token")
	}
}

func TestIdentitiesSurviveARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identities.json")
	first, err := directory.NewHosted(path)
	if err != nil {
		t.Fatalf("NewHosted: %v", err)
	}
	user, token, err := first.Register("Karl")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	// A redeploy restarts the process. Both people must not have to re-onboard.
	second, err := directory.NewHosted(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	found, ok := second.ResolveToken(token)
	if !ok || found.ID != user.ID || found.DisplayName != "Karl" {
		t.Errorf("identity did not survive a restart: %v %v", found, ok)
	}
}

func TestTwoRegistrationsGetDistinctIdentities(t *testing.T) {
	dir, err := directory.NewHosted(filepath.Join(t.TempDir(), "identities.json"))
	if err != nil {
		t.Fatalf("NewHosted: %v", err)
	}
	a, tokenA, _ := dir.Register("Nick")
	b, tokenB, _ := dir.Register("Nick")
	if a.ID == b.ID {
		t.Error("two registrations shared a user id")
	}
	if tokenA == tokenB {
		t.Error("two registrations shared a token")
	}
}

func TestRegisterRejectsAnEmptyName(t *testing.T) {
	dir, _ := directory.NewHosted(filepath.Join(t.TempDir(), "identities.json"))
	if _, _, err := dir.Register("   "); err == nil {
		t.Error("Register accepted a blank display name")
	}
}
