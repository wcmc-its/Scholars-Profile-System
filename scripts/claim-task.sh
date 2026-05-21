#!/usr/bin/env bash
# Coordinate B-series claims via GitHub Issue labels.
# Used by Claude sessions per .planning/COORDINATION.md.
#
# Subcommands:
#   status                             live picker view — joins COORDINATION.md rows with gh state
#   available                          open B-series issues with no claim
#   claimed [<branch>]                 list claimed issues (optionally filter by branch)
#   claim <branch> <issue> [...]       add "claimed:<branch>" label
#   unclaim <branch> <issue> [...]     remove "claimed:<branch>" label
#   ship --pr <pr-num> <branch> <issue> [...]   replace "claimed:<branch>" with "claimed-and-merged" (requires PR merged)
#   drift                              flag inconsistencies (claim with no PR, etc.)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
COORD_FILE="$REPO_ROOT/.planning/COORDINATION.md"

usage() {
  sed -n '2,13p' "$0" | sed 's/^# //; s/^#//'
}

ensure_label() {
  local name="$1"
  if ! gh label list --limit 200 --json name --jq '.[].name' 2>/dev/null | grep -qx "$name"; then
    gh label create "$name" --description "Auto-created by claim-task.sh" >/dev/null
    echo "[label-created] $name" >&2
  fi
}

# ---------------------------------------------------------------------------
# State-derivation helpers (used by `status` and `drift`).
# ---------------------------------------------------------------------------

# Emit TSV (b_id<TAB>issues<TAB>deps<TAB>branch<TAB>title) for every row in
# the "## Open tasks" section of COORDINATION.md. Issues + deps are
# comma-separated. Empty cells become "-".
parse_coord_rows() {
  [ -f "$COORD_FILE" ] || { echo "missing $COORD_FILE" >&2; return 1; }
  awk '
    BEGIN { FS = "[ \t]*\\|[ \t]*"; in_section = 0; header_seen = 0 }
    /^## Open tasks/ { in_section = 1; next }
    /^## / && in_section { in_section = 0 }
    !in_section { next }
    /^\|---/ { header_seen = 1; next }
    /^\|/ {
      if (!header_seen) next        # the column header row
      # $1 is empty (leading |), real cells start at $2
      b_id   = $2
      issues = $3
      title  = $4
      effort = $5
      deps   = $6
      branch = $7
      # normalize
      gsub(/[ \t]+$/, "", b_id)
      gsub(/[ \t]+$/, "", issues)
      gsub(/[ \t]+$/, "", deps)
      gsub(/[ \t]+$/, "", branch)
      gsub(/[ \t]+$/, "", title)
      if (b_id == "") next
      # extract just the issue numbers (drop leading #)
      n = split(issues, parts, /[ ,]+/)
      out_issues = ""
      for (i = 1; i <= n; i++) {
        if (parts[i] ~ /^#?[0-9]+$/) {
          gsub(/^#/, "", parts[i])
          out_issues = (out_issues == "" ? parts[i] : out_issues "," parts[i])
        }
      }
      if (out_issues == "") out_issues = "-"
      # branch: backticks already stripped by the FS, but trim
      gsub(/`/, "", branch)
      if (branch == "" || branch == "—") branch = "-"
      if (deps  == "" || deps  == "none") deps = "-"
      print b_id "\t" out_issues "\t" deps "\t" branch "\t" title
    }
  ' "$COORD_FILE"
}

# Output: number<TAB>state<TAB>labels (one line per open OR recently-touched B-issue)
fetch_issue_state_index() {
  gh issue list --state all --limit 200 --json number,state,labels --jq \
    '.[] | "\(.number)\t\(.state)\t\([.labels[].name] | join(","))"'
}

# Output: branch<TAB>pr_number<TAB>pr_state
fetch_branch_pr_index() {
  gh pr list --state all --limit 100 --json number,state,headRefName --jq \
    '.[] | "\(.headRefName)\t\(.number)\t\(.state)"'
}

# ---------------------------------------------------------------------------

cmd="${1:-}"
shift || true

case "$cmd" in
  status)
    # Live picker view. Joins COORDINATION.md rows with gh state.
    ISSUE_IDX=$(fetch_issue_state_index)
    BRANCH_IDX=$(fetch_branch_pr_index)

    # Pass 1: per-row state ignoring deps.
    declare -a STATES
    declare -a BIDS
    declare -a BRANCHES
    declare -a DEPS
    declare -a DETAILS
    declare -a TITLES
    while IFS=$'\t' read -r b_id issues deps branch title; do
      state="?"
      detail=""

      # Dormant marker in title (matches "P2 —" or "P3 —")
      if echo "$title" | grep -qE 'P[23] —'; then
        state="DORMANT"
        detail=$(echo "$title" | grep -oE 'P[23] — [^*|]+' | head -1)
      fi

      # Resolve issue states
      issue_all_closed=true
      issue_any_claimed=false
      issue_any_claim_label=""
      if [ "$issues" != "-" ]; then
        for n in $(echo "$issues" | tr ',' ' '); do
          line=$(echo "$ISSUE_IDX" | awk -v n="$n" -F'\t' '$1 == n')
          if [ -z "$line" ]; then continue; fi
          st=$(echo "$line" | cut -f2)
          labels=$(echo "$line" | cut -f3)
          if [ "$st" != "CLOSED" ]; then issue_all_closed=false; fi
          claim_lab=$(echo "$labels" | tr ',' '\n' | grep '^claimed:' | head -1 || true)
          if [ -n "$claim_lab" ]; then
            issue_any_claimed=true
            issue_any_claim_label="$claim_lab"
          fi
        done
      else
        issue_all_closed=false
      fi

      # Resolve PR state for this row's branch
      pr_line=""
      if [ "$branch" != "-" ]; then
        pr_line=$(echo "$BRANCH_IDX" | awk -v b="$branch" -F'\t' '$1 == b' | head -1)
      fi
      pr_state=""; pr_num=""
      if [ -n "$pr_line" ]; then
        pr_num=$(echo "$pr_line" | cut -f2)
        pr_state=$(echo "$pr_line" | cut -f3)
      fi

      # Decide state (skip if already DORMANT)
      if [ "$state" = "?" ]; then
        if [ "$issue_all_closed" = "true" ]; then
          state="MERGED"
        elif [ -n "$pr_state" ] && [ "$pr_state" = "OPEN" ]; then
          state="IN-REVIEW"; detail="PR #$pr_num open"
        elif [ "$issue_any_claimed" = "true" ]; then
          state="CLAIMED"; detail="label $issue_any_claim_label"
        else
          state="TBD"  # filled in by dep resolution
        fi
      fi

      STATES+=("$state")
      BIDS+=("$b_id")
      BRANCHES+=("$branch")
      DEPS+=("$deps")
      DETAILS+=("$detail")
      TITLES+=("$title")
    done < <(parse_coord_rows)

    # Pass 2: resolve TBD rows by checking deps.
    for i in "${!STATES[@]}"; do
      if [ "${STATES[$i]}" != "TBD" ]; then continue; fi
      blocked_reason=""
      claimable=true
      dep_text="${DEPS[$i]}"
      # Split deps on common/and
      IFS=',' read -ra dep_list <<< "$dep_text"
      for dep_raw in "${dep_list[@]}"; do
        dep=$(echo "$dep_raw" | sed -E 's/^ +//; s/ +$//; s/ \(.*//')
        if [ "$dep" = "-" ] || [ "$dep" = "none" ]; then continue; fi
        # Is it a known B-id?
        found=false
        for j in "${!BIDS[@]}"; do
          if [ "${BIDS[$j]}" = "$dep" ]; then
            found=true
            dep_state="${STATES[$j]}"
            if [ "$dep_state" != "MERGED" ]; then
              claimable=false
              blocked_reason="dep $dep is $dep_state"
            fi
            break
          fi
        done
        if [ "$found" = "false" ]; then
          # External dep (e.g., "PR #409 merge" or "WCM ITS IdP response")
          claimable=false
          blocked_reason="external: $dep_raw"
        fi
      done
      if [ "$claimable" = "true" ]; then
        STATES[$i]="CLAIMABLE"
        DETAILS[$i]=""
      else
        STATES[$i]="BLOCKED"
        DETAILS[$i]="$blocked_reason"
      fi
    done

    # Print
    printf "%-20s  %-40s  %-12s  %s\n" "B-id" "Branch" "State" "Detail"
    printf "%-20s  %-40s  %-12s  %s\n" "----" "------" "-----" "------"
    for i in "${!STATES[@]}"; do
      printf "%-20s  %-40s  %-12s  %s\n" \
        "${BIDS[$i]}" "${BRANCHES[$i]}" "${STATES[$i]}" "${DETAILS[$i]}"
    done
    ;;

  available)
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
    # Usage: ship --pr <pr-num> <branch> <issue> [<issue> ...]
    # Refuses to swap labels unless the PR is verified MERGED.
    if [ "${1:-}" != "--pr" ]; then
      echo "ship now requires --pr <pr-num> as proof the work merged" >&2
      echo "Usage: $0 ship --pr <pr-num> <branch> <issue> [...]" >&2
      exit 2
    fi
    shift
    pr="$1"; shift
    [ "$#" -lt 2 ] && { usage; exit 2; }
    branch="$1"; shift
    # Verify PR state
    pr_state=$(gh pr view "$pr" --json state --jq .state)
    if [ "$pr_state" != "MERGED" ]; then
      echo "[refuse] PR #$pr state is $pr_state, not MERGED — labels untouched" >&2
      exit 1
    fi
    label="claimed:$branch"
    ensure_label "claimed-and-merged"
    for issue in "$@"; do
      gh issue edit "$issue" --remove-label "$label" --add-label "claimed-and-merged" >/dev/null 2>&1 && \
        echo "[ship] #$issue  -$label  +claimed-and-merged  (PR #$pr verified MERGED)" || \
        echo "[partial] #$issue (check label state manually)" >&2
    done
    ;;

  drift)
    # Flag inconsistencies the picker would otherwise trip on.
    ISSUE_IDX=$(fetch_issue_state_index)
    BRANCH_IDX=$(fetch_branch_pr_index)
    EXIT=0

    echo "=== Issues with claimed:<branch> label but no open PR for that branch ==="
    while IFS=$'\t' read -r num st labels; do
      claim_lab=$(echo "$labels" | tr ',' '\n' | grep '^claimed:' | head -1 || true)
      [ -z "$claim_lab" ] && continue
      branch="${claim_lab#claimed:}"
      pr_line=$(echo "$BRANCH_IDX" | awk -v b="$branch" -F'\t' '$1 == b && $3 == "OPEN"' | head -1)
      if [ -z "$pr_line" ]; then
        echo "  #$num has $claim_lab but no OPEN PR for $branch"
        EXIT=1
      fi
    done <<< "$ISSUE_IDX"

    echo ""
    echo "=== Issues with claimed-and-merged label whose linked PR is still open ==="
    # Iterate claimed-and-merged issues; check if PR body referenced an open PR
    while IFS=$'\t' read -r num st labels; do
      echo "$labels" | tr ',' '\n' | grep -qx 'claimed-and-merged' || continue
      # Find any PR that closes this issue and is currently OPEN
      open_prs=$(gh pr list --state open --search "linked:issue closes:#$num" --json number 2>/dev/null --jq '.[].number' || true)
      # Fallback: check via gh api for cross-referenced PRs
      if [ -z "$open_prs" ]; then
        open_prs=$(gh issue view "$num" --json closedByPullRequestsReferences --jq '.closedByPullRequestsReferences[] | select(.state == "OPEN") | .number' 2>/dev/null || true)
      fi
      if [ -n "$open_prs" ]; then
        echo "  #$num has claimed-and-merged but linked PR(s) still OPEN: $open_prs"
        EXIT=1
      fi
    done <<< "$ISSUE_IDX"

    echo ""
    echo "=== COORDINATION.md rows referencing branches with no PR and no claim label ==="
    while IFS=$'\t' read -r b_id issues deps branch title; do
      [ "$branch" = "-" ] && continue
      pr_line=$(echo "$BRANCH_IDX" | awk -v b="$branch" -F'\t' '$1 == b' | head -1)
      has_pr=false; [ -n "$pr_line" ] && has_pr=true
      has_claim=false
      if [ "$issues" != "-" ]; then
        for n in $(echo "$issues" | tr ',' ' '); do
          line=$(echo "$ISSUE_IDX" | awk -v n="$n" -F'\t' '$1 == n')
          [ -z "$line" ] && continue
          if echo "$line" | cut -f3 | tr ',' '\n' | grep -q "^claimed:$branch$"; then
            has_claim=true
          fi
        done
      fi
      if [ "$has_pr" = "false" ] && [ "$has_claim" = "false" ]; then
        # Not necessarily drift — branch may not exist yet. Informational only.
        :
      fi
    done < <(parse_coord_rows)

    if [ "$EXIT" -eq 0 ]; then
      echo ""
      echo "No drift detected."
    fi
    exit "$EXIT"
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
