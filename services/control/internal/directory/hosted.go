package directory

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/layup-app/layup/services/control/internal/domain"
)

// HostedOrganisationID is stable so restarts do not move anybody between
// organisations.
//
// This must satisfy domain.ValidateID (body 8-32 chars from the id
// alphabet). "org_layup" does not - its body "layup" is only 5 characters -
// so this uses a longer body than the literal value in the task brief.
const HostedOrganisationID = domain.OrganisationID("org_layuphosted")

const hostedOrganisationName = "Layup"

// Hosted is a directory people register themselves into.
//
// It persists identities and their tokens, and nothing else: layups and
// presence remain in memory, because a restart genuinely does end a live layup
// (ARCHITECTURE.md §10).
type Hosted struct {
	mu     sync.RWMutex
	path   string
	org    domain.Organisation
	users  map[domain.UserID]domain.User
	tokens map[string]domain.UserID
}

type hostedFile struct {
	Users  []domain.User     `json:"users"`
	Tokens map[string]string `json:"tokens"`
}

// NewHosted opens, or creates, the identity store at path.
func NewHosted(path string) (*Hosted, error) {
	h := &Hosted{
		path: path,
		org: domain.Organisation{
			ID:     HostedOrganisationID,
			Name:   hostedOrganisationName,
			Policy: domain.DefaultPolicy(),
		},
		users:  map[domain.UserID]domain.User{},
		tokens: map[string]domain.UserID{},
	}
	if err := h.load(); err != nil {
		return nil, err
	}
	return h, nil
}

func (h *Hosted) load() error {
	raw, err := os.ReadFile(h.path)
	if os.IsNotExist(err) {
		return nil // a fresh server has nobody in it; that is not an error
	}
	if err != nil {
		return fmt.Errorf("layup: reading identity store: %w", err)
	}
	var file hostedFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return fmt.Errorf("layup: identity store is corrupt: %w", err)
	}
	for _, user := range file.Users {
		h.users[user.ID] = user
	}
	for token, id := range file.Tokens {
		h.tokens[token] = domain.UserID(id)
	}
	return nil
}

// save writes atomically: a half-written store would lock everybody out.
func (h *Hosted) save() error {
	file := hostedFile{Tokens: map[string]string{}}
	for _, user := range h.users {
		file.Users = append(file.Users, user)
	}
	sort.Slice(file.Users, func(i, j int) bool { return file.Users[i].ID < file.Users[j].ID })
	for token, id := range h.tokens {
		file.Tokens[token] = string(id)
	}
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(h.path), 0o750); err != nil {
		return err
	}
	tmp := h.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, h.path)
}

// newHostedID mints a fresh user id using the domain package's own generator,
// so it is valid by construction under domain.ValidateID. (The task brief's
// literal implementation, fmt.Sprintf("usr_%x", buf), produces hex digits
// like 0, 1, 8 and 9 that are outside the id alphabet
// ("abcdefghijklmnopqrstuvwxyz234567") and so fails validation on almost
// every call.)
func newHostedID() domain.UserID {
	return domain.NewUserID(domain.NewRandomIDs())
}

func newToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Register creates an identity and the token that proves it.
func (h *Hosted) Register(displayName string) (domain.User, string, error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return domain.User{}, "", fmt.Errorf("%w: a display name is required", domain.ErrInvalid)
	}

	id := newHostedID()
	token, err := newToken()
	if err != nil {
		return domain.User{}, "", err
	}
	user := domain.User{ID: id, OrganisationID: h.org.ID, DisplayName: displayName}
	if err := user.Validate(); err != nil {
		return domain.User{}, "", fmt.Errorf("%w: %v", domain.ErrInvalid, err)
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.users[user.ID] = user
	h.tokens[token] = user.ID
	if err := h.save(); err != nil {
		delete(h.users, user.ID)
		delete(h.tokens, token)
		return domain.User{}, "", err
	}
	return user, token, nil
}

// ResolveToken returns the user a bearer token belongs to.
func (h *Hosted) ResolveToken(token string) (domain.User, bool) {
	if token == "" {
		return domain.User{}, false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	id, ok := h.tokens[token]
	if !ok {
		return domain.User{}, false
	}
	user, ok := h.users[id]
	return user, ok
}

func (h *Hosted) Organisation() domain.Organisation { return h.org }

func (h *Hosted) Users() []domain.User {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]domain.User, 0, len(h.users))
	for _, user := range h.users {
		out = append(out, user)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].DisplayName < out[j].DisplayName })
	return out
}

func (h *Hosted) UserByID(id domain.UserID) (domain.User, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	user, ok := h.users[id]
	if !ok {
		return domain.User{}, fmt.Errorf("%w: user %q", domain.ErrNotFound, id)
	}
	return user, nil
}

// Resolve accepts a user id. A hosted directory has no handles: people are
// whoever they said they were when they registered.
func (h *Hosted) Resolve(reference string) (domain.User, error) {
	return h.UserByID(domain.UserID(strings.TrimSpace(reference)))
}
