#!/usr/bin/env bash
# Run the gold fixture set → a diffable relevance scorecard. This is the A/B harness.
#   ./eval.sh [fixtures.json]
#   JSON_OUT=run.json ./eval.sh         # also dump machine-readable results
#   HOST=... MAX_PAGES=120 ./eval.sh    # point at prod / search deeper
#
# A/B workflow (rapid iteration):
#   ./eval.sh > before.txt
#   <deploy a ranking change to staging — see README>
#   ./eval.sh > after.txt
#   diff before.txt after.txt
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
FIX="${1:-$DIR/fixtures.json}"

echo "search-eval @ $HOST   fixtures=$(basename "$FIX")   maxPages=$MAX_PAGES"
echo "(higher MRR / top20 = better; rank = position among all results, MISS = beyond maxPages)"
echo
acc="[]"
while read -r row; do
  q="$(jq -r '.q' <<<"$row")"
  e="$(jq -c '.expected' <<<"$row")"
  c="$(fetch_combined "$q")"
  s="$(jq --argjson e "$e" --arg q "$q" -f "$DIR/score_query.jq" <<<"$c")"
  jq -r '"── \(.query)   meshMapped=\(.meshMapped)  conf=\(.confidence // "-")  total=\(.total)",
         "   found \(.summary.found)/\(.summary.n)   top10=\(.summary.top10)   top20=\(.summary.top20)   medianRank=\(.summary.medianRank // "-")   MRR=\((.summary.mrr*1000|floor)/1000)",
         (.expected[] | "     [\(.arch // "—")] \(.re): #\(.rank // "MISS")")' <<<"$s"
  echo
  acc="$(jq -n --argjson a "$acc" --argjson s "$s" '$a + [$s]')"
done < <(jq -c '.queries[]' "$FIX")

echo "════════════════════════════════════════"
jq -r '"OVERALL   meanMRR=\(([.[].summary.mrr]|add/length*1000|floor)/1000)   top20=\([.[].summary.top20]|add)/\([.[].summary.n]|add)   found=\([.[].summary.found]|add)/\([.[].summary.n]|add)"' <<<"$acc"
echo "── by archetype (data-derived labels; PENDING domain-expert review) ──"
jq -r '
  [ .[].expected[] | select(.arch != null) ] | group_by(.arch) | map({
     arch: .[0].arch, n: length,
     found:  ([ .[] | select(.rank) ] | length),
     top20:  ([ .[] | select(.rank != null and .rank <= 20) ] | length),
     medianRank: ([ .[] | select(.rank) | .rank ] | sort | if length == 0 then null else .[(length/2) | floor] end),
     mrr: ( ( ([ .[] | select(.rank) | (1 / .rank) ] | add) // 0 ) / length )
  }) | sort_by(.arch) | .[] |
  "   \(.arch)  found=\(.found)/\(.n)  top20=\(.top20)/\(.n)  medRank=\(.medianRank // "-")  MRR=\((.mrr*1000|floor)/1000)"
' <<<"$acc"
if [[ -n "${JSON_OUT:-}" ]]; then echo "$acc" > "$JSON_OUT"; echo "wrote $JSON_OUT"; fi
