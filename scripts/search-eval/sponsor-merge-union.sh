#!/usr/bin/env bash
# Fold union-judged ranker-return candidates into the gold → a fair "union gold".
#   ./sponsor-merge-union.sh <union-out.json> <orig-fixtures.json> > sponsor-fixtures-union.json
# union-out.json : [{id, ideal:[{cwid,grade,confidence,rationale}]}]  (the ranker's own returns, judged)
# Each fixture's ideal[] becomes: original gold ∪ newly-judged ranker returns (deduped by cwid).
set -euo pipefail
UNION="${1:?union-out.json}"; ORIG="${2:?orig fixtures}"
jq -n --slurpfile orig "$ORIG" --slurpfile union "$UNION" '
  ($union[0] | map({ (.id): .ideal }) | add) as $u
  | $orig[0]
  | .prompts |= map(
      .id as $id
      | (.ideal | map(.cwid)) as $have
      | .ideal += [ ($u[$id] // [])[]
                    | select(.cwid as $c | ($have | index($c)) | not)
                    | { cwid, grade, note: ("UNION-JUDGE(\(.confidence // "?")): " + (.rationale // "")) } ]
    )
  | ._union_note = "FAIR-COMPARISON gold: original evidence-judged pool + the deployed ranker top-20 returns, judged by the same evidence pipeline. Scores a captured ranking without penalizing candidate-generation mismatch. LOCAL-ONLY."
'
