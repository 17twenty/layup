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
