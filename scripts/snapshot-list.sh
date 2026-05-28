#!/bin/bash
# List background snapshots, newest first, with friendly times.
#
# Usage:
#   scripts/snapshot-list.sh            # list refs + when + 1-line stat vs HEAD
#   scripts/snapshot-list.sh <ref>      # show full diff of that snapshot vs HEAD

set -u
cd "$(dirname "$0")/.." || exit 1

if [ $# -ge 1 ]; then
  REF="$1"
  case "$REF" in
    refs/snapshots/*) ;;
    auto-*) REF="refs/snapshots/$REF" ;;
    *) REF="refs/snapshots/auto-$REF" ;;
  esac
  git diff HEAD "$REF"
  exit $?
fi

git for-each-ref --sort=-creatordate \
  --format='%(refname:short)|%(creatordate:relative)|%(objectname:short)' \
  refs/snapshots/ \
  | while IFS='|' read -r REF WHEN SHA; do
      STAT="$(git diff --shortstat HEAD "$REF" 2>/dev/null | sed 's/^ *//')"
      printf '%-32s  %-18s  %s  %s\n' "$REF" "$WHEN" "$SHA" "$STAT"
    done
