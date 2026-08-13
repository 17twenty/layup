// Package directory provides the user/organisation directory.
//
// PLAN-1 ships a deterministic development directory: fixed people in one
// development organisation, no passwords, no tokens, no external identity
// provider. OIDC/SAML and enterprise directory sync are explicitly PLAN-2
// (SPEC.md §17, Stage 10).
package directory

import (
	"fmt"
	"sort"
	"strings"

	"github.com/layup-app/layup/services/control/internal/domain"
)

// Directory answers "who exists" inside one organisation boundary.
type Directory interface {
	Organisation() domain.Organisation
	Users() []domain.User
	UserByID(domain.UserID) (domain.User, error)
	// Resolve accepts a handle ("karl") or a user id and returns the user.
	Resolve(string) (domain.User, error)
}

// DevHandles are the development identities, in display order.
var DevHandles = []string{"nick", "karl", "emelia", "priya"}

const (
	devOrganisationName = "Layup Development"
	// DevOrganisationID is stable across restarts so two locally running
	// clients always agree about the organisation boundary.
	DevOrganisationID = domain.OrganisationID("org_devlayup")
)

type devUser struct {
	handle        string
	displayName   string
	statusMessage string
}

var devUsers = []devUser{
	{handle: "nick", displayName: "Nick", statusMessage: "Building Layup"},
	{handle: "karl", displayName: "Karl", statusMessage: "Auth is doing something dumb"},
	{handle: "emelia", displayName: "Emelia", statusMessage: "Reviewing the capture path"},
	{handle: "priya", displayName: "Priya", statusMessage: "On the TURN deployment"},
}

// DevUserID derives a stable, valid user id from a handle. No randomness, so
// restarting the service does not invalidate a running client's view.
func DevUserID(handle string) domain.UserID {
	body := "dev" + strings.ToLower(strings.TrimSpace(handle))
	for len(body) < 8 {
		body += "x"
	}
	return domain.UserID("usr_" + body)
}

// Dev is the deterministic development directory.
type Dev struct {
	org     domain.Organisation
	users   []domain.User
	byID    map[domain.UserID]domain.User
	byLogin map[string]domain.User
}

// NewDev builds the development directory: one organisation, four people.
func NewDev() *Dev {
	org := domain.Organisation{
		ID:     DevOrganisationID,
		Name:   devOrganisationName,
		Policy: domain.DefaultPolicy(),
	}
	d := &Dev{
		org:     org,
		byID:    map[domain.UserID]domain.User{},
		byLogin: map[string]domain.User{},
	}
	for _, u := range devUsers {
		user := domain.User{
			ID:             DevUserID(u.handle),
			OrganisationID: org.ID,
			DisplayName:    u.displayName,
			StatusMessage:  u.statusMessage,
		}
		if err := user.Validate(); err != nil {
			// A malformed fixture is a programming error, caught at startup.
			panic(fmt.Sprintf("layup: invalid development user %q: %v", u.handle, err))
		}
		d.users = append(d.users, user)
		d.byID[user.ID] = user
		d.byLogin[u.handle] = user
	}
	return d
}

// Organisation returns the development organisation.
func (d *Dev) Organisation() domain.Organisation { return d.org }

// Users returns every development user in display order.
func (d *Dev) Users() []domain.User {
	out := make([]domain.User, len(d.users))
	copy(out, d.users)
	sort.SliceStable(out, func(i, j int) bool { return out[i].DisplayName < out[j].DisplayName })
	return out
}

// UserByID looks up a user by identifier.
func (d *Dev) UserByID(id domain.UserID) (domain.User, error) {
	user, ok := d.byID[id]
	if !ok {
		return domain.User{}, fmt.Errorf("%w: user %q", domain.ErrNotFound, id)
	}
	return user, nil
}

// Resolve accepts a handle or a user id.
func (d *Dev) Resolve(reference string) (domain.User, error) {
	reference = strings.ToLower(strings.TrimSpace(reference))
	if user, ok := d.byLogin[reference]; ok {
		return user, nil
	}
	if user, ok := d.byID[domain.UserID(reference)]; ok {
		return user, nil
	}
	return domain.User{}, fmt.Errorf("%w: no development user %q (known: %s)",
		domain.ErrNotFound, reference, strings.Join(DevHandles, ", "))
}
