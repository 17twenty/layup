package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

// guestCall is call() (layups_test.go:15) for someone holding a guest token
// instead of a declared identity.
func guestCall(t *testing.T, s *Server, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set(protocol.HeaderVersion, strconv.Itoa(protocol.Version))
	req.Header.Set(HeaderAuthorization, "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

// seatAGuest puts a guest into a layup the way Task 5's endpoint will: a guest
// user id, an ordinary domain join, and a session. Task 3's rules must hold
// however the seat was made, so these tests do not go through that endpoint.
func seatAGuest(t *testing.T, s *Server, layupID, name string) GuestSession {
	t.Helper()
	userID := newGuestUserID()
	_, membership, err := s.layups.Join(context.Background(), domain.LayupID(layupID), userID)
	if err != nil {
		t.Fatalf("seat a guest: %v", err)
	}
	session, err := s.guests.create(domain.LayupID(layupID), membership.ID, userID, name)
	if err != nil {
		t.Fatalf("guest session: %v", err)
	}
	return session
}

func TestAGuestMayReadAndLeaveTheirOwnLayupAndAskForIce(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Guest call", "LINK")
	session := seatAGuest(t, s, created.Layup.ID, "Sam")

	rec := guestCall(t, s, http.MethodGet, "/api/layups/"+created.Layup.ID, session.Token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("a guest must be able to read their own layup, got %d (%s)", rec.Code, rec.Body.String())
	}
	view := payloadOf[LayupDTO](t, rec)
	if view.ID != created.Layup.ID {
		t.Fatalf("wrong layup: %+v", view)
	}

	if rec := guestCall(t, s, http.MethodGet, "/api/turn", session.Token, nil); rec.Code != http.StatusOK {
		t.Fatalf("a guest needs ICE servers to connect a call, got %d (%s)", rec.Code, rec.Body.String())
	}

	// Leaving is last: it ends the membership these other calls depend on.
	if rec := guestCall(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/leave", session.Token, nil); rec.Code != http.StatusOK {
		t.Fatalf("a guest must be able to leave, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// TestAGuestIsRefusedEverythingElse walks the surface a member has and checks
// a guest is turned away from all of it. /api/directory and /api/me are the
// two that matter most: between them they are the organisation's roster and
// the shape of a real account.
func TestAGuestIsRefusedEverythingElse(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Guest call", "LINK")
	session := seatAGuest(t, s, created.Layup.ID, "Sam")
	mine := "/api/layups/" + created.Layup.ID

	refused := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/directory"},
		{http.MethodGet, "/api/me"},
		{http.MethodGet, "/api/layups"},
		{http.MethodPost, "/api/layups"},
		{http.MethodGet, "/api/layups/current"},
		{http.MethodPost, mine + "/join"},
		{http.MethodPost, mine + "/share"},
		{http.MethodPost, mine + "/share/stop"},
		{http.MethodPost, mine + "/share/request"},
		{http.MethodPost, mine + "/share/settings"},
		{http.MethodGet, mine + "/share/drawing"},
		{http.MethodPost, "/api/links/join"},
		{http.MethodGet, "/api/requests"},
		{http.MethodPost, "/api/requests"},
	}
	for _, route := range refused {
		rec := guestCall(t, s, route.method, route.path, session.Token, nil)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s: a guest must be refused (403), got %d (%s)",
				route.method, route.path, rec.Code, rec.Body.String())
		}
	}
}

// TestAGuestCannotMintALink is its own test because it is its own escalation:
// a guest who can hand out links can fill someone else's call with strangers,
// and none of them ever needed an account.
func TestAGuestCannotMintALink(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Guest call", "LINK")
	session := seatAGuest(t, s, created.Layup.ID, "Sam")

	rec := guestCall(t, s, http.MethodPost, "/api/layups/"+created.Layup.ID+"/link", session.Token, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a guest must not mint a link, got %d (%s)", rec.Code, rec.Body.String())
	}
	// Nor take one away from the people who can.
	rec = guestCall(t, s, http.MethodDelete, "/api/layups/"+created.Layup.ID+"/link", session.Token, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a guest must not revoke a link either, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// TestARouteNobodyListedIsRefusedToAGuest is the whole point of an allow-list.
// These paths do not exist and never will; nobody has written a rule about
// them; a guest is refused anyway, and refused *before* the router gets to say
// "no such thing". The 403 rather than a 404 is the evidence: the decision was
// taken by the authorisation gate, not by routing.
func TestARouteNobodyListedIsRefusedToAGuest(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Guest call", "LINK")
	session := seatAGuest(t, s, created.Layup.ID, "Sam")

	invented := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/aardvarks"},
		{http.MethodPost, "/api/layups/" + created.Layup.ID + "/aardvark"},
		{http.MethodGet, "/api/layups/" + created.Layup.ID + "/transcript"},
		{http.MethodDelete, "/api/everything"},
	}
	for _, route := range invented {
		rec := guestCall(t, s, route.method, route.path, session.Token, nil)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s: an unlisted route must be refused by default, got %d (%s)",
				route.method, route.path, rec.Code, rec.Body.String())
		}
	}
}

// TestAGuestCannotReachAnotherLayup checks the scope comparison uses the
// session's own layup, not whatever the caller typed in the URL.
func TestAGuestCannotReachAnotherLayup(t *testing.T) {
	s := testServer(t)
	mine := createLayup(t, s, "nick", "Guest call", "LINK")
	theirs := createLayup(t, s, "karl", "Not for you", "ORGANISATION")
	session := seatAGuest(t, s, mine.Layup.ID, "Sam")

	for _, route := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/layups/" + theirs.Layup.ID},
		{http.MethodPost, "/api/layups/" + theirs.Layup.ID + "/leave"},
	} {
		rec := guestCall(t, s, route.method, route.path, session.Token, nil)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s: a guest is scoped to one layup, got %d (%s)",
				route.method, route.path, rec.Code, rec.Body.String())
		}
		// And the refusal says nothing about whether that layup exists.
		if bytes.Contains(rec.Body.Bytes(), []byte("Not for you")) {
			t.Errorf("%s %s leaked the other layup: %s", route.method, route.path, rec.Body.String())
		}
	}
}

// TestAGuestSessionDiesWithItsLayup: once the store has forgotten a session,
// the token authenticates nothing at all - not even the routes it used to
// reach.
func TestAGuestSessionDiesWithItsLayup(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Guest call", "LINK")
	session := seatAGuest(t, s, created.Layup.ID, "Sam")

	s.guests.endLayup(domain.LayupID(created.Layup.ID))

	for _, path := range []string{"/api/turn", "/api/layups/" + created.Layup.ID} {
		rec := guestCall(t, s, http.MethodGet, path, session.Token, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: a dead guest token must not authenticate, got %d (%s)",
				path, rec.Code, rec.Body.String())
		}
	}
}

// TestAGuestIsInNoOrganisation states the containment design as an assertion.
// Everything organisation-scoped in this server - the directory, presence,
// the Happening Now list - selects by organisation id, so this one fact is
// what keeps a guest out of all of them at once.
func TestAGuestIsInNoOrganisation(t *testing.T) {
	s := testServer(t)
	created := createLayup(t, s, "nick", "Guest call", "LINK")
	session := seatAGuest(t, s, created.Layup.ID, "Sam")

	identity := guestIdentity(session)
	if identity.OrganisationID() == s.directory.Organisation().ID {
		t.Fatal("a guest must not be inside the organisation that invited them")
	}
	if err := identity.OrganisationID().Validate(); err != nil {
		t.Fatalf("a guest's organisation id must still be well-formed: %v", err)
	}
	// Two guests are not even in an organisation with each other.
	other := seatAGuest(t, s, created.Layup.ID, "Robin")
	if guestIdentity(other).OrganisationID() == identity.OrganisationID() {
		t.Fatal("two guests must not share an organisation")
	}
	for _, user := range s.directory.Users() {
		if user.ID == session.UserID {
			t.Fatal("a guest must never appear in the directory")
		}
	}
}

// TestARegisteredTokenIsUnaffectedByTheGuestResolver is the regression guard
// on adding a second resolver to authenticate(): a real account must behave
// exactly as it did before, on every route a guest is refused.
func TestARegisteredTokenIsUnaffectedByTheGuestResolver(t *testing.T) {
	hosted := hostedDirectory(t)
	user, token, err := hosted.Register("Nick")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s := authServer(t, "selfhosted", hosted)

	for _, route := range []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/me", nil},
		{http.MethodGet, "/api/directory", nil},
		{http.MethodGet, "/api/layups", nil},
		{http.MethodGet, "/api/layups/current", nil},
		{http.MethodGet, "/api/turn", nil},
		{http.MethodGet, "/api/requests", nil},
		{http.MethodPost, "/api/layups", map[string]string{"title": "Mine", "visibility": "PRIVATE"}},
	} {
		rec := guestCall(t, s, route.method, route.path, token, route.body)
		if rec.Code != http.StatusOK {
			t.Errorf("%s %s: a registered token must still work, got %d (%s)",
				route.method, route.path, rec.Code, rec.Body.String())
		}
	}

	rec := guestCall(t, s, http.MethodGet, "/api/me", token, nil)
	if me := payloadOf[MeDTO](t, rec); me.User.ID != string(user.ID) {
		t.Fatalf("token identified %q, expected %q", me.User.ID, user.ID)
	}
}

// TestAConnectedGuestGetsSignallingAndNeverPresence is the test the whole
// containment design rests on.
//
// A guest must reach the realtime endpoint, because signalling is how their
// peer connection forms - refuse the socket and you refuse the call. But
// presence on that socket is the organisation's roster: every colleague's
// name, status message, and whether they are in a layup right now. If a link
// were worth that, a link would be worth stealing.
//
// So this asserts both halves at once, on one connection: the offer arrives,
// and no presence.snapshot or presence.update ever does - not on connect, not
// while the organisation is busy publishing.
func TestAConnectedGuestGetsSignallingAndNeverPresence(t *testing.T) {
	srv, api := realtimeServer(t)

	nick := dial(t, srv, "v=1&devUser=nick")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)
	created := createLayup(t, api, "nick", "Guest call", "ORGANISATION")
	session := seatAGuest(t, api, created.Layup.ID, "Sam")

	guest := dial(t, srv, "v=1&"+protocol.QueryToken+"="+session.Token)
	hello := readEnvelope(t, guest)
	if hello.Type != protocol.TypeHelloOK {
		t.Fatalf("expected hello.ok first, got %q", hello.Type)
	}
	var payload protocol.HelloOKPayload
	if err := protocol.DecodePayload(hello, &payload); err != nil {
		t.Fatalf("hello payload: %v", err)
	}
	if payload.UserID != string(session.UserID) {
		t.Fatalf("the guest token identified %q, expected %q", payload.UserID, session.UserID)
	}

	// Make the organisation as noisy as it gets: someone else connects, that
	// someone joins the layup, and a member changes their own presence. Each
	// of these publishes through presencefeed.
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)
	if rec := call(t, api, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil); rec.Code != http.StatusOK {
		t.Fatalf("karl join: %d (%s)", rec.Code, rec.Body.String())
	}
	setPresence, err := protocol.NewEnvelope(TypePresenceSet, map[string]string{"personal": "DND"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(setPresence)
	writeRaw(t, nick, string(raw))
	_ = awaitType(t, karl, presencefeed.TypePresenceUpdate)

	// Now signal to the guest, and read their whole stream up to it.
	sendSignal(t, nick, TypeSignalOffer, SignalDTO{
		LayupID:        created.Layup.ID,
		ToMembershipID: string(session.MembershipID),
		SDP:            "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
	})

	sawOffer := false
	for i := 0; i < 30 && !sawOffer; i++ {
		env := readEnvelope(t, guest)
		switch env.Type {
		case presencefeed.TypePresenceSnapshot, presencefeed.TypePresenceUpdate:
			t.Fatalf("a guest received %q - a link would leak the organisation roster: %s",
				env.Type, string(env.Payload))
		case TypeSignalOffer:
			sawOffer = true
		}
	}
	if !sawOffer {
		t.Fatal("a guest must receive signalling for their own layup")
	}

	// And nothing presence-shaped turns up late either.
	expectNoPresence(t, guest, 300*time.Millisecond)
}

// TestAGuestCannotPublishPresenceEither closes the other direction: presence
// is a surface a guest neither reads nor writes.
func TestAGuestCannotPublishPresenceEither(t *testing.T) {
	srv, api := realtimeServer(t)
	created := createLayup(t, api, "nick", "Guest call", "LINK")
	session := seatAGuest(t, api, created.Layup.ID, "Sam")

	guest := dial(t, srv, "v=1&"+protocol.QueryToken+"="+session.Token)
	if env := readEnvelope(t, guest); env.Type != protocol.TypeHelloOK {
		t.Fatalf("expected hello.ok first, got %q", env.Type)
	}
	setPresence, err := protocol.NewEnvelope(TypePresenceSet, map[string]string{"personal": "AVAILABLE"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(setPresence)
	writeRaw(t, guest, string(raw))

	env := awaitType(t, guest, protocol.TypeError)
	if env.Type != protocol.TypeError {
		t.Fatalf("a guest setting presence should be refused, got %q", env.Type)
	}
}

// expectNoPresence reads everything a connection is sent for a while and fails
// on anything presence-shaped. Heartbeats and layup state are expected and
// ignored; the read ending is the success case, so this is the last thing a
// test does with that connection.
func expectNoPresence(t *testing.T, conn *websocket.Conn, window time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), window)
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		env, err := protocol.Decode(data)
		if err != nil {
			continue
		}
		if env.Type == presencefeed.TypePresenceSnapshot || env.Type == presencefeed.TypePresenceUpdate {
			t.Fatalf("a guest received %q after connecting: %s", env.Type, string(env.Payload))
		}
	}
}
