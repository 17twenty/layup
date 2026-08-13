package httpapi

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"sync"
	"time"

	"github.com/layup-app/layup/services/control/internal/domain"
)

// Invitation links are opaque random tokens, not encoded identifiers.
//
// A token reveals nothing: it is 128 bits of randomness that the server maps to
// a layup. Nothing about the layup - id, title, organisation - can be recovered
// from it, and a link cannot be forged by editing a field.
const (
	linkTokenBytes = 16
	// DefaultLinkTTL bounds how long a link stays usable.
	DefaultLinkTTL = 24 * time.Hour
)

type linkRecord struct {
	layupID   domain.LayupID
	createdBy domain.UserID
	expiresAt time.Time
}

type linkStore struct {
	mu     sync.RWMutex
	tokens map[string]linkRecord
	now    func() time.Time
}

func newLinkStore(now func() time.Time) *linkStore {
	if now == nil {
		now = time.Now
	}
	return &linkStore{tokens: map[string]linkRecord{}, now: now}
}

func (s *linkStore) mint(layup domain.LayupID, by domain.UserID, ttl time.Duration) (string, time.Time) {
	buf := make([]byte, linkTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		panic("layup: cannot generate an invitation link: " + err.Error())
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	expiresAt := s.now().Add(ttl)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[token] = linkRecord{layupID: layup, createdBy: by, expiresAt: expiresAt}
	return token, expiresAt
}

// resolve looks a token up in constant time with respect to the token value.
func (s *linkStore) resolve(token string) (linkRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for candidate, record := range s.tokens {
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(token)) == 1 {
			if s.now().After(record.expiresAt) {
				return linkRecord{}, false
			}
			return record, true
		}
	}
	return linkRecord{}, false
}

// LinkDTO is the payload of POST /api/layups/{id}/link.
type LinkDTO struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func (s *Server) handleCreateLink(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}
	if !s.directory.Organisation().Policy.LinkLayupsAllowed {
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden", "invitation links are not permitted here")
		return
	}

	layupID := domain.LayupID(r.PathValue("id"))
	if err := layupID.Validate(); err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	view, err := s.layups.View(r.Context(), layupID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	// Only someone inside may hand out a way in.
	if membershipOf(view, identity.User.ID) == "" {
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden", "you are not in this layup")
		return
	}
	if !view.Active() {
		s.writeAPIError(w, r, http.StatusConflict, "conflict", "this layup has ended")
		return
	}

	token, expiresAt := s.links.mint(layupID, identity.User.ID, DefaultLinkTTL)
	s.log.InfoContext(r.Context(), "invitation link created",
		"layupId", string(layupID), "userId", string(identity.User.ID))
	s.writeEnvelope(w, r, "layup.link", LinkDTO{Token: token, ExpiresAt: expiresAt})
}

func (s *Server) handleJoinByLink(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}
	if !s.directory.Organisation().Policy.LinkLayupsAllowed {
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden", "invitation links are not permitted here")
		return
	}

	record, ok := s.links.resolve(r.PathValue("token"))
	if !ok {
		// One message for "never existed" and "no longer valid": a link is not
		// an oracle for which layups exist.
		s.writeAPIError(w, r, http.StatusGone, "invalid_link",
			"this invitation link is not valid any more - ask for a new one")
		return
	}

	view, err := s.layups.View(r.Context(), record.layupID)
	if err != nil {
		s.writeAPIError(w, r, http.StatusGone, "invalid_link",
			"this invitation link is not valid any more - ask for a new one")
		return
	}
	if !view.Active() {
		s.writeAPIError(w, r, http.StatusGone, "invalid_link", "that layup has ended")
		return
	}
	if view.Layup.OrganisationID != identity.OrganisationID() {
		// Enterprise policy: a link never crosses the organisation boundary.
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden",
			"this link belongs to another organisation")
		return
	}

	joined, membership, err := s.layups.Join(r.Context(), record.layupID, identity.User.ID)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}
	s.afterLayupChange(r.Context(), joined, identity.User)
	s.writeEnvelope(w, r, "layup.joined", MembershipResultDTO{
		Layup:            s.layupDTO(joined),
		YourMembershipID: string(membership.ID),
	})
}
