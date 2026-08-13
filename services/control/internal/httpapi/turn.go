package httpapi

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"strconv"
	"time"
)

// TURN credentials follow the coturn REST convention: the username is an expiry
// timestamp joined to the user id, and the password is HMAC-SHA1 of that
// username under a secret shared with coturn (`use-auth-secret`).
//
// Layup does not implement TURN - it configures coturn and hands out short
// lived credentials for it (ARCHITECTURE.md §9).
const (
	// DefaultTurnCredentialTTL bounds how long an issued credential lives.
	DefaultTurnCredentialTTL = 12 * time.Hour
)

// IceServerDTO mirrors the browser's RTCIceServer.
type IceServerDTO struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// TurnDTO is the payload of GET /api/turn.
type TurnDTO struct {
	IceServers []IceServerDTO `json:"iceServers"`
	ExpiresAt  time.Time      `json:"expiresAt"`
	// ForceRelay is true when policy requires media to go through TURN.
	ForceRelay bool `json:"forceRelay"`
}

// turnCredential builds a coturn REST credential pair.
func turnCredential(secret, userID string, expiresAt time.Time) (string, string) {
	username := strconv.FormatInt(expiresAt.Unix(), 10) + ":" + userID
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Server) handleTurnCredentials(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}

	cfg := s.cfg
	expiresAt := s.now().Add(DefaultTurnCredentialTTL)
	servers := make([]IceServerDTO, 0, 2)

	if len(cfg.StunURLs) > 0 {
		servers = append(servers, IceServerDTO{URLs: cfg.StunURLs})
	}
	if len(cfg.TurnURLs) > 0 && cfg.TurnSecret != "" {
		username, credential := turnCredential(cfg.TurnSecret, string(identity.User.ID), expiresAt)
		servers = append(servers, IceServerDTO{
			URLs:       cfg.TurnURLs,
			Username:   username,
			Credential: credential,
		})
	}

	// The credential itself is never logged - only that one was issued.
	s.log.InfoContext(r.Context(), "issued ICE configuration",
		"userId", string(identity.User.ID),
		"stunServers", len(cfg.StunURLs),
		"turnServers", len(cfg.TurnURLs),
		"forceRelay", cfg.ForceRelay,
		"expiresAt", expiresAt.UTC().Format(time.RFC3339),
	)

	s.writeEnvelope(w, r, "turn.credentials", TurnDTO{
		IceServers: servers,
		ExpiresAt:  expiresAt,
		ForceRelay: cfg.ForceRelay,
	})
}
