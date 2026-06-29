# Shared helpers for the scholar-search relevance harness. Source this; don't run it.
# Requires: bash, curl, jq. Run from the WCM network — the staging search API is
# public from WCM (no SSO), so no auth is needed.

HOST="${HOST:-https://scholars-staging.weill.cornell.edu}"
MAX_PAGES="${MAX_PAGES:-80}"   # 80 pages = top 1600 results; bump for deeper expected-rank checks

# fetch_combined "<query>"  → JSON {interpretation, hits:[<hit> + {rank}]} on stdout.
# Pages through all results (up to MAX_PAGES), dedupes by cwid, re-sorts by relevanceScore.
# We ALWAYS re-sort by score here, so page fetch order / shell glob order is irrelevant.
# (An earlier hand analysis was briefly fooled by an alphabetical `p10 < p2` glob — do not
#  trust raw page order anywhere; trust this sorted output. relevanceScore IS the sort key.)
fetch_combined() {
  local q enc total pages tmp p
  q="$1"
  enc="$(jq -rn --arg s "$q" '$s|@uri')"
  total="$(curl -4 -s "$HOST/api/search?type=people&q=$enc&_cb=$RANDOM" | jq '.total // 0')"
  pages=$(( (total + 19) / 20 ))
  (( pages > MAX_PAGES )) && pages=$MAX_PAGES
  (( pages < 1 )) && pages=1
  tmp="$(mktemp -d)"
  for (( p=0; p<pages; p++ )); do
    curl -4 -s "$HOST/api/search?type=people&q=$enc&page=$p&_cb=$RANDOM$p" -o "$tmp/p$p.json"
  done
  jq -s '
    { interpretation: ((.[0].searchInterpretation // {}) + {queryShape: .[0].queryShape, total: .[0].total}),
      hits: ( [ .[] | .hits[] ] | unique_by(.cwid) | sort_by(-.relevanceScore)
              | to_entries | map(.value + {rank: (.key + 1)}) ) }
  ' "$tmp"/p*.json
  rm -rf "$tmp"
}
