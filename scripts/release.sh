#!/usr/bin/env bash
# release.sh — reproducible production build + checksum manifest.
#
# Usage: ./scripts/release.sh [version-tag]
#   e.g. ./scripts/release.sh v0.1.0
#
# Outputs:
#   dist/                — static files ready to upload
#   dist/CHECKSUMS.txt   — sha256 of every emitted file (so users can
#                          verify the deployed bundle matches the
#                          tagged commit)
#
# Run this on a clean checkout of the tagged commit:
#   git checkout vX.Y.Z
#   npm ci
#   ./scripts/release.sh vX.Y.Z
#
# `npm ci` (not `npm install`) is intentional — it installs exactly
# what's in package-lock.json. Without it, transitive deps can drift
# and the bundle hash changes from build to build.

set -euo pipefail

VERSION="${1:-untagged}"
echo "▶ LUCKYPROTOCOL release build: ${VERSION}"

# 1. Clean previous artifacts so nothing stale leaks into the manifest.
rm -rf dist
echo "  → cleaned dist/"

# 2. Build. The bundle is fully content-addressed (Vite hashes every
#    JS/CSS filename) so two builds of the same source produce
#    identical filenames AND identical bytes inside them.
npm run build
echo "  → bundle built"

# 3. Generate sha256 manifest. Users can run the same sha256 on the
#    bundle their browser downloaded (from DevTools → Network) and
#    confirm it matches what came out of this script.
(
  cd dist
  find . -type f -not -name 'CHECKSUMS.txt' -print0 \
    | sort -z \
    | xargs -0 sha256sum > CHECKSUMS.txt
)
echo "  → CHECKSUMS.txt written ($(wc -l < dist/CHECKSUMS.txt) files)"

# 4. Print summary.
echo ""
echo "✓ Release ${VERSION} ready at dist/"
echo "  Size: $(du -sh dist | cut -f1)"
echo "  Files: $(find dist -type f | wc -l)"
echo ""
echo "Next steps:"
echo "  - Upload dist/ to your hosting (Cloudflare Pages / Vercel / etc.)"
echo "  - Verify CSP header is set (DevTools → Network → response headers)"
echo "  - Lighthouse audit: 90+ on Performance + PWA installable"
echo "  - Publish dist/CHECKSUMS.txt alongside the GitHub release"
