package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Domain error sentinels. Transport layers map these onto status codes.
var (
	// ErrInvalid means the caller supplied something structurally wrong.
	ErrInvalid = errors.New("invalid")
	// ErrNotFound means the referenced entity does not exist.
	ErrNotFound = errors.New("not found")
	// ErrConflict means the operation contradicts current state.
	ErrConflict = errors.New("conflict")
	// ErrForbidden means the actor is not permitted to do this.
	ErrForbidden = errors.New("forbidden")
)

// Organisation is the enterprise tenant boundary. Everything a user can see is
// scoped by it; organisation IDs are never taken from client input.
type Organisation struct {
	ID        OrganisationID
	Name      string
	CreatedAt time.Time
	Policy    Policy
}

// User is a stable human identity inside one organisation.
type User struct {
	ID             UserID
	OrganisationID OrganisationID
	DisplayName    string
	AvatarURL      string
	StatusMessage  string
}

// Validate checks a user is well formed.
func (u User) Validate() error {
	if err := u.ID.Validate(); err != nil {
		return err
	}
	if err := u.OrganisationID.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(u.DisplayName) == "" {
		return fmt.Errorf("%w: user display name must not be empty", ErrInvalid)
	}
	if len(u.DisplayName) > 80 {
		return fmt.Errorf("%w: user display name is too long", ErrInvalid)
	}
	if len(u.StatusMessage) > 140 {
		return fmt.Errorf("%w: status message is too long", ErrInvalid)
	}
	return nil
}

// Visibility controls who may discover and enter a layup (SPEC.md §3.3).
type Visibility string

const (
	// VisibilityPrivate admits only invited or accepted participants.
	VisibilityPrivate Visibility = "PRIVATE"
	// VisibilityOrganisation is discoverable and joinable by the organisation.
	VisibilityOrganisation Visibility = "ORGANISATION"
	// VisibilityLink admits holders of a valid link, subject to policy.
	VisibilityLink Visibility = "LINK"
)

// Valid reports whether v is a known visibility.
func (v Visibility) Valid() bool {
	switch v {
	case VisibilityPrivate, VisibilityOrganisation, VisibilityLink:
		return true
	}
	return false
}

// Open reports whether outsiders in the organisation may see details and join.
func (v Visibility) Open() bool { return v == VisibilityOrganisation }

// Layup is an ephemeral shared space. It is ACTIVE while at least one
// membership is active and needs no owner to stay alive (SPEC.md §2.2).
type Layup struct {
	ID             LayupID
	OrganisationID OrganisationID
	Title          string
	Visibility     Visibility
	CreatedAt      time.Time
	EndedAt        *time.Time

	// CreatorMembershipID is the membership that created the layup. It is
	// cleared forever when that membership leaves: creator privilege devolves
	// to nobody and is never reassigned (SPEC.md §2.2, ARCHITECTURE.md §4).
	CreatorMembershipID *MembershipID

	DrawingDefault bool
	ControlDefault bool

	// ActiveScreenShareID is the single active shared desktop, if any.
	ActiveScreenShareID *ScreenShareID
}

// Active reports whether the layup has not ended.
func (l Layup) Active() bool { return l.EndedAt == nil }

// HasCreatorAuthority reports whether creator privilege still exists at all.
// Once the creator membership leaves this is false forever.
func (l Layup) HasCreatorAuthority() bool { return l.CreatorMembershipID != nil }

// IsCreatorMembership reports whether the given membership holds creator
// privilege. It deliberately takes a MembershipID, never a UserID.
func (l Layup) IsCreatorMembership(id MembershipID) bool {
	return l.CreatorMembershipID != nil && *l.CreatorMembershipID == id
}

// Validate checks a layup is well formed.
func (l Layup) Validate() error {
	if err := l.ID.Validate(); err != nil {
		return err
	}
	if err := l.OrganisationID.Validate(); err != nil {
		return err
	}
	if !l.Visibility.Valid() {
		return fmt.Errorf("%w: unknown visibility %q", ErrInvalid, l.Visibility)
	}
	if len(l.Title) > 120 {
		return fmt.Errorf("%w: layup title is too long", ErrInvalid)
	}
	if l.CreatorMembershipID != nil {
		if err := l.CreatorMembershipID.Validate(); err != nil {
			return err
		}
	}
	if l.EndedAt != nil && l.EndedAt.Before(l.CreatedAt) {
		return fmt.Errorf("%w: layup ended before it started", ErrInvalid)
	}
	return nil
}

// Membership is one incarnation of a user inside one layup. Rejoining creates a
// new Membership with a new ID; it never revives the previous one.
type Membership struct {
	ID       MembershipID
	LayupID  LayupID
	UserID   UserID
	JoinedAt time.Time
	LeftAt   *time.Time

	// IsCreatorMembership is set only on the membership that created the layup.
	// It is never set on a later membership, including a rejoin by the same user.
	IsCreatorMembership bool
}

// Active reports whether the membership has not left.
func (m Membership) Active() bool { return m.LeftAt == nil }

// Validate checks a membership is well formed.
func (m Membership) Validate() error {
	if err := m.ID.Validate(); err != nil {
		return err
	}
	if err := m.LayupID.Validate(); err != nil {
		return err
	}
	if err := m.UserID.Validate(); err != nil {
		return err
	}
	if m.LeftAt != nil && m.LeftAt.Before(m.JoinedAt) {
		return fmt.Errorf("%w: membership left before it joined", ErrInvalid)
	}
	return nil
}

// Capability is a per-participant permission. The UI collapses these into two
// switches, but the model stays per-participant (SPEC.md §3.7).
type Capability string

const (
	CapabilityViewScreen      Capability = "VIEW_SCREEN"
	CapabilityShareScreen     Capability = "SHARE_SCREEN"
	CapabilityDraw            Capability = "DRAW"
	CapabilityControlPointer  Capability = "CONTROL_POINTER"
	CapabilityControlKeyboard Capability = "CONTROL_KEYBOARD"
	CapabilityShareAudio      Capability = "SHARE_AUDIO"
	CapabilityShareCamera     Capability = "SHARE_CAMERA"
)

// Valid reports whether c is a known capability.
func (c Capability) Valid() bool {
	switch c {
	case CapabilityViewScreen, CapabilityShareScreen, CapabilityDraw,
		CapabilityControlPointer, CapabilityControlKeyboard,
		CapabilityShareAudio, CapabilityShareCamera:
		return true
	}
	return false
}

// Policy is the organisation-level upper bound on behaviour (SPEC.md §15).
// Personal preference and layup settings may only narrow it.
type Policy struct {
	CameraOnJoin            bool
	MicrophoneOnJoin        bool
	AutoMuteThreshold       int
	DrawingDefault          bool
	RemoteControlDefault    bool
	RemoteControlAllowed    bool
	OrganisationOpenAllowed bool
	LinkLayupsAllowed       bool
	RequestTTL              time.Duration
}

// DefaultPolicy matches the example policy in SPEC.md §15.
func DefaultPolicy() Policy {
	return Policy{
		CameraOnJoin:            true,
		MicrophoneOnJoin:        true,
		AutoMuteThreshold:       5,
		DrawingDefault:          true,
		RemoteControlDefault:    true,
		RemoteControlAllowed:    true,
		OrganisationOpenAllowed: true,
		LinkLayupsAllowed:       true,
		RequestTTL:              60 * time.Second,
	}
}
