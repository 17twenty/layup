package domain

import (
	"errors"
	"testing"
	"time"
)

func TestIDsAreOpaqueAndTypeDistinct(t *testing.T) {
	g := NewRandomIDs()
	user := NewUserID(g)
	membership := NewMembershipID(g)

	if err := user.Validate(); err != nil {
		t.Fatalf("generated user id must validate: %v", err)
	}
	if err := membership.Validate(); err != nil {
		t.Fatalf("generated membership id must validate: %v", err)
	}
	// The compiler prevents assigning one to the other; the prefixes make the
	// mistake visible at a boundary too.
	if err := MembershipID(user).Validate(); err == nil {
		t.Fatal("a user id must not validate as a membership id")
	}
	if err := UserID(membership).Validate(); err == nil {
		t.Fatal("a membership id must not validate as a user id")
	}
}

func TestIDsAreUnique(t *testing.T) {
	g := NewRandomIDs()
	seen := make(map[MembershipID]bool, 1000)
	for i := 0; i < 1000; i++ {
		id := NewMembershipID(g)
		if seen[id] {
			t.Fatalf("duplicate membership id %q", id)
		}
		seen[id] = true
	}
}

func TestValidateIDRejectsJunk(t *testing.T) {
	for _, id := range []string{"", "usr", "usr_", "usr_short", "usr_UPPERCASE", "usr_has space", "mem_abcdefgh1"} {
		if err := ValidateID(id, "usr"); err == nil {
			t.Errorf("expected %q to be rejected", id)
		} else if !errors.Is(err, ErrInvalid) {
			t.Errorf("expected ErrInvalid for %q, got %v", id, err)
		}
	}
}

func TestSequentialIDsAreDeterministicAndValid(t *testing.T) {
	a, b := NewSequentialIDs(), NewSequentialIDs()
	first, second := NewUserID(a), NewUserID(a)
	if first == second {
		t.Fatal("sequential ids must differ")
	}
	if got := NewUserID(b); got != first {
		t.Fatalf("sequential ids must be reproducible: %q vs %q", got, first)
	}
	if err := first.Validate(); err != nil {
		t.Fatalf("fixture ids must pass production validation: %v", err)
	}
}

func TestUserValidation(t *testing.T) {
	g := NewSequentialIDs()
	valid := User{ID: NewUserID(g), OrganisationID: NewOrganisationID(g), DisplayName: "Karl"}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid user: %v", err)
	}

	noName := valid
	noName.DisplayName = "  "
	if err := noName.Validate(); !errors.Is(err, ErrInvalid) {
		t.Errorf("expected empty display name to be rejected, got %v", err)
	}

	badOrg := valid
	badOrg.OrganisationID = "nope"
	if err := badOrg.Validate(); !errors.Is(err, ErrInvalid) {
		t.Errorf("expected invalid organisation id to be rejected, got %v", err)
	}
}

func TestLayupSupportsZeroOrOneCreatorMembership(t *testing.T) {
	g := NewSequentialIDs()
	creator := NewMembershipID(g)
	other := NewMembershipID(g)
	layup := Layup{
		ID:                  NewLayupID(g),
		OrganisationID:      NewOrganisationID(g),
		Visibility:          VisibilityPrivate,
		CreatedAt:           time.Now(),
		CreatorMembershipID: &creator,
	}

	if err := layup.Validate(); err != nil {
		t.Fatalf("expected valid layup: %v", err)
	}
	if !layup.HasCreatorAuthority() || !layup.IsCreatorMembership(creator) {
		t.Fatal("creator membership should hold creator authority")
	}
	if layup.IsCreatorMembership(other) {
		t.Fatal("another membership must not hold creator authority")
	}

	// Devolved: creator authority simply stops existing.
	layup.CreatorMembershipID = nil
	if err := layup.Validate(); err != nil {
		t.Fatalf("a layup with no creator must remain valid: %v", err)
	}
	if layup.HasCreatorAuthority() || layup.IsCreatorMembership(creator) {
		t.Fatal("creator authority must be gone once the creator membership is cleared")
	}
	if !layup.Active() {
		t.Fatal("losing the creator must not end the layup")
	}
}

func TestLayupValidationRejectsUnknownVisibility(t *testing.T) {
	g := NewSequentialIDs()
	layup := Layup{ID: NewLayupID(g), OrganisationID: NewOrganisationID(g), Visibility: "PUBLIC"}
	if err := layup.Validate(); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected unknown visibility to be rejected, got %v", err)
	}
	if VisibilityOrganisation.Open() != true || VisibilityPrivate.Open() != false {
		t.Fatal("only ORGANISATION layups are open")
	}
}

func TestMembershipIsIndependentOfUser(t *testing.T) {
	g := NewSequentialIDs()
	user := NewUserID(g)
	layup := NewLayupID(g)
	joined := time.Now()

	first := Membership{ID: NewMembershipID(g), LayupID: layup, UserID: user, JoinedAt: joined, IsCreatorMembership: true}
	left := joined.Add(time.Minute)
	first.LeftAt = &left

	// Same user, new incarnation: new ID, ordinary membership.
	second := Membership{ID: NewMembershipID(g), LayupID: layup, UserID: user, JoinedAt: left.Add(time.Second)}

	if first.ID == second.ID {
		t.Fatal("a rejoin must produce a new membership id")
	}
	if second.IsCreatorMembership {
		t.Fatal("a rejoining user must not be a creator membership")
	}
	if first.Active() {
		t.Fatal("a membership that left is not active")
	}
	if !second.Active() {
		t.Fatal("the new membership should be active")
	}
	if err := second.Validate(); err != nil {
		t.Fatalf("expected valid membership: %v", err)
	}
}

func TestCapabilitiesAndDefaultPolicy(t *testing.T) {
	for _, c := range []Capability{
		CapabilityViewScreen, CapabilityShareScreen, CapabilityDraw,
		CapabilityControlPointer, CapabilityControlKeyboard,
		CapabilityShareAudio, CapabilityShareCamera,
	} {
		if !c.Valid() {
			t.Errorf("%q should be a valid capability", c)
		}
	}
	if Capability("SUDO").Valid() {
		t.Error("unknown capabilities must be rejected")
	}

	p := DefaultPolicy()
	if p.AutoMuteThreshold != 5 || !p.CameraOnJoin || !p.MicrophoneOnJoin {
		t.Fatalf("default policy must match SPEC §15: %+v", p)
	}
}
