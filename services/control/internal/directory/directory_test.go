package directory

import (
	"errors"
	"testing"

	"github.com/layup-app/layup/services/control/internal/domain"
)

func TestDevDirectoryHasAtLeastFourDeterministicUsers(t *testing.T) {
	first, second := NewDev(), NewDev()

	if len(first.Users()) < 4 {
		t.Fatalf("expected at least four development users, got %d", len(first.Users()))
	}
	for i, user := range first.Users() {
		if user.ID != second.Users()[i].ID {
			t.Fatalf("user ids must be stable across restarts: %q vs %q", user.ID, second.Users()[i].ID)
		}
		if err := user.Validate(); err != nil {
			t.Fatalf("development user %q must be valid: %v", user.DisplayName, err)
		}
	}
}

func TestAllDevUsersShareTheDevelopmentOrganisation(t *testing.T) {
	d := NewDev()
	org := d.Organisation()
	if org.ID != DevOrganisationID {
		t.Fatalf("unexpected organisation id %q", org.ID)
	}
	if org.Policy.AutoMuteThreshold != 5 {
		t.Fatalf("development organisation should carry the default policy: %+v", org.Policy)
	}
	for _, user := range d.Users() {
		if user.OrganisationID != org.ID {
			t.Fatalf("user %q is outside the development organisation", user.DisplayName)
		}
	}
}

func TestResolveAcceptsHandleOrID(t *testing.T) {
	d := NewDev()
	byHandle, err := d.Resolve("karl")
	if err != nil {
		t.Fatalf("resolve by handle: %v", err)
	}
	byUpper, err := d.Resolve(" KARL ")
	if err != nil {
		t.Fatalf("resolve should be forgiving about case/space: %v", err)
	}
	byID, err := d.Resolve(string(byHandle.ID))
	if err != nil {
		t.Fatalf("resolve by id: %v", err)
	}
	if byHandle.ID != byID.ID || byHandle.ID != byUpper.ID {
		t.Fatal("all three lookups must agree")
	}
	if byHandle.DisplayName != "Karl" {
		t.Fatalf("unexpected display name %q", byHandle.DisplayName)
	}
}

func TestResolveRejectsUnknownIdentitiesWithGuidance(t *testing.T) {
	d := NewDev()
	_, err := d.Resolve("mallory")
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	for _, handle := range DevHandles {
		if !contains(err.Error(), handle) {
			t.Errorf("error should list known handle %q: %v", handle, err)
		}
	}
}

func TestDevUserIDIsStableAndValid(t *testing.T) {
	if DevUserID("nick") != DevUserID("NICK") {
		t.Fatal("handles are case-insensitive")
	}
	if err := DevUserID("nick").Validate(); err != nil {
		t.Fatalf("derived id must pass production validation: %v", err)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (len(needle) == 0 || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
