#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

BRANCH=${INDEX_BRANCH:-client-indexes}
REMOTE=${INDEX_REMOTE:-origin}
DEFAULT_WORKTREE="$(dirname "$PWD")/$(basename "$PWD")-client-indexes"
WORKTREE=${INDEX_WORKTREE:-$DEFAULT_WORKTREE}

BUILD=$(bun -e "console.log(require('./client/release.json').buildNumber)")
INDEX=assets/cache/index.html
[ -f "$INDEX" ] || { echo "missing $INDEX, run bun run generate:client first" >&2; exit 1; }
bun scripts/client-release.js --check >/dev/null

if ! git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
    [ -z "$(git status --porcelain --untracked-files=no)" ] || {
        echo "commit or stash the tracked changes first, the orphan checkout below deletes them from the worktree" >&2
        exit 1
    }
    PREVIOUS=$(git branch --show-current)
    git checkout --orphan "$BRANCH"
    git rm -rf . >/dev/null
    mkdir -p "$BUILD"
    cp "$INDEX" "$BUILD/index.html"
    git add "$BUILD/index.html"
    git commit -m "client index $BUILD"
    git push -u "$REMOTE" "$BRANCH"
    git checkout "$PREVIOUS"
    git worktree add "$WORKTREE" "$BRANCH"
    exit 0
fi

[ -d "$WORKTREE" ] || git worktree add "$WORKTREE" "$BRANCH"
mkdir -p "$WORKTREE/$BUILD"
cp "$INDEX" "$WORKTREE/$BUILD/index.html"
git -C "$WORKTREE" add "$BUILD/index.html"
if git -C "$WORKTREE" diff --cached --quiet; then
    echo "index for $BUILD is already published"
    exit 0
fi
git -C "$WORKTREE" commit -m "client index $BUILD"
git -C "$WORKTREE" push
