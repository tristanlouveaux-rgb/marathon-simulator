#!/bin/bash
# Background snapshot of the working tree.
# Writes a commit object to refs/snapshots/auto-<ts> without touching the real
# index or working tree. Safe to run while edits are happening.
#
# Recovery: see CLAUDE.md -> "Background snapshots".

set -u

REPO="/Users/tristanlouveaux/Documents/marathon-simulator"
cd "$REPO" || exit 0

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LOG_DIR="$REPO/.git/snapshots"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/snapshot.log"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

# Skip if working tree is clean (tracked + untracked).
if git diff --quiet HEAD 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0
fi

# Build the snapshot in a temp index so the real .git/index is untouched.
TMP_INDEX="$(mktemp "$LOG_DIR/idx.XXXXXX")"
trap 'rm -f "$TMP_INDEX"' EXIT

if [ -f .git/index ]; then
  cp .git/index "$TMP_INDEX"
else
  GIT_INDEX_FILE="$TMP_INDEX" git read-tree HEAD 2>/dev/null || true
fi

export GIT_INDEX_FILE="$TMP_INDEX"

# Stage everything respecting .gitignore. -A picks up modifications, additions, deletions.
git add -A 2>/dev/null || { log "git add failed"; exit 0; }

TREE="$(git write-tree 2>/dev/null)"
[ -z "$TREE" ] && { log "write-tree failed"; exit 0; }

PARENT="$(git rev-parse HEAD 2>/dev/null)"
TS="$(date -u +%Y%m%d-%H%M%S)"
MSG="auto-snapshot $TS on $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"

if [ -n "$PARENT" ]; then
  COMMIT="$(echo "$MSG" | git commit-tree "$TREE" -p "$PARENT" 2>/dev/null)"
else
  COMMIT="$(echo "$MSG" | git commit-tree "$TREE" 2>/dev/null)"
fi

[ -z "$COMMIT" ] && { log "commit-tree failed"; exit 0; }

unset GIT_INDEX_FILE

git update-ref "refs/snapshots/auto-$TS" "$COMMIT" && log "saved refs/snapshots/auto-$TS ($COMMIT)"

# Prune: keep the 24 newest; delete anything older than 7 days beyond that.
NOW="$(date +%s)"
KEEP=24
MAX_AGE=$((7 * 24 * 60 * 60))

i=0
git for-each-ref --sort=-creatordate --format='%(refname) %(creatordate:unix)' refs/snapshots/ 2>/dev/null \
  | while read -r REF REFTS; do
      i=$((i + 1))
      AGE=$((NOW - REFTS))
      if [ $i -gt $KEEP ] && [ $AGE -gt $MAX_AGE ]; then
        git update-ref -d "$REF" && log "pruned $REF"
      fi
    done

# Keep the log from growing unbounded.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 5000 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
