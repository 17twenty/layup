package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
)

// Realtime message types for the social loop.
const (
	// TypeRequestIncoming tells you someone wants you.
	TypeRequestIncoming = "request.incoming"
	// TypeRequestOutgoing echoes your own pending request back to you, so every
	// window you have open agrees about what is in flight.
	TypeRequestOutgoing = "request.outgoing"
	// TypeRequestResolved reports the end of a request to both sides.
	TypeRequestResolved = "request.resolved"
)

// RequestDTO is the wire shape of an invitation or knock.
//
// It is deliberately thin: a request never carries private layup detail to
// someone not entitled to it (SPEC.md §5.3). Context is added per recipient.
type RequestDTO struct {
	ID         string    `json:"id"`
	Type       string    `json:"type"`
	State      string    `json:"state"`
	FromUserID string    `json:"fromUserId"`
	FromName   string    `json:"fromName"`
	ToUserID   string    `json:"toUserId,omitempty"`
	ToName     string    `json:"toName,omitempty"`
	Note       string    `json:"note,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	// LayupID is present only when the recipient may know which layup this is.
	LayupID string `json:"layupId,omitempty"`
	// LayupTitle is present only for a layup whose title this person may see.
	LayupTitle string `json:"layupTitle,omitempty"`
	// ResultLayupID is set once an accepted request has produced a layup.
	ResultLayupID string `json:"resultLayupId,omitempty"`
}

// RequestListDTO is the payload of GET /api/requests.
type RequestListDTO struct {
	Incoming []RequestDTO `json:"incoming"`
	Outgoing []RequestDTO `json:"outgoing"`
}

type createRequestBody struct {
	Type     string `json:"type"`
	ToUserID string `json:"toUserId"`
	LayupID  string `json:"layupId"`
	Note     string `json:"note"`
}

func (s *Server) handleCreateRequest(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}

	var body createRequestBody
	if err := decodeJSON(r, &body); err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	requestType := domain.RequestType(body.Type)
	if !requestType.Valid() {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", "unknown request type "+body.Type)
		return
	}

	input := domain.CreateRequestInput{
		Type:     requestType,
		FromUser: identity.User.ID,
		Note:     body.Note,
	}

	if body.ToUserID != "" {
		recipient, err := s.directory.UserByID(domain.UserID(body.ToUserID))
		if err != nil {
			s.writeDomainError(w, r, err)
			return
		}
		// Organisation boundary: you can only reach people in your own.
		if recipient.OrganisationID != identity.OrganisationID() {
			s.writeAPIError(w, r, http.StatusNotFound, "not_found", "no such person")
			return
		}
		input.ToUser = recipient.ID
	}
	if body.LayupID != "" {
		input.LayupID = domain.LayupID(body.LayupID)
	}

	// A knock is addressed at a *person*, not a layup id: the requester cannot
	// see which private layup someone is in, so the server resolves it. The
	// requester never learns the id unless they are admitted (SPEC.md §6.3).
	if input.Type == domain.RequestKnock && input.LayupID == "" {
		if input.ToUser == "" {
			s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request",
				"a knock needs either a layup or the person you are knocking for")
			return
		}
		target, err := s.layups.ActiveLayupsForUser(r.Context(), input.ToUser)
		if err != nil || len(target) == 0 {
			s.writeAPIError(w, r, http.StatusConflict, "conflict", "that person is not in a layup")
			return
		}
		input.LayupID = target[0].Layup.ID
		// The knock belongs to the layup, not to that one person: any
		// participant may admit it.
		input.ToUser = ""
	}

	if err := s.mayRequest(r.Context(), input, identity); err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	request, created, err := s.requests.Create(r.Context(), input)
	if err != nil {
		s.writeDomainError(w, r, err)
		return
	}

	if created {
		s.publishRequest(r.Context(), request)
	}
	s.writeEnvelope(w, r, "request.created", s.requestDTOFor(r.Context(), request, identity.User.ID))
}

// mayRequest decides whether an identity may send this request.
//
//   - inviting someone into a layup requires being in it (there is no way to
//     invite people into a layup you are not part of);
//   - knocking requires the layup to exist and be active, and you must not
//     already be inside it.
func (s *Server) mayRequest(ctx context.Context, in domain.CreateRequestInput, identity Identity) error {
	if in.LayupID == "" {
		return nil
	}
	view, err := s.layups.View(ctx, in.LayupID)
	if err != nil {
		return err
	}
	if view.Layup.OrganisationID != identity.OrganisationID() {
		return domain.ErrNotFound
	}
	if !view.Active() {
		return domain.ErrConflict
	}

	inside := false
	for _, participant := range view.ActiveParticipants() {
		if participant.UserID == identity.User.ID {
			inside = true
		}
		if in.Type == domain.RequestInviteToLayup && participant.UserID == in.ToUser {
			// Already here: nothing to invite them to.
			return domain.ErrConflict
		}
	}

	switch in.Type {
	case domain.RequestInviteToLayup:
		if !inside {
			return domain.ErrForbidden
		}
	case domain.RequestKnock:
		if inside {
			return domain.ErrConflict
		}
	}
	return nil
}

func (s *Server) handleListRequests(w http.ResponseWriter, r *http.Request) {
	identity, ok := IdentityFrom(r.Context())
	if !ok {
		s.writeAPIError(w, r, http.StatusUnauthorized, "unauthenticated", "no identity on request")
		return
	}
	s.writeEnvelope(w, r, "request.list", s.requestListFor(r.Context(), identity.User.ID))
}

func (s *Server) requestListFor(ctx context.Context, user domain.UserID) RequestListDTO {
	incoming := make([]RequestDTO, 0, 4)
	for _, request := range s.requests.PendingForUser(user) {
		incoming = append(incoming, s.requestDTOFor(ctx, request, user))
	}
	for _, request := range s.knocksVisibleTo(ctx, user) {
		incoming = append(incoming, s.requestDTOFor(ctx, request, user))
	}
	outgoing := make([]RequestDTO, 0, 4)
	for _, request := range s.requests.PendingFromUser(user) {
		outgoing = append(outgoing, s.requestDTOFor(ctx, request, user))
	}
	return RequestListDTO{Incoming: incoming, Outgoing: outgoing}
}

// knocksVisibleTo returns pending knocks against layups this user is in, since
// any participant may admit a knocker (SPEC.md §6.3).
func (s *Server) knocksVisibleTo(ctx context.Context, user domain.UserID) []domain.JoinRequest {
	views, err := s.layups.ActiveLayupsForUser(ctx, user)
	if err != nil {
		return nil
	}
	out := make([]domain.JoinRequest, 0, 2)
	for _, view := range views {
		out = append(out, s.requests.PendingForLayup(view.Layup.ID)...)
	}
	return out
}

// requestDTOFor renders a request for one viewer, revealing layup context only
// when that viewer is entitled to it.
func (s *Server) requestDTOFor(ctx context.Context, request domain.JoinRequest, viewer domain.UserID) RequestDTO {
	dto := RequestDTO{
		ID:            string(request.ID),
		Type:          string(request.Type),
		State:         string(request.State),
		FromUserID:    string(request.FromUserID),
		ToUserID:      string(request.ToUserID),
		Note:          request.Note,
		CreatedAt:     request.CreatedAt,
		ExpiresAt:     request.ExpiresAt,
		ResultLayupID: string(request.ResultLayupID),
	}
	if user, err := s.directory.UserByID(request.FromUserID); err == nil {
		dto.FromName = user.DisplayName
	}
	if request.ToUserID != "" {
		if user, err := s.directory.UserByID(request.ToUserID); err == nil {
			dto.ToName = user.DisplayName
		}
	}

	if request.LayupID == "" {
		return dto
	}
	view, err := s.layups.View(ctx, request.LayupID)
	if err != nil {
		return dto
	}
	// The knocker must not learn the private title or who is inside; a person
	// invited into a layup, and the people already in it, may see it.
	entitled := view.Layup.Visibility.Open()
	for _, participant := range view.ActiveParticipants() {
		if participant.UserID == viewer {
			entitled = true
		}
	}
	if request.Type == domain.RequestInviteToLayup && viewer == request.ToUserID {
		entitled = true
	}
	if entitled {
		dto.LayupID = string(view.Layup.ID)
		dto.LayupTitle = view.Layup.Title
	}
	return dto
}

// publishRequest tells the people who need to know that a request exists.
func (s *Server) publishRequest(ctx context.Context, request domain.JoinRequest) {
	for _, recipient := range s.recipientsOf(ctx, request) {
		env, err := protocol.NewEnvelope(TypeRequestIncoming, s.requestDTOFor(ctx, request, recipient))
		if err != nil {
			continue
		}
		s.hub.SendToUser(recipient, env)
		// The recipient's tile for the requester now reads "inviting you".
		s.feed.PublishUserByID(ctx, request.FromUserID)
	}

	if env, err := protocol.NewEnvelope(TypeRequestOutgoing, s.requestDTOFor(ctx, request, request.FromUserID)); err == nil {
		s.hub.SendToUser(request.FromUserID, env)
	}
	if request.ToUserID != "" {
		s.feed.PublishUserByID(ctx, request.ToUserID)
	}
}

// publishResolution tells both sides a request has ended.
func (s *Server) publishResolution(ctx context.Context, request domain.JoinRequest) {
	recipients := append(s.recipientsOf(ctx, request), request.FromUserID)
	seen := map[domain.UserID]bool{}
	for _, recipient := range recipients {
		if seen[recipient] {
			continue
		}
		seen[recipient] = true
		env, err := protocol.NewEnvelope(TypeRequestResolved, s.requestDTOFor(ctx, request, recipient))
		if err != nil {
			continue
		}
		s.hub.SendToUser(recipient, env)
	}
	// Tiles go back to their ordinary state on both sides.
	s.feed.PublishUserByID(ctx, request.FromUserID)
	if request.ToUserID != "" {
		s.feed.PublishUserByID(ctx, request.ToUserID)
	}
}

// recipientsOf returns who should be notified about a request.
func (s *Server) recipientsOf(ctx context.Context, request domain.JoinRequest) []domain.UserID {
	if request.ToUserID != "" {
		return []domain.UserID{request.ToUserID}
	}
	// A knock goes to the people currently inside the target layup.
	view, err := s.layups.View(ctx, request.LayupID)
	if err != nil {
		return nil
	}
	out := make([]domain.UserID, 0, len(view.Participants))
	for _, participant := range view.ActiveParticipants() {
		out = append(out, participant.UserID)
	}
	return out
}
