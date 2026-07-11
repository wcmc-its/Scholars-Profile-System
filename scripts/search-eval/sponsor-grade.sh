#!/usr/bin/env bash
# Evidence-anchored auto-grader for sponsor-match gold fixtures.
# Turns "who's an expert on TOPIC" into a REPRODUCIBLE grade from an EXTERNAL signal —
# the MeSH-tagged publication counts the staging people-search already exposes
# (evidenceLines: "N of M publications tagged <descriptor>"). This is PubMed ground
# truth, independent of how the sponsor-match ranker orders people, so grading on it
# is not circular. Replaces subjective 0-3 calls with an auditable rule.
#
#   ./sponsor-grade.sh "systemic sclerosis"                       # one descriptor
#   ./sponsor-grade.sh "leukemia" "lymphoma" "multiple myeloma"   # concept = MAX across descriptors
#   TOP=12 ./sponsor-grade.sh "HIV infections"
#
# Per candidate the ANCHOR = MAX tagged-count across the queried descriptors (never a
# SUM → never double-counts a pub → redundant phrasing can't inflate a grade). Grades
# are RELATIVE to the topic's own leader (ratio-to-top), so a rare-area expert with a
# modest absolute count still lands at 3 — rarity handled by construction.
#
# GRADE RULE (documented, tunable at the top):
#   r = anchor / topAnchor(pool)      focus = anchor / pubCount
#   0  anchor < FLOOR            (in the lexical pool but ~no topic pubs → false positive)
#   3  r >= T3                   (name-first depth on this topic)
#   2  r >= T2
#   1  otherwise (tagged, marginal)
#   focus >= FOCUS_HI bumps a 2→3 (a specialist whose corpus IS this topic)
#
# CEILING (ponytail): tagged-count ≈ but ≠ merit — a prolific middle-author can out-count
# a domain PI. v1 uses `focus` as a partial guard; add PubMed senior-authorship/citation
# weighting only if validation against the human-approved set shows count+focus mis-orders.
# MeSH also lags new pubs ~months and misses non-PubMed venues (weak for method/CS topics).
set -euo pipefail
HOST="${HOST:-https://scholars-staging.weill.cornell.edu}"
FLOOR="${FLOOR:-3}"        # anchor (tagged pubs) below this = grade 0 (lexical/incidental match)
R3="${R3:-0.25}"          # ratio-to-leader for grade 3 (rarity: relative, not absolute)
R2="${R2:-0.10}"          # ratio-to-leader for grade 2
FOCUS3="${FOCUS3:-0.15}"  # tagged/pubCount gate for 3 — a real expert's corpus IS the topic
FOCUS2="${FOCUS2:-0.08}"  # focus gate for 2 (below this, a big count is incidental → capped at 1)
[[ $# -ge 1 ]] || { echo "usage: ./sponsor-grade.sh \"<descriptor>\" [\"<descriptor>\" ...]" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
i=0
for term in "$@"; do
  enc="$(jq -rn --arg s "$term" '$s|@uri')"
  for p in 0 1; do
    curl -4 -s --max-time 25 "$HOST/api/search?type=people&q=$enc&page=$p&_cb=$RANDOM$p" > "$tmp/t${i}p${p}.json"
  done
  i=$((i+1))
done

# Merge every hit across every term; per cwid keep MAX tagged-count (dedup-safe anchor).
jq -s --argjson floor "$FLOOR" \
      --argjson r3 "$R3" --argjson r2 "$R2" --argjson f3 "$FOCUS3" --argjson f2 "$FOCUS2" '
  def tagged: ([ .evidenceLines[]? | select(.kind=="publications") | .count ] | max) // 0;

  [ .[].hits[]? ]
  | group_by(.cwid)
  | map( (max_by(.evidenceLines // [] | ([.[]|select(.kind=="publications")|.count]|max) // 0)) as $b
         | { cwid: $b.cwid, name: $b.preferredName, pub: ($b.pubCount // 0),
             anchor: ([ .[] | tagged ] | max),
             descr:  ([ $b.evidenceLines[]? | select(.kind=="publications") | .term ] | first) } )
  | map(.focus = (if .pub>0 then (.anchor/.pub) else 0 end))
  | (map(.anchor) | max | if . <= 0 then 1 else . end) as $topA
  | map(.r = (.anchor/$topA))
  # focus-GATED, ratio-to-leader bands: depth (r) AND focus both required for a high grade.
  | map(.grade =
        (if .anchor < $floor then 0
         elif .focus >= $f3 and .r >= $r3 then 3
         elif .focus >= $f2 and .r >= $r2 then 2
         else 1 end))
  | sort_by(-.grade, -.anchor)
  # top-heavy but graded shape; cap per grade so no fixture floods one tier
  | ( [ .[] | select(.grade==3) ][:8]
    + [ .[] | select(.grade==2) ][:6]
    + [ .[] | select(.grade==1) ][:4]
    + [ .[] | select(.anchor < $floor) | .grade=0 ][:3] )
  | { _topAnchor: $topA, _n: length,
      ideal: map({ cwid, grade,
        note: "AUTO: \(.name) — \(.anchor)/\(.pub) tagged \(.descr // "?") (focus \((.focus*100|floor))%, r=\((.r*100|floor))%) → \(.grade)" }) }
' "$tmp"/*.json
