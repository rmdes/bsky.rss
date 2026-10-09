#!/bin/bash
# Bumps package.json's version and both tracked deployment compose files'
# image tags together, so they can never drift apart (the actual bug this
# script exists to make impossible, not just documented against).
#
# Usage: scripts/bump-version.sh <new-version>
#   e.g. scripts/bump-version.sh 2.13.2
#
# Does NOT touch CHANGELOG.md - write that entry by hand, it needs real
# content, not a mechanical copy.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/bump-version.sh <new-version>" >&2
  exit 1
fi

VERSION="$1"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: '$VERSION' doesn't look like a semver version (expected X.Y.Z)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

node -e "
  const fs = require('node:fs');
  const path = './package.json';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf-8'));
  pkg.version = '$VERSION';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"

for compose in deploy/fleet/docker-compose.yml deploy/canary/docker-compose.yml; do
  if [[ ! -f "$compose" ]]; then
    echo "Error: $compose not found" >&2
    exit 1
  fi
  sed -i.bak -E "s|ghcr\.io/rmdes/bsky\.rss:[0-9]+\.[0-9]+\.[0-9]+|ghcr.io/rmdes/bsky.rss:$VERSION|" "$compose"
  rm -f "$compose.bak"
done

echo "Bumped to $VERSION:"
echo "  package.json"
echo "  deploy/fleet/docker-compose.yml"
echo "  deploy/canary/docker-compose.yml"
echo ""
echo "Still needed: add a $VERSION entry to CHANGELOG.md, then review and commit."
