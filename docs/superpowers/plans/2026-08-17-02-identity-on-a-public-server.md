# Identity On A Public Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two people install nothing but a config, type a server address, a join code and their name, and appear in each other's People grid — on a control plane that is on the public internet and no longer lets a header decide who you are.

**Architecture:** A `Hosted` directory implementation registers users at runtime and persists them, with their bearer tokens, to a JSON file. Because presence fans out over `directory.Users()` (`presencefeed/feed.go:119`) and the People grid reads the same source, a dynamic directory lights up both without touching either. Authentication moves to `Authorization: Bearer` for HTTP and a `token` query parameter for the WebSocket, sharing one `authenticate` helper between `requireIdentity` and `handleRealtime`. The `X-Layup-Dev-User` header survives, but only on loopback or when `LAYUP_ENV=dev`, so every existing test and the whole local development loop are untouched.

**Tech Stack:** Go 1.26.4 (stdlib only — no new dependencies), TypeScript/Electron 43, React 19.

**Spec:** `docs/superpowers/specs/2026-08-17-two-person-dogfood-design.md`

## Global Constraints

- **No new Go dependencies.** `crypto/rand`, `encoding/json`, `sync` and `os` cover all of it.
- Tokens are 32 bytes from `crypto/rand`, base64url, no padding. They **do not expire** (spec §5) — revocation is deleting the store.
- The token must never reach a log. This matches the existing `never writes typed content to its log` discipline and gets its own test.
- `X-Layup-Dev-User` keeps working for `127.0.0.1`/`::1` callers or when `LAYUP_ENV=dev`. Every existing `httpapi` test uses it and **none of them may be rewritten**.
- Only identities and tokens are persisted. Layups, memberships and presence stay in memory (spec §5).
- The join code is `LAYUP_JOIN_CODE`. When unset, registration is refused outright — a server that accidentally allows open registration is worse than one that refuses everybody.
- User IDs must satisfy the existing `domain.User.Validate()`; follow the `usr_` + ≥8 character shape that `directory.DevUserID` establishes.

---

### Task 1: Registration configuration

**Files:**
- Modify: `services/control/internal/config/config.go`
- Modify: `services/control/internal/config/config_test.go`

**Interfaces:**
- Produces: `Config.JoinCode string` and `Config.StateDir string` (default `/var/lib/layup`), consumed by Tasks 3 and 5.

- [ ] **Step 1: Write the failing test**

Add to `config_test.go`:

```go
func TestJoinCodeAndStateDirAreLoaded(t *testing.T) {
	env := map[string]string{
		"LAYUP_JOIN_CODE": "LAYUP-7K2M",
		"LAYUP_STATE_DIR": "/var/lib/layup",
	}
	cfg, err := config.Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.JoinCode != "LAYUP-7K2M" {
		t.Errorf("JoinCode = %q, want LAYUP-7K2M", cfg.JoinCode)
	}
	if cfg.StateDir != "/var/lib/layup" {
		t.Errorf("StateDir = %q, want /var/lib/layup", cfg.StateDir)
	}
}

// An unset join code must not silently mean "anyone may register".
func TestJoinCodeDefaultsToEmptyWhichForbidsRegistration(t *testing.T) {
	cfg, err := config.Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.JoinCode != "" {
		t.Errorf("JoinCode = %q, want empty", cfg.JoinCode)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd services/control && go test ./internal/config/ -run JoinCode -v`
Expected: FAIL — `cfg.JoinCode undefined`.

- [ ] **Step 3: Add the fields**

In `config.go`, add to `Config`:

```go
	// JoinCode gates self-registration. Empty means registration is refused:
	// an accidentally open server is worse than an unusable one.
	JoinCode string
	// StateDir holds the only thing this service persists - identities and
	// their tokens. Layups and presence stay in memory (ARCHITECTURE.md §10).
	StateDir string
```

In `defaults()`, add `StateDir: "/var/lib/layup",`. In `Load`, alongside the other lookups:

```go
	if v := getenv(EnvPrefix + "JOIN_CODE"); v != "" {
		cfg.JoinCode = strings.TrimSpace(v)
	}
	if v := getenv(EnvPrefix + "STATE_DIR"); v != "" {
		cfg.StateDir = v
	}
```

- [ ] **Step 4: Run it green**

Run: `cd services/control && go test ./internal/config/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/control/internal/config
git commit -m "control: a join code, and somewhere to remember people"
```

---

### Task 2: A directory that can grow

**Files:**
- Create: `services/control/internal/directory/hosted.go`
- Create: `services/control/internal/directory/hosted_test.go`

**Interfaces:**
- Consumes: `domain.User`, `domain.Organisation`, `domain.DefaultPolicy()`.
- Produces:
  - `directory.NewHosted(path string) (*Hosted, error)`
  - `(*Hosted).Register(displayName string) (domain.User, string, error)` — returns the user and its bearer token
  - `(*Hosted).ResolveToken(token string) (domain.User, bool)`
  - `HostedOrganisationID = domain.OrganisationID("org_layup")`
  - and the full `Directory` interface, so it drops into `httpapi/server.go:65`.

- [ ] **Step 1: Write the failing test**

`hosted_test.go`:

```go
package directory_test

import (
	"path/filepath"
	"testing"

	"github.com/layup-app/layup/services/control/internal/directory"
)

func TestRegisteredUserAppearsInTheDirectory(t *testing.T) {
	dir, err := directory.NewHosted(filepath.Join(t.TempDir(), "identities.json"))
	if err != nil {
		t.Fatalf("NewHosted: %v", err)
	}

	user, token, err := dir.Register("Nick")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if user.DisplayName != "Nick" {
		t.Errorf("DisplayName = %q, want Nick", user.DisplayName)
	}
	if token == "" {
		t.Fatal("Register returned an empty token")
	}
	// Presence fans out over Users(); appearing here is what makes a
	// registered person visible to everybody else.
	if got := dir.Users(); len(got) != 1 || got[0].ID != user.ID {
		t.Errorf("Users() = %v, want the registered user", got)
	}
	if found, ok := dir.ResolveToken(token); !ok || found.ID != user.ID {
		t.Errorf("ResolveToken did not return the registered user")
	}
	if _, ok := dir.ResolveToken("not-a-token"); ok {
		t.Error("ResolveToken accepted a forged token")
	}
}

func TestIdentitiesSurviveARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identities.json")
	first, err := directory.NewHosted(path)
	if err != nil {
		t.Fatalf("NewHosted: %v", err)
	}
	user, token, err := first.Register("Karl")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	// A redeploy restarts the process. Both people must not have to re-onboard.
	second, err := directory.NewHosted(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	found, ok := second.ResolveToken(token)
	if !ok || found.ID != user.ID || found.DisplayName != "Karl" {
		t.Errorf("identity did not survive a restart: %v %v", found, ok)
	}
}

func TestTwoRegistrationsGetDistinctIdentities(t *testing.T) {
	dir, err := directory.NewHosted(filepath.Join(t.TempDir(), "identities.json"))
	if err != nil {
		t.Fatalf("NewHosted: %v", err)
	}
	a, tokenA, _ := dir.Register("Nick")
	b, tokenB, _ := dir.Register("Nick")
	if a.ID == b.ID {
		t.Error("two registrations shared a user id")
	}
	if tokenA == tokenB {
		t.Error("two registrations shared a token")
	}
}

func TestRegisterRejectsAnEmptyName(t *testing.T) {
	dir, _ := directory.NewHosted(filepath.Join(t.TempDir(), "identities.json"))
	if _, _, err := dir.Register("   "); err == nil {
		t.Error("Register accepted a blank display name")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd services/control && go test ./internal/directory/ -run Hosted -v`
Expected: FAIL — `undefined: directory.NewHosted`.

- [ ] **Step 3: Implement it**

`hosted.go`. Note the atomic write: a truncated identity file after a crash would lock both people out.

```go
package directory

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/layup-app/layup/services/control/internal/domain"
)

// HostedOrganisationID is stable so restarts do not move anybody between
// organisations.
const HostedOrganisationID = domain.OrganisationID("org_layup")

const hostedOrganisationName = "Layup"

// Hosted is a directory people register themselves into.
//
// It persists identities and their tokens, and nothing else: layups and
// presence remain in memory, because a restart genuinely does end a live layup
// (ARCHITECTURE.md §10).
type Hosted struct {
	mu     sync.RWMutex
	path   string
	org    domain.Organisation
	users  map[domain.UserID]domain.User
	tokens map[string]domain.UserID
}

type hostedFile struct {
	Users  []domain.User     `json:"users"`
	Tokens map[string]string `json:"tokens"`
}

// NewHosted opens, or creates, the identity store at path.
func NewHosted(path string) (*Hosted, error) {
	h := &Hosted{
		path: path,
		org: domain.Organisation{
			ID:     HostedOrganisationID,
			Name:   hostedOrganisationName,
			Policy: domain.DefaultPolicy(),
		},
		users:  map[domain.UserID]domain.User{},
		tokens: map[string]domain.UserID{},
	}
	if err := h.load(); err != nil {
		return nil, err
	}
	return h, nil
}

func (h *Hosted) load() error {
	raw, err := os.ReadFile(h.path)
	if os.IsNotExist(err) {
		return nil // a fresh server has nobody in it; that is not an error
	}
	if err != nil {
		return fmt.Errorf("layup: reading identity store: %w", err)
	}
	var file hostedFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return fmt.Errorf("layup: identity store is corrupt: %w", err)
	}
	for _, user := range file.Users {
		h.users[user.ID] = user
	}
	for token, id := range file.Tokens {
		h.tokens[token] = domain.UserID(id)
	}
	return nil
}

// save writes atomically: a half-written store would lock everybody out.
func (h *Hosted) save() error {
	file := hostedFile{Tokens: map[string]string{}}
	for _, user := range h.users {
		file.Users = append(file.Users, user)
	}
	sort.Slice(file.Users, func(i, j int) bool { return file.Users[i].ID < file.Users[j].ID })
	for token, id := range h.tokens {
		file.Tokens[token] = string(id)
	}
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(h.path), 0o750); err != nil {
		return err
	}
	tmp := h.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, h.path)
}

func newHostedID() (domain.UserID, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return domain.UserID(fmt.Sprintf("usr_%x", buf)), nil
}

func newToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Register creates an identity and the token that proves it.
func (h *Hosted) Register(displayName string) (domain.User, string, error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return domain.User{}, "", fmt.Errorf("%w: a display name is required", domain.ErrInvalid)
	}

	id, err := newHostedID()
	if err != nil {
		return domain.User{}, "", err
	}
	token, err := newToken()
	if err != nil {
		return domain.User{}, "", err
	}
	user := domain.User{ID: id, OrganisationID: h.org.ID, DisplayName: displayName}
	if err := user.Validate(); err != nil {
		return domain.User{}, "", fmt.Errorf("%w: %v", domain.ErrInvalid, err)
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.users[user.ID] = user
	h.tokens[token] = user.ID
	if err := h.save(); err != nil {
		delete(h.users, user.ID)
		delete(h.tokens, token)
		return domain.User{}, "", err
	}
	return user, token, nil
}

// ResolveToken returns the user a bearer token belongs to.
func (h *Hosted) ResolveToken(token string) (domain.User, bool) {
	if token == "" {
		return domain.User{}, false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	id, ok := h.tokens[token]
	if !ok {
		return domain.User{}, false
	}
	user, ok := h.users[id]
	return user, ok
}

func (h *Hosted) Organisation() domain.Organisation { return h.org }

func (h *Hosted) Users() []domain.User {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]domain.User, 0, len(h.users))
	for _, user := range h.users {
		out = append(out, user)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].DisplayName < out[j].DisplayName })
	return out
}

func (h *Hosted) UserByID(id domain.UserID) (domain.User, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	user, ok := h.users[id]
	if !ok {
		return domain.User{}, fmt.Errorf("%w: user %q", domain.ErrNotFound, id)
	}
	return user, nil
}

// Resolve accepts a user id. A hosted directory has no handles: people are
// whoever they said they were when they registered.
func (h *Hosted) Resolve(reference string) (domain.User, error) {
	return h.UserByID(domain.UserID(strings.TrimSpace(reference)))
}
```

- [ ] **Step 4: Run it green**

Run: `cd services/control && go test ./internal/directory/ -v`
Expected: PASS, including the existing `Dev` directory tests, which must be untouched.

- [ ] **Step 5: Commit**

```bash
git add services/control/internal/directory
git commit -m "control: a directory people can join, that remembers them"
```

---

### Task 3: Bearer authentication, with the dev header kept on a leash

**Files:**
- Modify: `services/control/internal/httpapi/identity.go`
- Modify: `services/control/internal/httpapi/realtime.go:33-49`
- Modify: `protocol/go/realtime.go` (add `QueryToken`)
- Modify: `protocol/ts/src/` (mirror the constant — match the file that exports `QUERY_DEV_USER`)
- Create: `services/control/internal/httpapi/auth_test.go`

**Interfaces:**
- Consumes: `(*directory.Hosted).ResolveToken` from Task 2.
- Produces: `(*Server).authenticate(r *http.Request) (domain.User, error)`, used by both `requireIdentity` and `handleRealtime`; `protocol.QueryToken = "token"`.

- [ ] **Step 1: Write the failing test**

`auth_test.go`. Build the server with the existing helper `testServer(t *testing.T) *Server` (`httpapi/server_test.go:14`) — read it first and follow it rather than constructing a `Server` by hand.

```go
func TestBearerTokenAuthenticates(t *testing.T)
// Register a user in a Hosted directory, call GET /api/me with
// "Authorization: Bearer <token>", expect 200 and that user.

func TestForgedBearerTokenIsRejected(t *testing.T)
// "Authorization: Bearer nonsense" -> 401 "unauthenticated".

func TestDevUserHeaderIsRefusedFromANonLoopbackCaller(t *testing.T)
// LAYUP_ENV=selfhosted, RemoteAddr "203.0.113.9:5555",
// X-Layup-Dev-User: nick -> 401. This is the impersonation hole closing.

func TestDevUserHeaderStillWorksOnLoopback(t *testing.T)
// RemoteAddr "127.0.0.1:5555", X-Layup-Dev-User: nick -> 200.
// Every existing test depends on this and none may be rewritten.

func TestRealtimeAcceptsATokenQueryParameter(t *testing.T)
// GET /api/realtime?protocolVersion=1&token=<token> upgrades successfully.
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd services/control && go test ./internal/httpapi/ -run 'Bearer|DevUserHeader|TokenQuery' -v`
Expected: FAIL — the dev-user header is currently accepted from anywhere.

- [ ] **Step 3: Add the protocol constant**

In `protocol/go/realtime.go`, beside `QueryDevUser`:

```go
	// QueryToken carries a bearer token on the WebSocket handshake. The
	// browser WebSocket API cannot set headers, so the token travels in the
	// URL - which is safe only under TLS, and only if it never reaches a log.
	QueryToken = "token"
```

Mirror it in the TypeScript binding beside `QUERY_DEV_USER` as `export const QUERY_TOKEN = 'token';`.

- [ ] **Step 4: Implement the shared authenticator**

In `identity.go`, add — and note the token is never included in an error message:

```go
// HeaderAuthorization carries a bearer token issued by POST /api/register.
const HeaderAuthorization = "Authorization"

// TokenResolver is the half of a directory that can answer for a bearer token.
// The development directory does not implement it, which is the point.
type TokenResolver interface {
	ResolveToken(token string) (domain.User, bool)
}

func bearerToken(r *http.Request) string {
	header := r.Header.Get(HeaderAuthorization)
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// authenticate resolves the caller from a bearer token, falling back to the
// development header only where that cannot be an impersonation risk.
//
// The token is never echoed into an error: an error message is a log line
// waiting to happen.
func (s *Server) authenticate(r *http.Request) (domain.User, error) {
	token := bearerToken(r)
	if token == "" {
		token = r.URL.Query().Get(protocol.QueryToken)
	}
	if token != "" {
		resolver, ok := s.directory.(TokenResolver)
		if !ok {
			return domain.User{}, fmt.Errorf("%w: this server does not issue tokens", domain.ErrNotFound)
		}
		user, ok := resolver.ResolveToken(token)
		if !ok {
			return domain.User{}, fmt.Errorf("%w: unrecognised token", domain.ErrNotFound)
		}
		return user, nil
	}

	reference := r.Header.Get(HeaderDevUser)
	if reference == "" {
		reference = r.URL.Query().Get(protocol.QueryDevUser)
	}
	if reference == "" {
		return domain.User{}, fmt.Errorf("%w: no credentials", domain.ErrNotFound)
	}
	// A declared identity is only ever trustworthy from this machine.
	if s.cfg.Environment != "dev" && !isLoopback(r) {
		return domain.User{}, fmt.Errorf("%w: %s is not accepted from a remote caller", domain.ErrNotFound, HeaderDevUser)
	}
	return s.directory.Resolve(reference)
}
```

Replace the body of `requireIdentity` between reading the header and building `Identity` with a single `user, err := s.authenticate(r)`, keeping the existing error mapping. Replace `realtime.go:33-49` with the same call.

- [ ] **Step 5: Run it green**

Run: `cd services/control && go test ./... && cd ../../protocol/go && go test ./...`
Expected: PASS, **including every pre-existing `httpapi` test** — they run on loopback via `httptest`, so the fallback still applies to them.

- [ ] **Step 6: Commit**

```bash
git add services/control/internal/httpapi protocol
git commit -m "control: a token decides who you are, not a header you typed"
```

---

### Task 4: Registration, and proving the token never leaks

**Files:**
- Create: `services/control/internal/httpapi/register.go`
- Create: `services/control/internal/httpapi/register_test.go`
- Modify: `services/control/internal/httpapi/server.go:65,125-160`
- Modify: `services/control/cmd/control/main.go`

**Interfaces:**
- Consumes: `Config.JoinCode`, `Config.StateDir`, `directory.NewHosted`, `(*Hosted).Register`.
- Produces: `POST /api/register` accepting `{"code":"...","displayName":"..."}` and returning an envelope containing `{"token":"...","user":{...},"organisation":{...}}`. Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Again via `testServer` (`httpapi/server_test.go:14`), with a `Hosted` directory and a configured join code.

```go
func TestRegisterWithTheRightCodeReturnsATokenAndUser(t *testing.T)
// POST /api/register {"code":"LAYUP-7K2M","displayName":"Nick"} -> 200,
// non-empty token, user.displayName == "Nick".
// Then GET /api/directory with that bearer token lists Nick.

func TestRegisterWithTheWrongCodeIsRejected(t *testing.T)
// {"code":"nope"} -> 403 "forbidden". The response must not reveal the code.

func TestRegisterIsRefusedWhenNoJoinCodeIsConfigured(t *testing.T)
// cfg.JoinCode == "" -> 403 for any code, including "".

func TestRegisterRejectsABlankDisplayName(t *testing.T)
// {"code": <valid>, "displayName":"  "} -> 400 "invalid_request".

func TestTheTokenIsNeverLogged(t *testing.T)
// Capture the slog output around a successful register plus an authenticated
// GET /api/me, and assert the token string appears nowhere in it. Mirrors the
// existing "typed content is never logged" discipline.
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd services/control && go test ./internal/httpapi/ -run Register -v`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement the handler**

`register.go`:

```go
package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"github.com/layup-app/layup/services/control/internal/directory"
)

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
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		s.writeAPIError(w, r, http.StatusBadRequest, "invalid_request", "malformed body")
		return
	}

	// Constant time, and the configured code is never echoed back.
	if s.cfg.JoinCode == "" ||
		subtle.ConstantTimeCompare([]byte(body.Code), []byte(s.cfg.JoinCode)) != 1 {
		s.writeAPIError(w, r, http.StatusForbidden, "forbidden", "that join code is not valid for this server")
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
```

Match `userDTO`/`organisationDTO`/`writeEnvelope` to the helpers already in `directory.go`; if their names differ, use the existing ones rather than adding new ones.

- [ ] **Step 4: Route it and wire the directory**

In `server.go` `routes()`, register on the **public** (versioned, unauthenticated) mux, beside `GET /api/protocol`:

```go
	public.HandleFunc("POST /api/register", s.handleRegister)
```

At `server.go:65`, choose the directory by configuration:

```go
		if cfg.StateDir != "" && cfg.JoinCode != "" {
			hosted, err := directory.NewHosted(filepath.Join(cfg.StateDir, "identities.json"))
			if err != nil {
				return nil, err
			}
			dir = hosted
		} else {
			dir = directory.NewDev()
		}
```

Follow whatever error-returning shape the surrounding constructor already uses; if it cannot return an error, thread the directory in from `cmd/control/main.go` instead and keep `NewDev()` as the default.

- [ ] **Step 5: Run it green**

Run: `cd services/control && go test ./... -v`
Expected: PASS, all suites.

- [ ] **Step 6: Deploy and verify against the real server**

Add `LAYUP_JOIN_CODE` and `LAYUP_STATE_DIR=/var/lib/layup` to `/etc/layup/control.env`, then:

```bash
make deploy
curl -s -X POST https://layup.blah.au/api/register \
  -H 'X-Layup-Protocol-Version: 1' -H 'content-type: application/json' \
  -d '{"code":"LAYUP-7K2M","displayName":"Nick"}' | jq
```

Expected: an envelope with a token and a user. Then confirm the hole is shut:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://layup.blah.au/api/me \
  -H 'X-Layup-Protocol-Version: 1' -H 'X-Layup-Dev-User: nick'
```

Expected: `401`. Before this task it would have been `200`.

- [ ] **Step 7: Commit**

```bash
git add services/control
git commit -m "control: register with a code, leave with a token"
```

---

### Task 5: The desktop remembers a server

**Files:**
- Create: `apps/desktop/src/main/config.ts`
- Create: `apps/desktop/src/main/config.test.ts`

**Interfaces:**
- Produces:
  - `type DesktopConfig = { serverUrl: string; token: string; userId: string; displayName: string }`
  - `createConfigStore(options: { path: string }): ConfigStore`
  - `ConfigStore = { read(): DesktopConfig | undefined; write(next: DesktopConfig): void; clear(): void }`
  Consumed by Tasks 6, 7 and 8.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigStore } from './config';

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'layup-config-')), 'config.json');

describe('the desktop configuration store', () => {
  it('has nothing to say before a server has been added', () => {
    expect(createConfigStore({ path: tempPath() }).read()).toBeUndefined();
  });

  it('round-trips a server through the file', () => {
    const path = tempPath();
    const config = { serverUrl: 'https://layup.blah.au', token: 't0ken', userId: 'usr_abc12345', displayName: 'Nick' };
    createConfigStore({ path }).write(config);
    // A second store is a second launch of the application.
    expect(createConfigStore({ path }).read()).toEqual(config);
  });

  it('treats a corrupt file as no configuration rather than crashing on launch', () => {
    const path = tempPath();
    require('node:fs').writeFileSync(path, '{ not json');
    expect(createConfigStore({ path }).read()).toBeUndefined();
  });

  it('forgets everything on clear, so a wrong server can be escaped', () => {
    const path = tempPath();
    const store = createConfigStore({ path });
    store.write({ serverUrl: 'https://layup.blah.au', token: 't', userId: 'usr_abc12345', displayName: 'Nick' });
    store.clear();
    expect(store.read()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace apps/desktop -- config`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 3: Implement it**

`config.ts`. Written with mode `0600` because it holds a bearer token.

```typescript
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The first thing this application has ever persisted.
 *
 * It holds a bearer token, so it is written 0600 and never logged. A corrupt
 * file is treated as "no server yet" rather than as a fatal error: the worst
 * outcome of a bad byte should be re-adding a server, not an app that will not
 * start.
 */
export interface DesktopConfig {
  serverUrl: string;
  token: string;
  userId: string;
  displayName: string;
}

export interface ConfigStore {
  read(): DesktopConfig | undefined;
  write(next: DesktopConfig): void;
  clear(): void;
}

function isConfig(value: unknown): value is DesktopConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.serverUrl === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.userId === 'string' &&
    typeof candidate.displayName === 'string' &&
    candidate.serverUrl !== '' &&
    candidate.token !== ''
  );
}

export function createConfigStore(options: { path: string }): ConfigStore {
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(options.path, 'utf8'));
        return isConfig(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    write(next) {
      mkdirSync(dirname(options.path), { recursive: true });
      writeFileSync(options.path, JSON.stringify(next, null, 2), { mode: 0o600 });
    },
    clear() {
      rmSync(options.path, { force: true });
    },
  };
}
```

- [ ] **Step 4: Run it green**

Run: `npm test --workspace apps/desktop -- config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/config.ts apps/desktop/src/main/config.test.ts
git commit -m "desktop: remember which server, and who we are on it"
```

---

### Task 6: The clients carry the token

**Files:**
- Modify: `apps/desktop/src/core/control-client.ts`
- Modify: `apps/desktop/src/core/realtime-client.ts:86` (`realtimeUrl`)
- Modify: `apps/desktop/src/core/control-client.test.ts`
- Modify: `apps/desktop/src/core/realtime-client.test.ts`

**Interfaces:**
- Consumes: `DesktopConfig.token`.
- Produces: `createControlClient({ baseUrl, devUser?, token? })` sending `Authorization: Bearer` when a token is present; `realtimeUrl(baseUrl, devUser, token?)` appending `token=` when present. `devUser` stays optional so local development is unchanged.

- [ ] **Step 1: Write the failing tests**

```typescript
it('sends the bearer token when it has one', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  const client = createControlClient({ baseUrl: 'https://layup.blah.au', token: 't0ken', fetchImpl: fetchMock });
  await client.me().catch(() => undefined);
  const headers = new Headers(fetchMock.mock.calls[0][1].headers);
  expect(headers.get('authorization')).toBe('Bearer t0ken');
});

it('falls back to the dev header when there is no token', async () => { /* asserts X-Layup-Dev-User is sent and authorization is not */ });

it('puts the token on the realtime url', () => {
  expect(realtimeUrl('https://layup.blah.au', '', 't0ken')).toContain('token=t0ken');
});

it('leaves the dev handshake alone when there is no token', () => {
  expect(realtimeUrl('http://127.0.0.1:8787', 'nick')).toContain('devUser=nick');
});
```

Match the existing option and injection names in each file rather than inventing new ones.

- [ ] **Step 2: Run and watch them fail**

Run: `npm test --workspace apps/desktop -- control-client realtime-client`
Expected: FAIL — no token option exists.

- [ ] **Step 3: Implement**

Add an optional `token` to both clients. When present, `control-client` sets `Authorization: Bearer <token>` and omits `X-Layup-Dev-User`; `realtimeUrl` sets the `token` search parameter and omits `devUser`. When absent, both behave exactly as they do today.

- [ ] **Step 4: Run green**

Run: `npm test --workspace apps/desktop`
Expected: PASS — all 366 existing tests plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/core
git commit -m "desktop: carry the token, keep the dev handshake for home"
```

---

### Task 7: Add a server, and be in the People grid

**Files:**
- Create: `apps/desktop/src/renderer/onboarding/AddServer.tsx`
- Create: `apps/desktop/src/renderer/onboarding/AddServer.test.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx:46-100`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/api.ts`
- Modify: `apps/desktop/src/main/index.ts:47-58,189+`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/test/boundary/` fixture listing the preload surface

**Interfaces:**
- Consumes: `createConfigStore` (Task 5), the token-aware clients (Task 6), `POST /api/register` (Task 4).
- Produces IPC: `server:state` → `{ configured: boolean; serverUrl?: string; displayName?: string }`; `server:add({ serverUrl, code, displayName })` → `{ ok: true } | { ok: false; message: string }`; `server:forget()`. Event `server:changed`.

- [ ] **Step 1: Write the failing component test**

```tsx
it('asks for a server, a code and a name, and nothing else', () => { /* three fields, one button */ });

it('reports the server\'s own words when the code is wrong', async () => {
  // server:add resolves { ok: false, message: 'that join code is not valid for this server' }
  // Expect that sentence on screen. A generic "something went wrong" would send
  // the other person to us instead of to the code.
});

it('normalises a bare hostname into an https url', async () => {
  // typing "layup.blah.au" must call server:add with "https://layup.blah.au"
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test --workspace apps/desktop -- AddServer`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the screen and the IPC**

The screen renders three labelled inputs and a Connect button, disables the button while in flight, and surfaces the server's `message` verbatim on failure. In main, `server:add` posts to `POST /api/register`, writes the returned config through the store, rebuilds the control and realtime clients against the new `serverUrl` and `token`, and broadcasts `server:changed`.

Validate both IPC directions as the existing handlers do, and add the three new channels to the boundary fixture — `make test-boundary` fails on an unlisted channel, which is the point of it.

- [ ] **Step 4: Gate the application on it**

In `App.tsx`, before the `inLayup` branch: if `server:state` reports `configured: false`, render `<AddServer />` and nothing else. There is no People grid to show and no server to ask.

- [ ] **Step 5: Run green**

```bash
npm test --workspace apps/desktop && make test-boundary
```

Expected: PASS and `BOUNDARY OK`.

- [ ] **Step 6: Verify by hand against the deployed server — this is the task's real deliverable**

```bash
npm run dev --workspace apps/desktop
```

Add `layup.blah.au`, the join code, the name `Nick`. Then in a second checkout or with a second `userData` directory, do the same as `Karl`. **Both must appear in each other's People grid.**

- [ ] **Step 7: Commit**

```bash
git add apps/desktop
git commit -m "desktop: add a server, and you are in the room"
```

---

### Task 8: The join link

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/deep-link.ts`
- Create: `apps/desktop/src/main/deep-link.test.ts`
- Modify: `apps/desktop/src/renderer/onboarding/AddServer.tsx`
- Create: `deploy/vm/public/join/index.html`

**Interfaces:**
- Consumes: the `server:add` IPC from Task 7.
- Produces: `parseJoinLink(url: string): { serverUrl: string; code: string } | undefined`; event `server:prefill` carrying the parsed values to the renderer.

- [ ] **Step 1: Write the failing test**

```typescript
it('reads a server and a code out of a join link', () => {
  expect(parseJoinLink('layup://join?server=layup.blah.au&code=LAYUP-7K2M'))
    .toEqual({ serverUrl: 'https://layup.blah.au', code: 'LAYUP-7K2M' });
});

it('ignores a link that is not ours', () => {
  expect(parseJoinLink('https://example.com/join?code=x')).toBeUndefined();
});

it('ignores a link with no code', () => {
  expect(parseJoinLink('layup://join?server=layup.blah.au')).toBeUndefined();
});

it('never lets a link choose a non-https server', () => {
  // A link that could point the app at http:// could downgrade the token to
  // cleartext. Refuse it.
  expect(parseJoinLink('layup://join?server=http://evil.example&code=x')).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test --workspace apps/desktop -- deep-link`
Expected: FAIL.

- [ ] **Step 3: Implement**

Write `parseJoinLink`. In `main/index.ts`, call `app.setAsDefaultProtocolClient('layup')`, handle the macOS `open-url` event, and forward the parsed values to the renderer as `server:prefill`. `AddServer` fills the server and code fields from it, leaving the name empty and focused.

- [ ] **Step 4: Write the join page**

`deploy/vm/public/join/index.html` — plain HTML, no build step. It shows the join code, a **Download Layup** button (populated by plan 03), and an **Open in Layup** button pointing at `layup://join?server=layup.blah.au&code=<code>`. Directly beneath, in normal-sized text rather than fine print, the code itself with *"if that button does nothing, Layup isn't installed yet — or paste this code into Add server."* The button silently doing nothing is the expected first-run behaviour, and the page must say so.

Add to `bootstrap.sh`, before the caddy step:

```bash
if [ -d "$ASSETS/public" ]; then
  cp -r "$ASSETS/public/." /srv/layup/public/
fi
```

- [ ] **Step 5: Run green and deploy the page**

```bash
npm test --workspace apps/desktop && make deploy-config
curl -s https://layup.blah.au/join/ | head -5
```

Expected: tests PASS and the page returns HTML.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop deploy/vm
git commit -m "desktop: a link that fills the form in, and a page that admits when it cannot"
```

---

## Done when

- Two desktops, configured only through the Add-server screen, appear in each other's People grid on `layup.blah.au`.
- `curl https://layup.blah.au/api/me -H 'X-Layup-Dev-User: nick'` returns `401`.
- Restarting the control service does not require either person to re-onboard.
- The token appears in no log line, proven by a test.
- `make check`, `make test-boundary` and `node test/network/remote-health.mjs` are all green.
