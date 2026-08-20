# Releasing the macOS app

This produces a signed, notarised, stapled DMG that someone else can download
and open without arguing with Gatekeeper.

## What you need in the environment

Three variables. **None of them belong in this repository** — no committed
`.p8`, no issuer UUID in a file here, nothing pasted into a commit message.
`.gitignore` blocks `*.p8` as a backstop, not as permission.

| Variable | What it is |
| --- | --- |
| `APPLE_API_KEY` | Filesystem **path** to the App Store Connect API key, an `AuthKey_<KEYID>.p8`. Kept outside the repo (ours lives under `~/code/boringapps/.secrets/`). |
| `APPLE_API_KEY_ID` | The key ID — the `<KEYID>` in the filename. |
| `APPLE_API_ISSUER` | The issuer UUID from App Store Connect (36 characters). Stored alongside the key, outside the repo. Trim trailing whitespace when reading it from a file. |

You also need a **Developer ID Application** certificate in the login keychain.
Confirm there is exactly one, and note its Team ID:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

Ours is `Developer ID Application: The IT Dept Pty Ltd (W62CSN3S5H)` — Team ID
`W62CSN3S5H`. electron-builder picks it up automatically; there is no identity
name in `electron-builder.yml` to drift out of date.

## The two commands

```bash
# Unsigned, for a quick local check. Skips signing and notarisation entirely.
CSC_IDENTITY_AUTO_DISCOVERY=false make package

# The real thing: universal helper, universal app, signed, notarised, stapled.
export APPLE_API_KEY="/path/to/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="$(tr -d ' \t\r\n' < /path/to/issuer.txt)"
make release
```

`make release` depends on `build-helper`, so the Go input helper is rebuilt
universal-and-cgo-enabled every time. Notarisation is a network round trip to
Apple and takes a few minutes.

It runs in **two** notarisation passes, and the second one is not optional:

1. electron-builder signs the app (including the helper), notarises the `.app`
   and staples the ticket to it.
2. electron-builder then builds the DMG *around* that stapled app — which makes
   the DMG a brand new, **unsigned** artifact with no ticket of its own.
   `scripts/notarize-dmg.sh` then signs, notarises and staples the DMG.

Skipping step 2 leaves you with a DMG that `spctl` rejects outright with
`source=no usable signature`. Since the DMG is the file you actually send
someone, Gatekeeper judges it before anyone gets near the app inside. The
`.app` being perfectly notarised does not save you. `make release` does both
steps; if you ever run `electron-builder` by hand, run the script afterwards.

Output lands in `apps/desktop/release/`:

- `Layup-<version>-universal.dmg` — the thing you send someone.
- `mac-universal/Layup.app` — the bundle inside it, handy for verification.

## Verification — run all of it, believe none of it until you have

```bash
APP="apps/desktop/release/mac-universal/Layup.app"
DMG="$(ls apps/desktop/release/*.dmg)"
```

### 1. The helper is universal

```bash
lipo -archs "$APP/Contents/Resources/layup-input-helper"
```

Expect `x86_64 arm64`. One architecture means half your users get a helper that
cannot start, and nothing else in the build will tell you.

### 2. The helper was built with cgo — **this one is quietly fatal**

```bash
otool -L "$APP/Contents/Resources/layup-input-helper" | grep -E 'ApplicationServices|CoreGraphics'
```

Expect both frameworks. macOS input injection goes through CoreGraphics, which
needs cgo. `native/input-helper/internal/inject/inject_darwin_nocgo.go` exists
so a `CGO_ENABLED=0` build still *compiles* — and then reports
`"this helper was built without cgo, so macOS input injection is unavailable"`
and injects nothing. It starts, it looks healthy, remote control does nothing.
`native/input-helper/build.sh` forces `CGO_ENABLED=1` and refuses to emit a
binary missing an architecture; this check confirms the binary in the bundle is
the one it made.

### 3. The Team ID matches on the app **and** the helper — the check that matters

```bash
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'TeamIdentifier|Authority'
codesign -dv --verbose=4 "$APP/Contents/Resources/layup-input-helper" 2>&1 | grep -E 'TeamIdentifier|Authority'
```

Expect an **identical `TeamIdentifier`** on both.

This is the single check that predicts whether remote control works for a real
person. macOS attributes the Accessibility (TCC) grant to a code-signing
identity. If the helper carries a different Team ID from the app — or is
unsigned, or ad-hoc signed — then the user ticking "Layup" in
Privacy & Security → Accessibility grants the *app* permission and the *helper*
gets nothing. The helper then runs, answers healthy, and silently drops every
click. `binaries: [Contents/Resources/layup-input-helper]` in
`electron-builder.yml` is what makes electron-builder sign it with the app's
identity; if that entry is lost, this check is how you find out.

### 4. Nothing in the bundle is unsigned or damaged

```bash
codesign --verify --deep --strict --verbose=2 "$APP"
```

Expect `satisfies its Designated Requirement`. `--deep` walks the nested code,
including the helper and the Electron frameworks.

### 5. Notarisation actually happened, and the ticket is attached

```bash
xcrun stapler validate "$DMG"
xcrun stapler validate "$APP"
```

Expect `The validate action worked!` from **both**. Check the DMG especially:
electron-builder staples the app for you, so the app passing tells you nothing
about the container. Stapling matters because it embeds the notarisation ticket
in the artifact — without it, a machine that is offline or behind a filtering
network cannot reach Apple to confirm notarisation, and Gatekeeper blocks a
download that worked fine on your desk.

### 6. Gatekeeper accepts it as notarised

```bash
spctl -a -vvv -t install "$APP"
spctl -a -vvv -t open --context context:primary-signature "$DMG"
```

Expect `accepted` and `source=Notarized Developer ID` from both.
`source=Developer ID` without "Notarized" means it is signed but not notarised:
your friend gets "Apple could not verify Layup is free of malware" and has to
right-click-open. `source=no usable signature` on the DMG means step 2 of the
release did not run.

Note that the stale `Layup-<version>-universal.dmg.blockmap` next to the DMG
describes the pre-signing DMG and no longer matches it. It is only used by
electron-updater differential downloads, which this project does not use; if
auto-update is ever added, regenerate it after signing.

### 7. It runs

```bash
open "$APP"
```

Expect the Add-server screen.

## When notarisation is rejected

electron-builder prints the submission ID. Get the reason:

```bash
xcrun notarytool log <submission-id> \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
```

Usual causes, in rough order of likelihood:

- **Hardened runtime missing.** `hardenedRuntime: true` must stay in the `mac:`
  block. Notarisation refuses anything without it.
- **An unsigned nested binary** — almost always the helper. See check 3.
- **A missing or wrong entitlement.** Electron will not launch under the
  hardened runtime without `com.apple.security.cs.allow-jit` and
  `com.apple.security.cs.allow-unsigned-executable-memory`; the helper is a
  separate Mach-O in the bundle, which is why
  `com.apple.security.cs.disable-library-validation` is there too. They live in
  `apps/desktop/build/entitlements.mac.plist`.

Fix the cause and rerun `make release`. Do not ship un-notarised quietly — if
you have to, say so loudly to whoever is installing it, because they will hit a
Gatekeeper wall and assume the app is broken.

## Permissions the person installing it will be asked for

Camera and microphone are entitlements plus the `NS*UsageDescription` strings
in `electron-builder.yml`; macOS prompts on first use. Screen Recording and
Accessibility are **not** grantable by entitlement — the user must tick them in
System Settings → Privacy & Security. Accessibility is the one remote control
depends on, and check 3 above is what makes a single tick cover the helper.
