package httpapi

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"strings"
	"sync"
	"time"

	"github.com/layup-app/layup/services/control/internal/domain"
)

// A guest session is a browser visitor's presence inside exactly one layup,
// reached by a link rather than by registering with this server.
//
// It mirrors linkStore (links.go) on purpose: an opaque, unguessable token
// mapping to a record, held only in memory, resolved in constant time. It is
// never persisted and never outlives the process - a guest who wants back in
// after a restart uses the link again, the same as anyone else.
const guestTokenBytes = 16

// GuestSession is what a guest token stands for: which layup, which
// membership inside it, which (guest) user, and the name they gave.
type GuestSession struct {
	Token        string
	LayupID      domain.LayupID
	MembershipID domain.MembershipID
	UserID       domain.UserID
	DisplayName  string
}

type guestStore struct {
	mu      sync.RWMutex
	byToken map[string]GuestSession
	byUser  map[domain.UserID]string // userID -> token, so displayName can look up without a token
	now     func() time.Time
}

func newGuestStore(now func() time.Time) *guestStore {
	if now == nil {
		now = time.Now
	}
	return &guestStore{
		byToken: map[string]GuestSession{},
		byUser:  map[domain.UserID]string{},
		now:     now,
	}
}

// newGuestUserID mints a fresh guest user id.
//
// It adapts domain.NewUserID(domain.NewRandomIDs()) - the same machinery every
// other user id in this service is minted with - rather than hand-rolling a
// generator. A hand-rolled hex generator (fmt.Sprintf("usr_%x", ...)) fails
// domain.ValidateID on almost every call: the id alphabet is lowercase
// base32-ish (abcdefghijklmnopqrstuvwxyz234567), and hex digits 0189 sit
// outside it. Instead this takes a real generated id, usr_<random>, and
// splices in a "g" marker right after the prefix: usr_g<random>. The result
// still starts "usr_", the body is still built entirely from
// domain.NewRandomIDs()'s own alphabet, and it is a few characters longer than
// a normal user id - all of which domain.ValidateID accepts.
func newGuestUserID() domain.UserID {
	id := domain.NewUserID(domain.NewRandomIDs())
	body := strings.TrimPrefix(string(id), "usr_")
	return domain.UserID("usr_g" + body)
}

// create mints a new guest session for a freshly-assigned guest user id and
// membership inside layupID.
func (s *guestStore) create(
	layupID domain.LayupID,
	membershipID domain.MembershipID,
	userID domain.UserID,
	displayName string,
) (GuestSession, error) {
	buf := make([]byte, guestTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		panic("layup: cannot generate a guest session token: " + err.Error())
	}
	token := base64.RawURLEncoding.EncodeToString(buf)

	session := GuestSession{
		Token:        token,
		LayupID:      layupID,
		MembershipID: membershipID,
		UserID:       userID,
		DisplayName:  displayName,
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.byToken[token] = session
	s.byUser[userID] = token
	return session, nil
}

// resolve looks a token up in constant time with respect to the token value.
func (s *guestStore) resolve(token string) (GuestSession, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for candidate, session := range s.byToken {
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(token)) == 1 {
			return session, true
		}
	}
	return GuestSession{}, false
}

// endLayup drops every guest session belonging to layupID. Once a layup has
// ended, nothing about a guest's presence in it should be answerable, in the
// same way a link to that layup stops resolving.
func (s *guestStore) endLayup(layupID domain.LayupID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, session := range s.byToken {
		if session.LayupID == layupID {
			delete(s.byToken, token)
			delete(s.byUser, session.UserID)
		}
	}
}

// displayName answers the name a guest gave, for a userID that might not
// belong to a guest at all - a stranger's id simply is not found.
func (s *guestStore) displayName(userID domain.UserID) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	token, ok := s.byUser[userID]
	if !ok {
		return "", false
	}
	session, ok := s.byToken[token]
	if !ok {
		return "", false
	}
	return session.DisplayName, true
}
