# A Mac App You Can Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed, notarised, universal `Layup.dmg` downloadable from `layup.blah.au`, containing the input helper, that gets one Accessibility grant and can then move the other person's mouse.

**Architecture:** electron-builder produces a universal (arm64 + x64) app. The Go input helper is built universal with cgo, placed in `Contents/Resources/layup-input-helper` — which is exactly where `main/index.ts:192` already looks — and signed with the same Team ID as the app, so TCC attributes it to the parent bundle and one Accessibility grant covers both. Hardened runtime with the two entitlements Electron cannot launch without, plus camera and microphone usage strings whose absence is a crash rather than a missing prompt. Notarised with `notarytool` using an App Store Connect API key, then stapled.

**Tech Stack:** electron-builder, Go 1.26.4 with cgo, `lipo`, `codesign`, `notarytool`, Caddy for hosting.

**Spec:** `docs/superpowers/specs/2026-08-17-two-person-dogfood-design.md`

## Global Constraints

- Universal binaries throughout — the app and the helper — so it does not matter which Mac is Apple Silicon.
- **The helper must be built with `CGO_ENABLED=1`.** `native/input-helper/internal/inject/inject_darwin_nocgo.go` compiles happily without cgo and then reports that it cannot inject. A silent no-op helper is the exact failure this plan exists to prevent.
- The helper is signed with the **same Team ID** as the app. Different identities mean two Accessibility grants, and the second one nobody knows to give.
- Signing identity: Developer ID Application, already in the Mac's keychain. Notarisation uses an App Store Connect API key.
- **No secrets in git.** Keys and identities come from the environment or a keychain profile; `dist/` and `*.p8` stay in `.gitignore`.
- Task 6 is the risk gate from spec §10. If it fails, stop and re-plan rather than building features on top of an assumption that turned out to be false.

---

### Task 1: Build the input helper, universal and able to inject

**Files:**
- Create: `native/input-helper/Makefile` *(or)* Modify: root `Makefile`
- Modify: root `Makefile` (add `build-helper`)
- Create: `native/input-helper/build.sh`

**Interfaces:**
- Produces: `dist/helper/layup-input-helper`, a universal Mach-O. Consumed by Task 2.

- [ ] **Step 1: Confirm the failure mode is real before fixing it**

```bash
cd native/input-helper && CGO_ENABLED=0 go build -o /tmp/helper-nocgo ./cmd/layup-input-helper && echo built
```

Expected: it builds. That is the trap — this binary runs and refuses to inject. Nothing in the repository currently prevents shipping it.

- [ ] **Step 2: Write the build script**

`native/input-helper/build.sh`:

```bash
#!/usr/bin/env bash
# Builds the input helper as a universal macOS binary.
#
# cgo is mandatory: the CGO_ENABLED=0 build compiles cleanly and then declines
# to inject anything (see inject_darwin_nocgo.go). A helper that starts, reports
# healthy and does nothing is the worst outcome available, so this script
# refuses to produce one.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
OUT="${1:-../../dist/helper}"
mkdir -p "$OUT"

echo "==> arm64"
CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 \
  CGO_CFLAGS="-arch arm64" CGO_LDFLAGS="-arch arm64" \
  go build -trimpath -o "$OUT/layup-input-helper-arm64" ./cmd/layup-input-helper

echo "==> amd64"
CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 \
  CGO_CFLAGS="-arch x86_64" CGO_LDFLAGS="-arch x86_64" \
  go build -trimpath -o "$OUT/layup-input-helper-amd64" ./cmd/layup-input-helper

echo "==> lipo"
lipo -create -output "$OUT/layup-input-helper" \
  "$OUT/layup-input-helper-arm64" "$OUT/layup-input-helper-amd64"
rm -f "$OUT/layup-input-helper-arm64" "$OUT/layup-input-helper-amd64"

# A universal binary that lost an architecture is not obviously broken until
# somebody with the other Mac tries it.
archs="$(lipo -archs "$OUT/layup-input-helper")"
case "$archs" in
  *arm64*x86_64*|*x86_64*arm64*) ;;
  *) echo "FATAL: expected both architectures, got: $archs" >&2; exit 1 ;;
esac
echo "helper built: $OUT/layup-input-helper ($archs)"
```

- [ ] **Step 3: Make it executable, add the Makefile target, and run it**

```makefile
.PHONY: build-helper
build-helper: ## Build the input helper as a universal macOS binary
	bash native/input-helper/build.sh
```

Run: `chmod +x native/input-helper/build.sh && make build-helper`
Expected: `helper built: ... (x86_64 arm64)`.

- [ ] **Step 4: Prove this build can actually inject**

```bash
LAYUP_ALLOW_REAL_INPUT=1 go test ./internal/inject -run Darwin -v
```

Run from `native/input-helper`. Expected: PASS, or a clear "Accessibility not granted" — **not** "built without cgo". If it says the latter, the build script is wrong and nothing downstream is worth doing.

- [ ] **Step 5: Commit**

```bash
git add native/input-helper/build.sh Makefile
git commit -m "helper: build it for both Macs, and refuse to build it deaf"
```

---

### Task 2: Package the app with the helper inside it

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/build/entitlements.mac.plist`
- Modify: `apps/desktop/package.json` (devDependency + scripts)
- Modify: `.gitignore`
- Modify: root `Makefile` (add `package`)

**Interfaces:**
- Consumes: `dist/helper/layup-input-helper` from Task 1.
- Produces: `apps/desktop/release/Layup-<version>-universal.dmg`, and `Contents/Resources/layup-input-helper` inside the app — the path `main/index.ts:192` already expects, so **no application code changes**.

- [ ] **Step 1: Add electron-builder**

```bash
npm install --save-dev --workspace apps/desktop electron-builder@26
```

- [ ] **Step 2: Write the entitlements**

`apps/desktop/build/entitlements.mac.plist`. The first two are not optional — Electron will not launch under the hardened runtime without them.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.cs.allow-jit</key>
	<true/>
	<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
	<true/>
	<!-- The helper is a separate Mach-O inside the bundle. -->
	<key>com.apple.security.cs.disable-library-validation</key>
	<true/>
	<key>com.apple.security.device.camera</key>
	<true/>
	<key>com.apple.security.device.audio-input</key>
	<true/>
</dict>
</plist>
```

- [ ] **Step 3: Write the builder configuration**

`apps/desktop/electron-builder.yml`:

```yaml
appId: au.blah.layup
productName: Layup
copyright: Layup
directories:
  output: release
  buildResources: build

files:
  - dist/**/*
  - package.json

# Placed where main/index.ts:192 already looks: process.resourcesPath.
extraResources:
  - from: ../../dist/helper/layup-input-helper
    to: layup-input-helper

mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch: [universal]
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  # Signed with the same identity as the app, so TCC attributes the helper to
  # the parent bundle and one Accessibility grant covers both.
  binaries:
    - Contents/Resources/layup-input-helper
  extendInfo:
    # Their absence is not a missing prompt - it is a hard crash on the first
    # getUserMedia call.
    NSCameraUsageDescription: Layup shows your face to the person you are pairing with.
    NSMicrophoneUsageDescription: Layup carries your voice to the person you are pairing with.
    # Screen Recording is granted by prompt, not entitlement, but the string is
    # what the person reads when macOS asks.
    NSScreenCaptureUsageDescription: Layup shares your screen with the person you are pairing with.

dmg:
  artifactName: Layup-${version}-universal.dmg
```

- [ ] **Step 4: Add the scripts and ignore the outputs**

In `apps/desktop/package.json` scripts: `"package": "npm run build && electron-builder --mac --universal"`.

In root `.gitignore`: `dist/`, `apps/desktop/release/`, `*.p8`.

In root `Makefile`:

```makefile
.PHONY: package
package: build-helper ## Build the macOS app, unsigned
	npm run package --workspace apps/desktop
```

- [ ] **Step 5: Build it unsigned and check the helper made it in**

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false make package
ls apps/desktop/release/*.dmg
lipo -archs "apps/desktop/release/mac-universal/Layup.app/Contents/Resources/layup-input-helper"
```

Expected: a DMG exists, and the helper reports `x86_64 arm64`. Adjust the `mac-universal` path segment to whatever electron-builder actually produced.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/build apps/desktop/package.json package-lock.json .gitignore Makefile
git commit -m "desktop: an app with the helper in it, where the code already looks"
```

---

### Task 3: Sign and notarise

**Files:**
- Modify: `apps/desktop/electron-builder.yml`
- Modify: root `Makefile` (add `release`)
- Create: `docs/releasing.md`

**Interfaces:**
- Consumes: the package from Task 2.
- Produces: a stapled, notarised DMG. Requires `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` in the environment.

- [ ] **Step 1: Confirm the signing identity exists**

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

Expected: exactly one. Note the Team ID in the parentheses — it is what makes the helper's signature match the app's.

- [ ] **Step 2: Enable notarisation**

Add to the `mac:` block in `electron-builder.yml`:

```yaml
  notarize: true
```

electron-builder reads `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` from the environment.

- [ ] **Step 3: Add the release target**

```makefile
.PHONY: release
release: build-helper ## Build, sign and notarise the macOS app
	@test -n "$$APPLE_API_KEY" || (echo "set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER" && exit 1)
	npm run package --workspace apps/desktop
```

- [ ] **Step 4: Build a signed, notarised DMG**

```bash
export APPLE_API_KEY=~/keys/AuthKey_XXXXXX.p8
export APPLE_API_KEY_ID=XXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
make release
```

Expected: signing, then a notarisation submission that takes several minutes, then stapling.

- [ ] **Step 5: Verify the signature covers the helper too**

```bash
APP="apps/desktop/release/mac-universal/Layup.app"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'TeamIdentifier|Authority'
codesign -dv --verbose=4 "$APP/Contents/Resources/layup-input-helper" 2>&1 | grep -E 'TeamIdentifier|Authority'
spctl -a -vvv -t install "$APP"
xcrun stapler validate apps/desktop/release/*.dmg
```

Expected: **identical `TeamIdentifier` on both**; `spctl` reports `accepted, source=Notarized Developer ID`; stapler validates. A mismatched Team ID here is the single most likely cause of remote control failing later — fix it now, not in Task 6.

- [ ] **Step 6: Write the release notes**

`docs/releasing.md`: the three environment variables, the two commands, the four verification commands above and what each proves, and the Team ID check called out as the one that matters.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron-builder.yml Makefile docs/releasing.md
git commit -m "desktop: sign it, notarise it, and prove the helper is covered"
```

---

### Task 4: Host it on the domain

**Files:**
- Modify: `deploy/vm/public/join/index.html`
- Modify: root `Makefile` (add `publish`)

**Interfaces:**
- Consumes: the notarised DMG from Task 3; `/srv/layup/public` from plan 01.
- Produces: `https://layup.blah.au/download/Layup.dmg`.

- [ ] **Step 1: Add the publish target**

```makefile
.PHONY: publish
publish: ## Upload the built DMG to the dev VM
	@ls apps/desktop/release/*.dmg >/dev/null 2>&1 || (echo "run 'make release' first" && exit 1)
	ssh $(LAYUP_DEPLOY_HOST) 'install -d -m 0755 /srv/layup/public/download'
	scp apps/desktop/release/*.dmg $(LAYUP_DEPLOY_HOST):/srv/layup/public/download/Layup.dmg
	@echo "https://$(LAYUP_DEPLOY_DOMAIN)/download/Layup.dmg"
```

- [ ] **Step 2: Point the join page at it**

Set the Download Layup button's `href` to `/download/Layup.dmg`.

- [ ] **Step 3: Publish and verify**

```bash
make publish
make deploy-config
curl -sI https://layup.blah.au/download/Layup.dmg | head -3
```

Expected: `200 OK` and a `content-length` matching the local DMG.

- [ ] **Step 4: Commit**

```bash
git add Makefile deploy/vm/public
git commit -m "deploy: the app, at a URL you can send someone"
```

---

### Task 5: Install it the way the other person will

**Files:** none — this is a verification task, and its output is a decision.

- [ ] **Step 1: Download it as a stranger would**

On a Mac that has never built this repository:

```bash
curl -LO https://layup.blah.au/download/Layup.dmg
open Layup.dmg
```

Drag to Applications and launch.

Expected: **no Gatekeeper warning at all.** Notarisation is what buys this. If macOS says the app is damaged or from an unidentified developer, notarisation or stapling did not take — go back to Task 3 Step 5.

- [ ] **Step 2: Complete onboarding from the link**

Open `https://layup.blah.au/join/`, click **Open in Layup**, confirm the Add-server form is pre-filled with the server and code, type a name, Connect.

Expected: the People grid. If the button does nothing, the page's own fallback text should have told you to paste the code — confirm it did, because that sentence is the difference between "it's broken" and "here's what to do".

- [ ] **Step 3: Grant the permissions once and note exactly what was asked**

Start a share, then request remote control. Record, for `docs/releasing.md`: which prompts appeared, in which order, whether a restart was required, and whether Accessibility had to be granted to *Layup* or to something else. This is the note that makes the other person's setup take five minutes rather than forty.

- [ ] **Step 4: Commit the findings**

```bash
git add docs/releasing.md
git commit -m "docs: what macOS actually asks, in the order it asks it"
```

---

### Task 6: The risk gate — one real injected click

Spec §10 names this the assumption everything else rests on: that a notarised app with a bundled, same-Team-ID helper gets Accessibility attributed to the parent bundle. Everything up to here is reversible. This is where we find out.

**Files:**
- Create: `docs/superpowers/notes/2026-08-17-accessibility-attribution.md`

- [ ] **Step 1: Grant Accessibility to Layup and nothing else**

System Settings → Privacy & Security → Accessibility. Ensure **only** `Layup.app` is enabled — remove any entry for a bare `layup-input-helper`, Terminal or Electron left over from development, so the result is unambiguous.

- [ ] **Step 2: Verify the helper reports itself trusted**

With the app running:

```bash
log stream --predicate 'process == "Layup"' --info | grep -i 'input helper'
```

Expected: `input helper ready` with capabilities reporting injection **available**. If it reports the Accessibility permission missing while Layup is ticked, the attribution assumption has failed.

- [ ] **Step 3: Move the other machine's mouse**

Two machines, both on the notarised build, in a layup with a screen shared. Grant Mouse. Move the pointer.

Expected: the presenter's physical cursor moves.

- [ ] **Step 4: Write down the answer**

`docs/superpowers/notes/2026-08-17-accessibility-attribution.md`: whether one grant on `Layup.app` covered the bundled helper, the exact `codesign` Team ID of each, and what was ticked in Accessibility. State the result plainly either way.

**If it failed**, stop and re-plan. The known alternatives, in order of preference: register the helper as a `SMAppService` login item; move it from `Contents/Resources` to `Contents/MacOS`; or have the app itself post the events and reduce the helper to a privilege-separated relay. Do not start plan 04 on a broken assumption.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes
git commit -m "notes: whether one Accessibility grant covers the bundled helper"
```

---

## Done when

- `https://layup.blah.au/download/Layup.dmg` installs on a clean Mac with no Gatekeeper warning.
- The join link pre-fills Add server, and the fallback text is correct when it does not.
- `codesign` reports the same Team ID for the app and the helper.
- One Accessibility grant on `Layup.app` lets a remote participant move the presenter's cursor — **or** the failure is documented and plan 04 is on hold.
