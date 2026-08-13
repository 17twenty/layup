package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

func sendSignal(t *testing.T, conn *websocket.Conn, msgType string, payload SignalDTO) {
	t.Helper()
	env, err := protocol.NewEnvelope(msgType, payload)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(env)
	writeRaw(t, conn, string(raw))
}

// twoInALayup connects both people and puts them in one open layup.
func twoInALayup(t *testing.T) (*Server, *websocket.Conn, *websocket.Conn, MembershipResultDTO, string) {
	t.Helper()
	srv, api := realtimeServer(t)
	nick := dial(t, srv, "v=1&devUser=nick")
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	created := createLayup(t, api, "nick", "Pairing", "ORGANISATION")
	rec := call(t, api, http.MethodPost, "/api/layups/"+created.Layup.ID+"/join", "karl", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("karl join: %d", rec.Code)
	}
	karlMembership := payloadOf[MembershipResultDTO](t, rec).YourMembershipID
	return api, nick, karl, created, karlMembership
}

func TestSignallingRelaysOffersAnswersAndCandidates(t *testing.T) {
	_, nick, karl, created, karlMembership := twoInALayup(t)

	sendSignal(t, nick, TypeSignalOffer, SignalDTO{
		LayupID:        created.Layup.ID,
		ToMembershipID: karlMembership,
		SDP:            "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
	})

	offer := awaitType(t, karl, TypeSignalOffer)
	var received SignalDTO
	if err := protocol.DecodePayload(offer, &received); err != nil {
		t.Fatal(err)
	}
	if received.SDP == "" || received.LayupID != created.Layup.ID {
		t.Fatalf("unexpected relayed offer: %+v", received)
	}
	// The server stamps the sender; the client cannot claim to be anyone else.
	if received.FromMembershipID != created.YourMembershipID {
		t.Fatalf("expected the sender to be stamped, got %q", received.FromMembershipID)
	}
	if received.FromUserID != "usr_devnickx" {
		t.Fatalf("unexpected from user: %q", received.FromUserID)
	}

	// Answer and candidate travel the other way.
	sendSignal(t, karl, TypeSignalAnswer, SignalDTO{
		LayupID:        created.Layup.ID,
		ToMembershipID: created.YourMembershipID,
		SDP:            "v=0\r\nanswer\r\n",
	})
	_ = awaitType(t, nick, TypeSignalAnswer)

	index := 0
	sendSignal(t, karl, TypeSignalCandidate, SignalDTO{
		LayupID:        created.Layup.ID,
		ToMembershipID: created.YourMembershipID,
		Candidate:      "candidate:1 1 udp 2122260223 192.168.1.5 51000 typ host",
		SDPMid:         "0",
		SDPMLineIndex:  &index,
	})
	candidate := awaitType(t, nick, TypeSignalCandidate)
	if err := protocol.DecodePayload(candidate, &received); err != nil {
		t.Fatal(err)
	}
	if received.Candidate == "" || received.SDPMid != "0" || received.SDPMLineIndex == nil {
		t.Fatalf("candidate fields must survive the relay: %+v", received)
	}
}

func TestSenderCannotSpoofIdentityOrReachOutsideTheLayup(t *testing.T) {
	_, nick, karl, created, karlMembership := twoInALayup(t)

	// A forged FromMembershipID is overwritten, not honoured.
	sendSignal(t, nick, TypeSignalOffer, SignalDTO{
		LayupID:          created.Layup.ID,
		ToMembershipID:   karlMembership,
		FromMembershipID: "mem_someoneelse",
		FromUserID:       "usr_devpriyax",
		SDP:              "v=0\r\n",
	})
	offer := awaitType(t, karl, TypeSignalOffer)
	var received SignalDTO
	if err := protocol.DecodePayload(offer, &received); err != nil {
		t.Fatal(err)
	}
	if received.FromMembershipID != created.YourMembershipID || received.FromUserID != "usr_devnickx" {
		t.Fatalf("the server must stamp the real sender: %+v", received)
	}

	// Signalling a membership that is not in the layup is rejected.
	sendSignal(t, nick, TypeSignalOffer, SignalDTO{
		LayupID:        created.Layup.ID,
		ToMembershipID: "mem_devzzzzzz",
		SDP:            "v=0\r\n",
	})
	if env := awaitType(t, nick, protocol.TypeError); env.Type != protocol.TypeError {
		t.Fatal("expected an error envelope")
	}
}

func TestSignallingRejectsMalformedMessages(t *testing.T) {
	_, nick, _, created, karlMembership := twoInALayup(t)

	for _, payload := range []SignalDTO{
		{ToMembershipID: karlMembership, SDP: "v=0"},                // no layup
		{LayupID: created.Layup.ID, SDP: "v=0"},                     // no recipient
		{LayupID: created.Layup.ID, ToMembershipID: karlMembership}, // offer with no sdp
	} {
		sendSignal(t, nick, TypeSignalOffer, payload)
		env := awaitType(t, nick, protocol.TypeError)
		var errorPayload protocol.ErrorPayload
		if err := protocol.DecodePayload(env, &errorPayload); err != nil {
			t.Fatal(err)
		}
		if errorPayload.Code == "" {
			t.Fatalf("error must carry a code: %+v", errorPayload)
		}
	}
}

func TestOutsidersCannotSignalIntoALayup(t *testing.T) {
	srv, api := realtimeServer(t)
	nick := dial(t, srv, "v=1&devUser=nick")
	emelia := dial(t, srv, "v=1&devUser=emelia")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)
	_ = awaitType(t, emelia, presencefeed.TypePresenceSnapshot)

	created := createLayup(t, api, "nick", "Private pairing", "PRIVATE")

	sendSignal(t, emelia, TypeSignalOffer, SignalDTO{
		LayupID:        created.Layup.ID,
		ToMembershipID: created.YourMembershipID,
		SDP:            "v=0\r\n",
	})

	env := awaitType(t, emelia, protocol.TypeError)
	var errorPayload protocol.ErrorPayload
	if err := protocol.DecodePayload(env, &errorPayload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errorPayload.Message, "not in that layup") {
		t.Fatalf("unexpected error: %+v", errorPayload)
	}
}
