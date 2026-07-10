#!/usr/bin/env bash
# Compare a fresh eval run against the checked-in baseline and FAIL (exit non-zero)
# on a threshold breach — so a relevance regression is a red diff, not a silent slip.
#
#   ./compare.sh [baseline.json] [fresh.json]
#     baseline.json  default: baselines/staging.json   (wrapped {meta,results} or a bare JSON_OUT array)
#     fresh.json     default: read a bare JSON_OUT array from stdin
#
# Typical use (post-deploy canary / nightly):
#   JSON_OUT=fresh.json ./eval.sh >/dev/null && ./compare.sh baselines/staging.json fresh.json
#   # or:  JSON_OUT=/dev/stdout ./eval.sh 2>/dev/null | ./compare.sh
#
# Thresholds (issue #1444; env-overridable so they can be tuned later):
#   MRR_DROP   (default 0.10) OVERALL meanMRR relative drop that fails.
#   ARCH_DROP  (default 0.20) any single-archetype MRR relative drop that fails.
#   Pinned top-anchors: a documented anchor scholar falling out of its max rank fails
#     (hard-coded PINS below — sourced from the audit docs / A/B cells).
#
# Accepts either the wrapped baseline ({meta, results:[...]}) or a bare JSON_OUT array
# for both inputs (`.results // .`), so `eval.sh`'s raw output compares directly.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BASE="${1:-$DIR/baselines/staging.json}"
FRESH="${2:-/dev/stdin}"
MRR_DROP="${MRR_DROP:-0.10}"
ARCH_DROP="${ARCH_DROP:-0.20}"

[[ -r "$BASE" ]] || { echo "compare: baseline not readable: $BASE" >&2; exit 2; }

# Pinned top-anchors: {q, cwid, maxRank, who}. A pin fails if the scholar is missing
# from the fresh run for that query or ranks worse than maxRank. Keep this list small and
# well-justified; every entry is a documented, stable #1–#3 anchor (see README + audit docs).
PINS='[
  {"q":"hypertension","cwid":"rbdevere","maxRank":3,"who":"Devereux (top-1 in all three 2026-07-02 A/B cells; issue #1444)"},
  {"q":"pediatric congenital heart surgery","cwid":"emb9016","maxRank":3,"who":"Bacha (analyst anchor; the #1344 multi-word regression victim)"}
]'

REPORT="$(jq -n \
  --slurpfile base "$BASE" \
  --slurpfile fresh "$FRESH" \
  --argjson pins "$PINS" \
  --argjson mrrDrop "$MRR_DROP" \
  --argjson archDrop "$ARCH_DROP" '
  def results($x): ($x[0] | if type=="object" then (.results // .) else . end);
  def mean_mrr($r): if ($r|length)==0 then 0 else ([ $r[].summary.mrr ] | add / ($r|length)) end;
  def arch_mrr($r):
    [ $r[].expected[] | select(.arch != null) ]
    | group_by(.arch)
    | map({ key: .[0].arch,
            value: ( ( ([ .[] | select(.rank) | (1 / .rank) ] | add) // 0 ) / length ) })
    | from_entries;
  def round3: (. * 1000 | floor) / 1000;

  (results($base)) as $b | (results($fresh)) as $f
  | (mean_mrr($b)) as $bm | (mean_mrr($f)) as $fm
  | (arch_mrr($b)) as $ba | (arch_mrr($f)) as $fa
  | {
      overall: {
        base: ($bm|round3), fresh: ($fm|round3),
        relDrop: (if $bm>0 then (($bm-$fm)/$bm) else 0 end | round3),
        breach: ($bm>0 and (($bm-$fm)/$bm) > $mrrDrop)
      },
      archetypes: [
        $ba | to_entries[] | .key as $k | .value as $bmr
        | ($fa[$k] // 0) as $fmr
        | {
            arch: $k, base: ($bmr|round3), fresh: ($fmr|round3),
            relDrop: (if $bmr>0 then (($bmr-$fmr)/$bmr) else 0 end | round3),
            breach: ($bmr>0 and (($bmr-$fmr)/$bmr) > $archDrop)
          }
      ],
      anchors: [
        $pins[] | .q as $q | .cwid as $c
        | ( [ $f[] | select(.query==$q) ][0] ) as $qr
        | ( if $qr == null then null
            else ( [ $qr.expected[] | select(.cwid==$c) ][0].rank ) end ) as $rank
        | {
            q: $q, who: .who, cwid: $c, maxRank: .maxRank, rank: $rank,
            breach: ($rank == null or $rank > .maxRank)
          }
      ]
    }
  | .breaches = ( [ .overall | select(.breach) ]
                + [ .archetypes[] | select(.breach) ]
                + [ .anchors[] | select(.breach) ] )
  | .pass = (.breaches | length == 0)
')"

# ---- human-readable report ----
echo "search-eval compare   baseline=$(basename "$BASE")   MRR_DROP=$MRR_DROP  ARCH_DROP=$ARCH_DROP"
jq -r '
  "OVERALL meanMRR  base=\(.overall.base)  fresh=\(.overall.fresh)  relDrop=\(.overall.relDrop)  \(if .overall.breach then "BREACH" else "ok" end)",
  "── archetypes (MRR base→fresh, relDrop) ──",
  (.archetypes[] | "   \(.arch)  \(.base)→\(.fresh)  relDrop=\(.relDrop)  \(if .breach then "BREACH" else "ok" end)"),
  "── pinned top-anchors ──",
  (.anchors[] | "   \(.q) → #\(.rank // "MISS") (max #\(.maxRank))  \(if .breach then "BREACH" else "ok" end)  — \(.who)"),
  "════════════════════════════════════════",
  (if .pass then "PASS — no threshold breach" else "FAIL — \(.breaches|length) breach(es)" end)
' <<<"$REPORT"

[[ "$(jq -r '.pass' <<<"$REPORT")" == "true" ]] || exit 1
