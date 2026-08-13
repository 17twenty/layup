package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/layup-app/layup/protocol"
	"github.com/layup-app/layup/services/control/internal/config"
	"github.com/layup-app/layup/services/control/internal/directory"
	"github.com/layup-app/layup/services/control/internal/domain"
	"github.com/layup-app/layup/services/control/internal/presencefeed"
)

// serverWithClock builds a server whose request clock the test controls.
func serverWithClock(t *testing.T, ttl time.Duration) (*httptest.Server, *Server, func(time.Duration)) {
	t.Helper()
	cfg, err := config.Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	dir := directory.NewDev()
	layups := domain.NewLayupService(domain.NewMemoryRepository(), domain.LayupServiceOptions{})

	clock := time.Date(2026, 8, 13, 9, 0, 0, 0, time.UTC)
	requests := domain.NewRequestService(domain.RequestServiceOptions{
		Now: func() time.Time { return clock },
		TTL: ttl,
	})
	api := New(cfg, Options{
		Directory:         dir,
		Layups:            layups,
		Requests:          requests,
		HeartbeatInterval: 40 * time.Millisecond,
	})
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	return srv, api, func(d time.Duration) { clock = clock.Add(d) }
}

func TestExpiredRequestsDisappearAndAreAnnounced(t *testing.T) {
	srv, api, advance := serverWithClock(t, 60*time.Second)

	nick := dial(t, srv, "v=1&devUser=nick")
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	request := invite(t, api, "nick", "karl", "Pairing")
	_ = awaitType(t, karl, TypeRequestIncoming)

	// Nothing expires early.
	advance(59 * time.Second)
	if expired := api.SweepExpiredRequests(context.Background()); expired != 0 {
		t.Fatalf("nothing should expire yet, got %d", expired)
	}

	advance(2 * time.Second)
	if expired := api.SweepExpiredRequests(context.Background()); expired != 1 {
		t.Fatalf("expected one expiry, got %d", expired)
	}

	// Both sides are told, without either of them asking.
	resolved := awaitType(t, karl, TypeRequestResolved)
	var dto RequestDTO
	if err := protocol.DecodePayload(resolved, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.State != "EXPIRED" || dto.ID != request.ID {
		t.Fatalf("recipient should be told it expired: %+v", dto)
	}
	resolvedSender := awaitType(t, nick, TypeRequestResolved)
	if err := protocol.DecodePayload(resolvedSender, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.State != "EXPIRED" {
		t.Fatalf("sender should be told it expired: %+v", dto)
	}

	// It is gone from both lists and can never be accepted.
	list := payloadOf[RequestListDTO](t, call(t, api, http.MethodGet, "/api/requests", "karl", nil))
	if len(list.Incoming) != 0 {
		t.Fatalf("an expired request must disappear: %+v", list.Incoming)
	}
	if code := call(t, api, http.MethodPost, "/api/requests/"+request.ID+"/accept", "karl", nil).Code; code != http.StatusConflict {
		t.Fatalf("expected 409 accepting an expired request, got %d", code)
	}
}

func TestSenderCanCancelAndBothSidesAreTold(t *testing.T) {
	srv, api, _ := serverWithClock(t, 60*time.Second)
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	request := invite(t, api, "nick", "karl", "Pairing")
	_ = awaitType(t, karl, TypeRequestIncoming)

	if code := call(t, api, http.MethodPost, "/api/requests/"+request.ID+"/cancel", "nick", nil).Code; code != http.StatusOK {
		t.Fatalf("cancel: %d", code)
	}

	resolved := awaitType(t, karl, TypeRequestResolved)
	var dto RequestDTO
	if err := protocol.DecodePayload(resolved, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.State != "CANCELLED" {
		t.Fatalf("the recipient should see the cancellation: %+v", dto)
	}
	if code := call(t, api, http.MethodPost, "/api/requests/"+request.ID+"/accept", "karl", nil).Code; code != http.StatusConflict {
		t.Fatalf("a cancelled request cannot be accepted, got %d", code)
	}
}

func TestRepeatedKnocksDoNotRepeatNotifications(t *testing.T) {
	srv, api, _ := serverWithClock(t, 60*time.Second)
	nick := dial(t, srv, "v=1&devUser=nick")
	_ = awaitType(t, nick, presencefeed.TypePresenceSnapshot)

	createLayup(t, api, "nick", "Acquisition of Initech", "PRIVATE")

	first, code, body := knock(t, api, "karl", "nick")
	if code != http.StatusOK {
		t.Fatalf("knock: %d (%s)", code, body)
	}
	_ = awaitType(t, nick, TypeRequestIncoming)

	for i := 0; i < 3; i++ {
		again, code, _ := knock(t, api, "karl", "nick")
		if code != http.StatusOK || again.ID != first.ID {
			t.Fatalf("repeated knock %d should reuse the pending request (%d, %q)", i, code, again.ID)
		}
	}

	// Only one knock is pending for the people inside.
	list := payloadOf[RequestListDTO](t, call(t, api, http.MethodGet, "/api/requests", "nick", nil))
	if len(list.Incoming) != 1 {
		t.Fatalf("repeated knocks must collapse into one, got %d", len(list.Incoming))
	}
}

func TestExpirySweeperRunsInTheBackground(t *testing.T) {
	srv, api, advance := serverWithClock(t, 10*time.Millisecond)
	karl := dial(t, srv, "v=1&devUser=karl")
	_ = awaitType(t, karl, presencefeed.TypePresenceSnapshot)

	invite(t, api, "nick", "karl", "Pairing")
	_ = awaitType(t, karl, TypeRequestIncoming)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	api.StartExpirySweeper(ctx, 5*time.Millisecond)
	advance(time.Second)

	resolved := awaitType(t, karl, TypeRequestResolved)
	var dto RequestDTO
	if err := protocol.DecodePayload(resolved, &dto); err != nil {
		t.Fatal(err)
	}
	if dto.State != "EXPIRED" {
		t.Fatalf("the sweeper should announce expiry: %+v", dto)
	}
}
