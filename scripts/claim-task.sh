#!/usr/bin/env bash
# Coordinate B-series claims via GitHub Issue labels.
# Used by Claude sessions per .planning/COORDINATION.md.
#
# Subcommands:
#   available                          list open B-series issues with no claim
#   claimed [<branch>]                 list claimed issues (optionally filter by branch)
#   claim <branch> <issue> [...]       add "claimed:<branch>" label
#   unclaim <branch> <issue> [...]     remove "claimed:<branch>" label
#   ship <branch> <issue> [...]        replace "claimed:<branch>" with "claimed-and-merged" (call after PR merges)

set -euo pipefail

usage() {
  sed -n '2,11p' "$0" | sed 's/^# //; s/^#//'
}

ensure_label() {
  local name="$1"
  if ! gh label list --limit 200 --json name --jq '.[].name' 2>/dev/null | grep -qx "$name"; then
    gh label create "$name" --description "Auto-created by claim-task.sh" >/dev/null
    echo "[label-created] $name" >&2
  fi
}

cmd="${1:-}"
shift || true

case "$cmd" in
  available)
    # Open issues whose title starts "BNN —" and have no claimed:* label.
    gh issue list --state open --limit 200 --json number,title,labels \
      --jq '.[] | select(.title | test("^B[0-9]+ "))
              | select(([.labels[].name] | any(. | startswith("claimed:"))) | not)
              | "\(.number)\t\(.title)"'
    ;;

  claimed)
    branch="${1:-}"
    if [ -n "$branch" ]; then
      gh issue list --state open --limit 200 --label "claimed:$branch" \
        --json number,title --jq '.[] | "\(.number)\t\(.title)"'
    else
      gh issue list --state open --limit 200 --json number,title,labels \
        --jq '.[] | select([.labels[].name] | any(. | startswith("claimed:")))
                | "\(.number)\t\([.labels[].name] | map(select(startswith("claimed:"))) | join(",") )\t\(.title)"'
    fi
    ;;

  claim)
    [ "$#" -lt 2 ] && { usage; exit 2; }
    branch="$1"; shift
    label="claimed:$branch"
    ensure_label "$label"
    for issue in "$@"; do
      gh issue edit "$issue" --add-label "$label" >/dev/null && \
        echo "[claim] #$issue  +$label" || \
        echo "[skip] #$issue already labeled $label" >&2
    done
    ;;

  unclaim)
    [ "$#" -lt 2 ] && { usage; exit 2; }
    branch="$1"; shift
    label="claimed:$branch"
    for issue in "$@"; do
      gh issue edit "$issue" --remove-label "$label" >/dev/null 2>&1 && \
        echo "[unclaim] #$issue  -$label" || \
        echo "[skip] #$issue had no $label" >&2
    done
    ;;

  ship)
    [ "$#" -lt 2 ] && { usage; exit 2; }
    branch="$1"; shift
    label="claimed:$branch"
    ensure_label "claimed-and-merged"
    for issue in "$@"; do
      gh issue edit "$issue" --remove-label "$label" --add-label "claimed-and-merged" >/dev/null 2>&1 && \
        echo "[ship] #$issue  -$label  +claimed-and-merged" || \
        echo "[partial] #$issue (check label state manually)" >&2
    done
    ;;

  ""|-h|--help|help)
    usage
    ;;

  *)
    echo "unknown subcommand: $cmd" >&2
    usage
    exit 2
    ;;
esac
