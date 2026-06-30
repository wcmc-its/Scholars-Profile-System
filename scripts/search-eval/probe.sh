#!/usr/bin/env bash
# Ad-hoc diagnostic for ONE query: interpretation + top 15 + optional expected ranks.
#   ./probe.sh "<query>" ["Name1,Name2,..."]
#   HOST=https://scholars.weill.cornell.edu ./probe.sh "diabetes"   # point at prod
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
q="${1:?usage: probe.sh \"<query>\" [\"Name1,Name2\"]}"
expected_csv="${2:-}"

c="$(fetch_combined "$q")"
jq -r --arg q "$q" '.interpretation | "QUERY: \"\($q)\"\n  shape=\(.queryShape)  meshMapped=\(.meshMapped)  conf=\(.meshConfidence // "-")  concept=\(.conceptLabel // "-")  total=\(.total)"' <<<"$c"
echo "TOP 15  (rank score name pubs matched role evidence):"
jq -r '.hits[:15][] | "  #\(.rank)\t\(.relevanceScore|floor)\t\(.preferredName)\tpubs=\(.pubCount)\tmatched=\(.evidence.count // 0)\trole=\(.roleCategory // "?")\tev=\(.evidence.kind // "none")"' <<<"$c" \
  | column -t -s $'\t'

if [[ -n "$expected_csv" ]]; then
  IFS=',' read -r -a arr <<< "$expected_csv"
  e="$(printf '%s\n' "${arr[@]}" | jq -R . | jq -s .)"
  echo "EXPECTED:"
  jq --argjson e "$e" --arg q "$q" -f "$DIR/score_query.jq" <<<"$c" \
    | jq -r '.expected[] | "  \(.re): #\(.rank // "MISS")  \(.name // "")  (pubs=\(.pubs // "-"), matched=\(.matched // "-"))"'
fi
