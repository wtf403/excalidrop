#!/bin/bash
# Zero-config publish: auto-detects repo from git remote, enables Pages via gh.
# Usage: ./scripts/publish-pages.sh  (or npx excalidrop publish)
set -euo pipefail
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${REPO_SLUG:-$(git -C "$PKG_DIR" config --get remote.origin.url | sed -E -e 's/\.git$//' -e 's#.*github.com[:/]##')}"
echo "Repo: $REPO"
WORK=$(mktemp -d)
trap "rm -rf $WORK" EXIT
npm --prefix "$PKG_DIR" run build:frontend >/dev/null
git clone --depth 1 --branch gh-pages "git@github.com:${REPO}.git" "$WORK" 2>/dev/null || { git init -b gh-pages "$WORK"; git -C "$WORK" remote add origin "git@github.com:${REPO}.git"; }
cp -r "$PKG_DIR/dist/frontend/"* "$WORK"/
cp "$PKG_DIR/canvas.excalidraw" "$WORK"/ 2>/dev/null || echo '{"type":"excalidraw","version":2,"elements":[]}' > "$WORK/canvas.excalidraw"
git -C "$WORK" add -A && git -C "$WORK" -c user.name=excalidrop -c user.email=excalidrop@local commit -m "excalidrop: publish viewer" --allow-empty && git -C "$WORK" push origin gh-pages --force
# Point Pages at the gh-pages branch (PUT works whether Pages is on or off)
CUR="$(gh api "repos/${REPO}/pages" --jq '.source.branch' 2>/dev/null || echo none)"
if [ "$CUR" = "none" ]; then
  gh api "repos/${REPO}/pages" -X POST -f build_type=legacy -f 'source[branch]=gh-pages' -f 'source[path]=/' >/dev/null
elif [ "$CUR" != "gh-pages" ]; then
  gh api "repos/${REPO}/pages" -X PUT -f build_type=legacy -f 'source[branch]=gh-pages' -f 'source[path]=/' >/dev/null
fi
echo "Pages: https://$(echo "$REPO" | tr '[:upper:]' '[:lower:]' | cut -d/ -f1).github.io/$(echo "$REPO" | cut -d/ -f2)/"
