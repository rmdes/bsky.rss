#!/usr/bin/env bash
# Starts a built bsky.rss image the way production does, without running any bot.
# Used by pr-checks.yml and release-image.yml (one definition, so they can't drift).
#
#   smoke-image.sh <image> [platform]      e.g. smoke-image.sh bsky-rss:ci linux/arm64
#
# Each entry point loads its whole import graph, then stops at a known, harmless error.
# Matching that exact message tells "loaded fine" apart from "crashed while importing".
set -euo pipefail

image="$1"
platform="${2:-}"
run=(docker run --rm)
[ -n "$platform" ] && run+=(--platform "$platform")

expect() {
  local name="$1" pattern="$2"
  shift 2
  local output
  # These checks are expected to exit non-zero; the message is what matters.
  output="$("${run[@]}" "$@" 2>&1 || true)"
  if grep -qE "$pattern" <<<"$output"; then
    echo "ok: $name"
  else
    echo "FAIL: $name (expected /$pattern/), output was:"
    echo "$output"
    exit 1
  fi
}

# Single-bot mode: the image's own CMD with no environment.
expect "single-bot entry point (CMD)" "Missing required environment variables" "$image"

# Fleet mode: the production command, pointed at a config root that doesn't exist.
expect "fleet entry point" "\[bsky.rss FATAL\] Fleet startup failed" \
  -e FLEET_CONFIG_ROOT=/nonexistent -e FLEET_SECRETS_PATH=/nonexistent/secrets.json \
  "$image" node --import tsx fleet/runFleet.ts

# The WebP decoder's WASM is only read and compiled on the first decode, never at import.
expect "WebP decode" "webp ok" "$image" node --import tsx -e "
  const {Jimp} = await import('./shared/feedSource/jimp.ts');
  const {WEBP_4X4} = await import('./shared/feedSource/test-helpers.ts');
  const image = await Jimp.read(WEBP_4X4);
  if (image.bitmap.width !== 4) throw new Error('unexpected width ' + image.bitmap.width);
  console.log('webp ok on', process.version, process.arch);
"
