#!/usr/bin/env bash
# Signs, notarises and staples the DMG itself.
#
# electron-builder notarises and staples the .app, then builds the DMG *around*
# the stapled app - so the DMG is a fresh, unsigned artifact with no ticket of
# its own. The app inside is fine; the container is not. Since the DMG is the
# thing that actually gets downloaded, Gatekeeper evaluates it first and
# rejects it with "no usable signature" before anyone reaches the app.
#
# A stapled ticket also means the check works offline: without it, a machine on
# a filtered network cannot reach Apple to confirm notarisation and blocks the
# download that worked fine on the build machine.
set -euo pipefail

DMG="${1:?usage: notarize-dmg.sh <path-to-dmg>}"
[ -f "$DMG" ] || { echo "no such DMG: $DMG" >&2; exit 1; }

: "${APPLE_API_KEY:?set APPLE_API_KEY to the path of the .p8}"
: "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"

# Use the same Developer ID as the app. CSC_NAME overrides when more than one
# certificate is installed; otherwise there must be exactly one, because
# quietly picking the wrong one produces a Team ID mismatch that only shows up
# as remote control silently doing nothing.
IDENTITY="${CSC_NAME:-}"
if [ -z "$IDENTITY" ]; then
  matches="$(security find-identity -v -p codesigning | grep "Developer ID Application" || true)"
  count="$(printf '%s' "$matches" | grep -c . || true)"
  if [ "$count" != "1" ]; then
    echo "expected exactly one Developer ID Application identity, found $count; set CSC_NAME" >&2
    exit 1
  fi
  IDENTITY="$(printf '%s' "$matches" | sed -E 's/.*"(.*)".*/\1/')"
fi

echo "==> signing $DMG"
codesign --sign "$IDENTITY" --timestamp --force "$DMG"

echo "==> notarising $DMG (this talks to Apple and takes a few minutes)"
xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

echo "==> stapling $DMG"
xcrun stapler staple "$DMG"

echo "==> validating"
xcrun stapler validate "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"
