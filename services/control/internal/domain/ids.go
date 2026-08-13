// Package domain holds Layup's core business types and rules.
//
// It has no knowledge of HTTP, WebSockets, storage or WebRTC: the same
// semantics must hold whether media is peer-to-peer or (later) SFU-routed
// (ARCHITECTURE.md §3.3).
package domain

import (
	"crypto/rand"
	"encoding/base32"
	"fmt"
	"strings"
)

// Distinct ID types stop the single most dangerous confusion in this product:
// a Membership ID is never interchangeable with a User ID. Creator privilege
// belongs to a Membership, so mixing them up would silently resurrect authority
// that must be gone forever (SPEC.md §3.4).
type (
	// OrganisationID identifies an enterprise tenant.
	OrganisationID string
	// UserID identifies a stable human identity.
	UserID string
	// LayupID identifies an ephemeral shared space.
	LayupID string
	// MembershipID identifies one incarnation of a user inside one layup.
	MembershipID string
	// JoinRequestID identifies an invitation or knock.
	JoinRequestID string
	// ScreenShareID identifies one shared-desktop session.
	ScreenShareID string
)

const (
	prefixOrganisation = "org"
	prefixUser         = "usr"
	prefixLayup        = "lay"
	prefixMembership   = "mem"
	prefixJoinRequest  = "jrq"
	prefixScreenShare  = "shr"
)

// idAlphabet is lowercase base32 without padding: opaque, URL-safe, and easy to
// read out loud during a support call.
var idAlphabet = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// IDGenerator produces opaque identifiers. Tests substitute a deterministic one.
type IDGenerator interface {
	NewID(prefix string) string
}

type randomIDs struct{ size int }

// NewRandomIDs returns the production generator: 80 bits of randomness.
func NewRandomIDs() IDGenerator { return randomIDs{size: 10} }

func (g randomIDs) NewID(prefix string) string {
	buf := make([]byte, g.size)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand failing means the machine is broken; there is no safe
		// non-random fallback for identifiers.
		panic(fmt.Sprintf("layup: cannot generate identifier: %v", err))
	}
	return prefix + "_" + idAlphabet.EncodeToString(buf)
}

// Convenience constructors keep call sites from inventing prefixes.
//
// NewOrganisationID returns a fresh organisation identifier.
func NewOrganisationID(g IDGenerator) OrganisationID {
	return OrganisationID(g.NewID(prefixOrganisation))
}

// NewUserID returns a fresh user identifier.
func NewUserID(g IDGenerator) UserID { return UserID(g.NewID(prefixUser)) }

// NewLayupID returns a fresh layup identifier.
func NewLayupID(g IDGenerator) LayupID { return LayupID(g.NewID(prefixLayup)) }

// NewMembershipID returns a fresh membership identifier. Every join - including
// a rejoin by the same user - gets a new one.
func NewMembershipID(g IDGenerator) MembershipID { return MembershipID(g.NewID(prefixMembership)) }

// NewJoinRequestID returns a fresh invitation/knock identifier.
func NewJoinRequestID(g IDGenerator) JoinRequestID { return JoinRequestID(g.NewID(prefixJoinRequest)) }

// NewScreenShareID returns a fresh screen-share identifier.
func NewScreenShareID(g IDGenerator) ScreenShareID { return ScreenShareID(g.NewID(prefixScreenShare)) }

// idCharacters is the set an identifier body may contain (base32 alphabet).
const idCharacters = "abcdefghijklmnopqrstuvwxyz234567"

// ValidateID checks the shape of an identifier received from outside.
func ValidateID(id, prefix string) error {
	rest, ok := strings.CutPrefix(id, prefix+"_")
	if !ok {
		return fmt.Errorf("%w: expected an id starting %q, got %q", ErrInvalid, prefix+"_", id)
	}
	if len(rest) < 8 || len(rest) > 32 {
		return fmt.Errorf("%w: identifier %q has an implausible length", ErrInvalid, id)
	}
	for _, r := range rest {
		if !strings.ContainsRune(idCharacters, r) {
			return fmt.Errorf("%w: identifier %q contains %q", ErrInvalid, id, r)
		}
	}
	return nil
}

// Validate methods so handlers can check untrusted input without knowing prefixes.
func (id OrganisationID) Validate() error { return ValidateID(string(id), prefixOrganisation) }
func (id UserID) Validate() error         { return ValidateID(string(id), prefixUser) }
func (id LayupID) Validate() error        { return ValidateID(string(id), prefixLayup) }
func (id MembershipID) Validate() error   { return ValidateID(string(id), prefixMembership) }
func (id JoinRequestID) Validate() error  { return ValidateID(string(id), prefixJoinRequest) }
func (id ScreenShareID) Validate() error  { return ValidateID(string(id), prefixScreenShare) }

// SequentialIDs is a deterministic generator for tests and development
// fixtures. It is never used in production paths.
type SequentialIDs struct {
	counters map[string]int
}

// NewSequentialIDs returns a deterministic generator: usr_devaaaaab, ...
func NewSequentialIDs() *SequentialIDs { return &SequentialIDs{counters: map[string]int{}} }

// NewID implements IDGenerator. Bodies stay inside the production alphabet so
// fixtures pass the same validation as real identifiers.
func (g *SequentialIDs) NewID(prefix string) string {
	g.counters[prefix]++
	return prefix + "_dev" + letters(g.counters[prefix], 6)
}

// letters renders n in base 26 (a=0) padded to width.
func letters(n, width int) string {
	out := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		out[i] = byte('a' + n%26)
		n /= 26
	}
	return string(out)
}
