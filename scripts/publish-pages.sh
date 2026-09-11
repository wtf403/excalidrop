#!/bin/bash
# Zero-config publish: auto-detects repo from git remote, enables Pages via gh.
# Usage: ./scripts/publish-pages.sh  (or npx excalidrop publish)
set -euo pipefail
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${REPO_SLUG:-$(git config --get remote.origin.url | sed -E -e 's/\.git$//' -e 's#.*github.com[:/]##')}"
echo "Repo: $REPO"
# CI support: GITHUB_TOKEN can't push cross-repo and CI has no SSH key, so
# when CANVAS_DEPLOY_TOKEN is present use an HTTPS remote (pass the same
# value as GH_TOKEN for the gh calls below). Local runs keep SSH as before.
if [ -n "${CANVAS_DEPLOY_TOKEN:-}" ]; then
  GIT_REMOTE="https://x-access-token:${CANVAS_DEPLOY_TOKEN}@github.com/${REPO}.git"
else
  GIT_REMOTE="git@github.com:${REPO}.git"
fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK" "${MAIN_WORK:-}"' EXIT
npm --prefix "$PKG_DIR" run build:frontend >/dev/null
git clone --depth 1 --branch excalidrop "${GIT_REMOTE}" "$WORK" 2>/dev/null || { git init -b excalidrop "$WORK"; git -C "$WORK" remote add origin "${GIT_REMOTE}"; }
# Drop stale build output (hashed asset names change every build) so the
# branch doesn't accumulate dead bundles. Scene + .git are preserved.
find "$WORK" -mindepth 1 -maxdepth 1 ! -name '.git' ! -name 'canvas.excalidraw' -exec rm -rf {} +
cp -r "$PKG_DIR/dist/frontend/"* "$WORK"/
# .nojekyll disables Jekyll so Pages serves the Vite SPA as-is.
touch "$WORK/.nojekyll"
# Never overwrite an existing scene: re-publishing must keep the canvas as-is.
# Only seed an empty scene when the branch doesn't have one yet.
if [ ! -f "$WORK/canvas.excalidraw" ]; then
  cp "$PKG_DIR/canvas.excalidraw" "$WORK"/ 2>/dev/null || echo '{"type":"excalidraw","version":2,"elements":[]}' > "$WORK/canvas.excalidraw"
fi
git -C "$WORK" add -A
# Never create empty commits: only commit when the viewer build or scene
# actually changed, so re-publishing doesn't spam the branch history.
if ! git -C "$WORK" diff --cached --quiet; then
  git -C "$WORK" -c user.name=excalidrop -c user.email=excalidrop@local commit -m "excalidrop: publish viewer" --quiet
  git -C "$WORK" push origin excalidrop
else
  echo "Viewer unchanged — nothing to commit."
fi
# Seed `main` on empty repos and keep it the default branch.
# Without this, excalidrop is the only branch and GitHub makes it the default.
# Never touch the default branch of repos that already have a `main`.
if ! gh api "repos/${REPO}/git/ref/heads/main" >/dev/null 2>&1; then
  SEED=$(mktemp -d)
  git init -b main "$SEED" >/dev/null
  # Empty commit only: main must exist so it stays the default branch,
  # but setup puts NO files there (no canvas, no README). The canvas
  # lives on excalidrop until the agent's first draw commits it.
  git -C "$SEED" -c user.name=excalidrop -c user.email=excalidrop@local commit --allow-empty -m "init main" --quiet
  git -C "$SEED" remote add origin "${GIT_REMOTE}"
  git -C "$SEED" push origin main >/dev/null
  rm -rf "$SEED"
  if [ "$(gh api "repos/${REPO}" --jq '.default_branch' 2>/dev/null)" != "main" ]; then
    gh api "repos/${REPO}" -X PATCH -f default_branch=main >/dev/null
  fi
fi
# Install the one-shot Actions deploy workflow onto the default branch.
# The viewer deploys ONCE via `workflow_dispatch`; scene autosync commits to
# the excalidrop branch never trigger it (the template has no push triggers
# by design — the viewer reads canvas.excalidraw from the git blob at runtime).
MAIN_WORK=$(mktemp -d)
git clone --depth 1 --branch main "${GIT_REMOTE}" "$MAIN_WORK" 2>/dev/null
mkdir -p "$MAIN_WORK/.github/workflows"
cp "$PKG_DIR/templates/excalidrop-canvas.yml" "$MAIN_WORK/.github/workflows/excalidrop-canvas.yml"
git -C "$MAIN_WORK" add -A
if ! git -C "$MAIN_WORK" diff --cached --quiet; then
  git -C "$MAIN_WORK" -c user.name=excalidrop -c user.email=excalidrop@local commit -m "excalidrop: one-shot canvas deploy workflow" --quiet
  git -C "$MAIN_WORK" push origin main
fi
# Switch Pages to Actions deploys (build_type=workflow). PUT works whether
# Pages is on or off; POST as fallback for brand-new sites.
gh api "repos/${REPO}/pages" -X PUT -f build_type=workflow >/dev/null 2>&1 \
  || gh api "repos/${REPO}/pages" -X POST -f build_type=workflow >/dev/null
# Trigger the one and only deploy (retry: GitHub needs a moment to register
# a freshly pushed workflow file).
for i in $(seq 1 12); do
  if gh workflow run excalidrop-canvas.yml --repo "$REPO" --ref main >/dev/null 2>&1; then
    break
  fi
  sleep 10
done
echo "Pages: https://$(echo "$REPO" | tr '[:upper:]' '[:lower:]' | cut -d/ -f1).github.io/$(echo "$REPO" | cut -d/ -f2)/"
