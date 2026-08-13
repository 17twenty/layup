package httpapi

import (
	"net/http"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
)

// UserDTO is the wire shape of a directory user.
type UserDTO struct {
	ID            string `json:"id"`
	DisplayName   string `json:"displayName"`
	AvatarURL     string `json:"avatarUrl,omitempty"`
	StatusMessage string `json:"statusMessage,omitempty"`
}

// OrganisationDTO is the wire shape of an organisation.
type OrganisationDTO struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// DirectoryDTO is the payload of GET /api/directory.
type DirectoryDTO struct {
	Organisation OrganisationDTO `json:"organisation"`
	Users        []UserDTO       `json:"users"`
}

// MeDTO is the payload of GET /api/me.
type MeDTO struct {
	User         UserDTO         `json:"user"`
	Organisation OrganisationDTO `json:"organisation"`
}

func userDTO(u domain.User) UserDTO {
	return UserDTO{
		ID:            string(u.ID),
		DisplayName:   u.DisplayName,
		AvatarURL:     u.AvatarURL,
		StatusMessage: u.StatusMessage,
	}
}

func organisationDTO(o domain.Organisation) OrganisationDTO {
	return OrganisationDTO{ID: string(o.ID), Name: o.Name}
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}
	s.writeEnvelope(w, r, "identity.me", MeDTO{
		User:         userDTO(identity.User),
		Organisation: organisationDTO(s.directory.Organisation()),
	})
}

func (s *Server) handleDirectory(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}

	org := s.directory.Organisation()
	users := make([]UserDTO, 0, 8)
	for _, user := range s.directory.Users() {
		// Organisation boundary: only people in the caller's organisation.
		if user.OrganisationID != identity.OrganisationID() {
			continue
		}
		users = append(users, userDTO(user))
	}
	s.writeEnvelope(w, r, "directory.users", DirectoryDTO{
		Organisation: organisationDTO(org),
		Users:        users,
	})
}

// writeEnvelope wraps a payload in the shared protocol envelope.
func (s *Server) writeEnvelope(w http.ResponseWriter, r *http.Request, msgType string, payload any) {
	env, err := protocol.NewEnvelope(msgType, payload)
	if err != nil {
		s.writeAPIError(w, r, http.StatusInternalServerError, "internal_error", "failed to encode response")
		return
	}
	writeJSON(w, http.StatusOK, env)
}
