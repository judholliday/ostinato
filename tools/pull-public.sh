#!/bin/bash
# Brings work done in the public repo (pull requests from cloud sessions, edits on GitHub) into
# this repo as one commit. Run it before working here after such work, and always before
# tools/publish.sh, which refuses to publish over public changes it hasn't seen.
#
#   tools/pull-public.sh
#
# How: the public repo has its own history, made by publish.sh from this repo's commits minus the
# files it excludes. refs/published/<remote> (local) is the public commit last published or pulled;
# the changes from there to the public repo's newest commit are applied here (three-way, so edits
# made here since then are kept), committed, and the ref moves on.
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE=${PUBLISH_REMOTE:-github}
BRANCH=main
LAST=refs/published/$REMOTE

[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit your changes first, then pull."; exit 1; }
last=$(git rev-parse -q --verify "$LAST") || { echo "No $LAST yet: publish once with tools/publish.sh (or set it with git update-ref)."; exit 1; }
git fetch -q "$REMOTE" "$BRANCH"
head=$(git rev-parse FETCH_HEAD)
if [ "$head" = "$last" ]; then echo "Nothing new in $REMOTE/$BRANCH."; exit 0; fi
git merge-base --is-ancestor "$last" "$head" || { echo "$REMOTE/$BRANCH no longer contains $last (its history was rewritten); sort it out by hand."; exit 1; }

count=$(git rev-list --count "$last..$head")
log=$(git log --reverse --format='- %s (%an, %h)' "$last..$head")
patch=$(mktemp)
trap 'rm -f "$patch"' EXIT
git diff --binary "$last" "$head" > "$patch"
if [ ! -s "$patch" ]; then
  git update-ref "$LAST" "$head"
  echo "$REMOTE/$BRANCH moved on but changed no files; nothing to bring in."
  exit 0
fi
if ! git apply --3way --index "$patch"; then
  echo
  echo "Some public changes overlap with changes made here. Fix the files git marked, commit, then run:"
  echo "  git update-ref $LAST $head"
  exit 1
fi
git commit -q -m "Pulled $count commit$([ "$count" = 1 ] || echo s) from the public repo ($REMOTE/$BRANCH)" -m "$log"
git update-ref "$LAST" "$head"
echo "Pulled $count commit$([ "$count" = 1 ] || echo s) from $REMOTE/$BRANCH:"
echo "$log"
