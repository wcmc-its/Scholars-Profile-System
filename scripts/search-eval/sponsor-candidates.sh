#!/usr/bin/env bash
# Surface a candidate pool for one concept from the PUBLIC staging people-search.
# Drafting aid for sponsor-fixtures.json — NOT a scorer. Output is a compact table
# of who staging returns for a term, with the evidence you grade from.
#
#   ./sponsor-candidates.sh "cancer metabolism"        # top ~30 (2 pages)
#   N=20 ./sponsor-candidates.sh "hereditary angioedema"
#   RAW=1 ./sponsor-candidates.sh "amyloidosis"        # dump full JSON hits instead
#
# ponytail: page 0-1 direct fetch, not lib.sh's 80-page fetch_combined (slow + one
# bad page aborts the whole sort). Top ~30 is plenty for a candidate pool.
set -euo pipefail
HOST="${HOST:-https://scholars-staging.weill.cornell.edu}"
N="${N:-30}"
q="${1:?usage: ./sponsor-candidates.sh \"<concept>\" }"
enc="$(jq -rn --arg s "$q" '$s|@uri')"

pages="$(for p in 0 1; do
  curl -4 -s --max-time 25 "$HOST/api/search?type=people&q=$enc&page=$p&_cb=$RANDOM$p"
done | jq -s '{ total: (.[0].total // 0),
                hits: ([ .[].hits[]? ] | unique_by(.cwid) | sort_by(-(.relevanceScore // 0)) ) }')"

if [[ "${RAW:-}" == "1" ]]; then echo "$pages"; exit 0; fi

jq -r --argjson n "$N" '
  "# candidates for: '"$q"'   (total=\(.total))",
  (.hits[:$n][] |
    [ .cwid,
      (.preferredName // "?"),
      "pub=\(.pubCount // 0) grant=\(.grantCount // 0)",
      (.primaryDepartment // .deptName // "?"),
      ((.humanizedAreas.labels // [])[:5] | join(", ")) ] | @tsv)
' <<<"$pages" | column -t -s$'\t'
