package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"github.com/layup-app/layup/services/control/internal/directory"
)

// maxRegisterBody bounds the request: a join code and a display name need very
// little room, and an unbounded reader on a public route is a free denial of
// service.
const maxRegisterBody = 4096

// RegisterRequest is the body of POST /api/register.
type RegisterRequest struct {
	Code        string `json:"code"`
	DisplayName string `json:"displayName"`
}

// RegisterResponse hands back the identity and the token that proves it. The
// token is shown to the client exactly once and stored by the client.
type RegisterResponse struct {
	Token        string          `json:"token"`
	User         UserDTO         `json:"user"`
	Organisation OrganisationDTO `json:"organisation"`
}

// handleRegister lets a person join this server with the shared join code.
//
// It is deliberately public and deliberately gated: without a configured join
// code nobody may register at all, because a server that quietly accepts
// everybody is worse than one that accepts nobody.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	registrar, ok := s.directory.(*directory.Hosted)
	if !ok {
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden",
			"this server does not accept registrations")
		return
	}

	var body RegisterRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRegisterBody)).Decode(&body); err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", "malformed body")
		return
	}

	// Constant time, and the configured code is never echoed back. The empty
	// case is checked first and separately: ConstantTimeCompare("", "")
	// returns 1, so an unconfigured server would otherwise admit everybody
	// who sent no code at all.
	if s.cfg.JoinCode == "" ||
		subtle.ConstantTimeCompare([]byte(body.Code), []byte(s.cfg.JoinCode)) != 1 {
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden",
			"that join code is not valid for this server")
		return
	}

	user, token, err := registrar.Register(body.DisplayName)
	if err != nil {
		status, code := statusForDomainError(err)
		s.writeAPIError(w, r, status, code, err.Error())
		return
	}

	// Logged without the token, on purpose.
	s.log.InfoContext(r.Context(), "registered a new identity",
		"userId", string(user.ID), "displayName", user.DisplayName)

	s.writeEnvelope(w, r, "identity.registered", RegisterResponse{
		Token:        token,
		User:         userDTO(user),
		Organisation: organisationDTO(registrar.Organisation()),
	})
}
