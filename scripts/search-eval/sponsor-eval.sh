#!/usr/bin/env bash
# Sponsor-match ranking eval → a diffable graded scorecard (nDCG + rank-correlation).
# Sibling of eval.sh; graded because sponsor ranking is about ORDER QUALITY, not just "found".
#
#   ./sponsor-eval.sh --selftest                          # verify the scoring math (no infra)
#   ACTUAL=run.json ./sponsor-eval.sh sponsor-fixtures.json   # score a captured ranking
#   ./sponsor-eval.sh --fetch sponsor-fixtures.json       # POST each paste to the live route
#   JSON_OUT=out.json ACTUAL=run.json ./sponsor-eval.sh   # also dump machine-readable results
#
# ACTUAL file shape: { "<prompt id>": ["cwid1","cwid2", ...ranked...], ... }
# A/B workflow: capture run.json before vs after a ranking change, diff the two scorecards.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K="${K:-20}"

# --- self-check: known-answer scoring (ideal A=3,B=2,C=1 ; actual [A,C,B,X]) ------------
# By hand: nDCG@4 = 9.13093/9.39279 = 0.97212 ; Spearman(A,B,C swap B/C) = 0.5 ; coverage = 1.
if [[ "${1:-}" == "--selftest" ]]; then
  res="$(printf '["A","C","B","X"]' | jq -f "$DIR/sponsor-score.jq" \
        --argjson ideal '[{"cwid":"A","grade":3},{"cwid":"B","grade":2},{"cwid":"C","grade":1}]' \
        --argjson k 4 --arg id selftest)"
  if jq -e '(.ndcg_at_k - 0.97212 | fabs) < 1e-4
            and (.spearman - 0.5 | fabs) < 1e-9
            and .coverage == 1 and .found == 3' >/dev/null <<<"$res"; then
    echo "selftest PASS  $(jq -c '{ndcg_at_k, spearman, coverage}' <<<"$res")"
    exit 0
  else
    echo "selftest FAIL: $res" >&2
    exit 1
  fi
fi

MODE="file"
if [[ "${1:-}" == "--fetch" ]]; then MODE="fetch"; shift; fi
FIX="${1:-$DIR/sponsor-fixtures.json}"
[[ -f "$FIX" ]] || { echo "no fixtures at $FIX (copy sponsor-fixtures.template.json → sponsor-fixtures.json and fill it)" >&2; exit 1; }

if [[ "$MODE" == "fetch" ]]; then
  # shellcheck source=lib.sh
  source "$DIR/lib.sh"   # HOST
  # The sponsor route is auth-gated (/edit). Export SPONSOR_COOKIE='<your dev session cookie>'.
  fetch_actual() {  # $1 = paste  → JSON array of ranked cwids
    curl -4 -s -X POST "$HOST/api/edit/sponsor-match" -H 'content-type: application/json' \
      ${SPONSOR_COOKIE:+-H "cookie: $SPONSOR_COOKIE"} \
      --data "$(jq -n --arg d "$1" '{description:$d}')" \
    | jq -c '[.researchers[]?.cwid] // []'
  }
  echo "sponsor-eval @ ${HOST}  (live fetch)  fixtures=$(basename "$FIX")  k=$K"
else
  : "${ACTUAL:?set ACTUAL=<run.json> (map of prompt id → ranked cwid array), or pass --fetch}"
  [[ -f "$ACTUAL" ]] || { echo "ACTUAL file not found: $ACTUAL" >&2; exit 1; }
  echo "sponsor-eval  actual=$(basename "$ACTUAL")  fixtures=$(basename "$FIX")  k=$K"
fi
echo "(higher nDCG@$K = better order; Spearman ρ∈[-1,1]; coverage = judged people the ranker returned)"
echo

acc="[]"
while read -r prompt; do
  id="$(jq -r '.id' <<<"$prompt")"
  ideal="$(jq -c '.ideal' <<<"$prompt")"
  if [[ "$MODE" == "fetch" ]]; then
    actual="$(fetch_actual "$(jq -r '.paste' <<<"$prompt")")"
  else
    actual="$(jq -c --arg id "$id" '.[$id] // []' "$ACTUAL")"
  fi
  s="$(jq -f "$DIR/sponsor-score.jq" --argjson ideal "$ideal" --argjson k "$K" --arg id "$id" <<<"$actual")"
  jq -r '"── \(.id)   nDCG@\(.k)=\(if .ndcg_at_k == null then "n/a" else (.ndcg_at_k*1000|floor)/1000 end)   ρ=\(if .spearman == null then "n/a" else (.spearman*1000|floor)/1000 end)   coverage=\(.found)/\(.n_ideal)\(if (.missing|length)>0 then "   missing=\(.missing|join(","))" else "" end)"' <<<"$s"
  acc="$(jq -n --argjson a "$acc" --argjson s "$s" '$a + [$s]')"
done < <(jq -c '.prompts[]' "$FIX")

echo
echo "════════════════════════════════════════"
jq -r '
  [ .[] | select(.ndcg_at_k != null) ] as $nd
  | [ .[] | select(.spearman != null) ] as $sp
  | "OVERALL   meanNDCG=\(if ($nd|length)==0 then "n/a" else (([ $nd[].ndcg_at_k ]|add/($nd|length))*1000|floor)/1000 end)   meanρ=\(if ($sp|length)==0 then "n/a" else (([ $sp[].spearman ]|add/($sp|length))*1000|floor)/1000 end)   coverage=\([.[].found]|add)/\([.[].n_ideal]|add)"
' <<<"$acc"
if [[ -n "${JSON_OUT:-}" ]]; then echo "$acc" > "$JSON_OUT"; echo "wrote $JSON_OUT"; fi
