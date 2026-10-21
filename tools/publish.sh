#!/bin/bash
# Publishes the app to GitHub with its own, separate history: each run adds one commit there,
# built from this repo's latest commit minus the files below. This repo's own history never
# leaves the Mac (its old commits contain the user's sounds, from before data/ was split out).
#
#   tools/publish.sh ["commit message"]     (default message: the latest commit's subject)
#
# Work can also happen in the public repo itself (cloud sessions, pull requests). That work must be
# brought here with tools/pull-public.sh before publishing again, or publishing would replace it
# with this repo's version: so this script remembers the public commit it last published or pulled
# (the local ref refs/published/<remote>) and refuses while the public repo has moved on from it.
#
# Needs a git remote called "github" (or set PUBLISH_REMOTE) pointing at the GitHub repository.
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE=${PUBLISH_REMOTE:-github}
BRANCH=main
LAST=refs/published/$REMOTE

# Not ours to share: Korg's factory banks and MIDI spec (users download them from Korg), the
# Minimoog Sound Charts transcription (Tom Rhea's permission covers personal use only), and the
# Juno-106 patch data (from a GPL project; this repo is MIT).
EXCLUDE=(
  presets/MKXL_FactoryPreset.mkxl_all
  presets/MK_FactoryPreset.mkxl_all
  presets/MS2K_FactoryPreset.mkxl_all
  presets/MS2KB_FactoryPreset.mkxl_all
  docs/microKORG_XL_MIDIimp.txt
  presets/Minimoog_Charts.syx
  tools/minimoog/charts.json
  tools/minimoog/report.md
  presets/Juno106_Factory.syx
  tools/juno/juno106-factory.json
  tools/juno/report-106.md
)

[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit your changes first, then publish."; exit 1; }

# The published tree: HEAD minus the excluded files, built in a scratch index (nothing checked out changes).
export GIT_INDEX_FILE
GIT_INDEX_FILE=$(mktemp -u)
trap 'rm -f "${GIT_INDEX_FILE:-}"' EXIT
git read-tree HEAD
git rm --cached -q --ignore-unmatch -- "${EXCLUDE[@]}"
tree=$(git write-tree)
rm -f "$GIT_INDEX_FILE"
unset GIT_INDEX_FILE

parent=
if git fetch -q "$REMOTE" "$BRANCH" 2>/dev/null; then parent=$(git rev-parse FETCH_HEAD); fi
if [ -n "$parent" ]; then
  last=$(git rev-parse -q --verify "$LAST" || true)
  if [ -z "$last" ]; then
    echo "This repo doesn't know which public commit it last published. If $REMOTE/$BRANCH has nothing"
    echo "that isn't here yet, record it with:  git update-ref $LAST $parent"
    exit 1
  fi
  if [ "$parent" != "$last" ]; then
    echo "$REMOTE/$BRANCH has changes that aren't here yet:"
    git log --format='  %h %s (%an)' "$last..$parent" 2>/dev/null || echo "  (its history no longer contains $last)"
    echo "Bring them in first with tools/pull-public.sh, then publish."
    exit 1
  fi
fi
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "GitHub is already up to date."
  exit 0
fi

msg=${1:-$(git log -1 --format=%B HEAD)}
commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "$msg")
git push "$REMOTE" "$commit:refs/heads/$BRANCH"
git update-ref "$LAST" "$commit"
echo "Published $(git rev-parse --short "$commit") to $REMOTE/$BRANCH."
