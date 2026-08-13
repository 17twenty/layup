package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/domain"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

// awaitType reads until an envelope of the wanted type arrives, skipping
// heartbeats. It fails the test rather than blocking forever.
func awaitType(t *testing.T, conn *websocket.Conn, wanted string) protocol.Envelope {
	t.Helper()
	for i := 0; i < 20; i++ {
		env := readEnvelope(t, conn)
		if env.Type == wanted {
			return env
		}
	}
	t.Fatalf("no %s envelope arrived", wanted)
	return protocol.Envelope{}
}

func TestConnectingClientReceivesAPresenceSnapshot(t *testing.T) {
	srv, _ := realtimeServer(t)
	conn := dial(t, srv, "v=1&devUser=nick")

	env := awaitType(t, conn, presencefeed.TypePresenceSnapshot)
	var snapshot presencefeed.SnapshotDTO
	if err := protocol.DecodePayload(env, &snapshot); err != nil {
		t.Fatalf("snapshot payload: %v", err)
	}
	if len(snapshot.People) < 4 {
		t.Fatalf("snapshot should carry the organisation, got %d people", len(snapshot.People))
	}
	for _, person := range snapshot.People {
		if person.UserID == "" || person.DisplayName == "" || person.Personal == "" || person.Activity == "" {
			t.Fatalf("incomplete presence entry: %+v", person)
		}
	}
}

func TestTwoClientsSeeEachOtherComeOnlineAndGoOffline(t *testing.T) {
	srv, api := realtimeServer(t)

	nick := dial(t, srv, "v=1&devUser=nick")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)

	// Karl connects: nick must be told without polling.
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	karlOnline := findUpdateWhere(t, nick, "usr_devkarlx", func(p presencefeed.PresenceDTO) bool {
		return p.Personal == "AVAILABLE"
	})
	if karlOnline.Personal != "AVAILABLE" {
		t.Fatalf("expected karl AVAILABLE, got %+v", karlOnline)
	}

	// Karl disconnects: nick is told he went offline.
	_ = karl.Close(websocket.StatusNormalClosure, "leaving")
	waitFor(t, func() bool { return api.Hub().ConnectionsForUser("usr_devkarlx") == 0 })

	karlOffline := findUpdateWhere(t, nick, "usr_devkarlx", func(p presencefeed.PresenceDTO) bool {
		return p.Personal == "OFFLINE"
	})
	if karlOffline.Personal != "OFFLINE" {
		t.Fatalf("expected karl OFFLINE, got %+v", karlOffline)
	}
}

func TestPresenceSetIsPublishedToOthers(t *testing.T) {
	srv, _ := realtimeServer(t)
	nick := dial(t, srv, "v=1&devUser=nick")
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	set, _ := protocol.NewEnvelope(TypePresenceSet, map[string]string{"personal": "DND"})
	data, _ := json.Marshal(set)
	writeRaw(t, karl, string(data))

	update := findUpdateWhere(t, nick, "usr_devkarlx", func(p presencefeed.PresenceDTO) bool {
		return p.Personal == "DND"
	})
	if update.Personal != "DND" {
		t.Fatalf("expected DND, got %+v", update)
	}
}

func TestPresenceSetRejectsAnUnknownState(t *testing.T) {
	srv, _ := realtimeServer(t)
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	set, _ := protocol.NewEnvelope(TypePresenceSet, map[string]string{"personal": "PARTYING"})
	data, _ := json.Marshal(set)
	writeRaw(t, karl, string(data))

	env := awaitType(t, karl, protocol.TypeError)
	var payload protocol.ErrorPayload
	if err := protocol.DecodePayload(env, &payload); err != nil {
		t.Fatalf("error payload: %v", err)
	}
	if payload.Code == "" {
		t.Fatalf("error must carry a code: %+v", payload)
	}
}

func TestPresencePayloadsDoNotLeakPrivateLayupDetail(t *testing.T) {
	srv, api := realtimeServer(t)

	// Karl is in a private layup with a revealing title.
	karlUser, err := api.directory.Resolve("karl")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := api.Layups().CreateLayup(context.Background(), domain.CreateLayupInput{
		OrganisationID: karlUser.OrganisationID,
		CreatorUserID:  karlUser.ID,
		Title:          "Acquisition of Initech",
		Visibility:     domain.VisibilityPrivate,
	}); err != nil {
		t.Fatal(err)
	}

	nick := dial(t, srv, "v=1&devUser=nick")
	env := awaitType(t, nick, presencefeed.TypePresenceSnapshot)
	if strings.Contains(string(env.Payload), "Initech") {
		t.Fatal("private layup title leaked in a presence snapshot")
	}

	var snapshot presencefeed.SnapshotDTO
	if err := protocol.DecodePayload(env, &snapshot); err != nil {
		t.Fatal(err)
	}
	for _, person := range snapshot.People {
		if person.UserID != string(karlUser.ID) {
			continue
		}
		if person.Activity != string(domain.ActivityInPrivateLayup) {
			t.Fatalf("outsider should see coarse busy state, got %q", person.Activity)
		}
		if person.LayupID != "" || person.LayupTitle != "" || person.ParticipantCount != 0 {
			t.Fatalf("private layup detail leaked: %+v", person)
		}
		return
	}
	t.Fatal("karl missing from the snapshot")
}

func findUpdateWhere(
	t *testing.T,
	conn *websocket.Conn,
	userID string,
	matches func(presencefeed.PresenceDTO) bool,
) presencefeed.PresenceDTO {
	t.Helper()
	for i := 0; i < 60; i++ {
		env := readEnvelope(t, conn)
		if env.Type != presencefeed.TypePresenceUpdate {
			continue
		}
		var update presencefeed.UpdateDTO
		if err := protocol.DecodePayload(env, &update); err != nil {
			t.Fatalf("update payload: %v", err)
		}
		if update.Person.UserID == userID && matches(update.Person) {
			return update.Person
		}
	}
	t.Fatalf("no presence update for %s", userID)
	return presencefeed.PresenceDTO{}
}
