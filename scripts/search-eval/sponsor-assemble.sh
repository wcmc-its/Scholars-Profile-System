#!/usr/bin/env bash
# Assemble sponsor-fixtures.json from the judge/verify workflow output + draft pastes.
#   ./sponsor-assemble.sh <workflow-out.json> <pastes.json> <evidence-dir> > sponsor-fixtures.json
# workflow-out.json : [{id, topic, ideal:[{cwid,grade,confidence,rationale}]}]
# pastes.json       : { "<id>": {paste, notes} }
# evidence-dir      : dir with ev-<id>.json (for scholar names)
set -euo pipefail
WF="${1:?workflow-out.json}"; PASTES="${2:?pastes.json}"; EVDIR="${3:?evidence dir}"

# name lookup per fixture from evidence bundles
names_for() { jq -c 'map({(.cwid): .name}) | add' "$EVDIR/ev-$1.json" 2>/dev/null || echo '{}'; }

prompts="[]"
while read -r fx; do
  id="$(jq -r '.id' <<<"$fx")"
  topic="$(jq -r '.topic' <<<"$fx")"
  paste="$(jq -r --arg id "$id" '.[$id].paste // "DRAFT sponsor text — replace."' "$PASTES")"
  notes="$(jq -r --arg id "$id" '.[$id].notes // ""' "$PASTES")"
  names="$(names_for "$id")"
  ideal="$(jq -c --argjson names "$names" '
    .ideal
    | sort_by(-.grade)
    | map({ cwid,
            grade,
            note: ("JUDGE(\(.confidence // "?")): " + (.rationale // "")),
            name: ($names[.cwid] // null) })' <<<"$fx")"
  p="$(jq -n --arg id "$id" --arg paste "$paste" --arg topic "$topic" --arg notes "$notes" --argjson ideal "$ideal" \
        '{id:$id, paste:$paste, topic:$topic, notes:$notes, ideal:$ideal}')"
  prompts="$(jq -n --argjson a "$prompts" --argjson p "$p" '$a + [$p]')"
done < <(jq -c '.[]' "$WF")

jq -n --argjson prompts "$prompts" '{
  _note: "GOLD fixtures for sponsor-match ranking eval (Phase 0). Per prompt: a sponsor description (paste) + the TOPIC it maps to + a hand-graded-by-EVIDENCE ideal[] of scholars. Scored by sponsor-eval.sh (nDCG + Spearman + coverage).",
  _grades: "3 = name-first expert, work centers on the topic. 2 = strong, on-topic. 1 = marginal/tangential. 0 = FALSE POSITIVE (matches words, wrong domain).",
  _method: "Grades produced by the evidence-grounded judge + adversarial verify (sponsor-judge.workflow.js), NOT by MeSH count (which Scholars search relevance already uses — grading on it would be circular). Each grade blends human bio/role + publication substance (OpenAlex topical works) + citation impact + topical focus, with MeSH tagged-count as one cross-check. Validated on the scleroderma known-truth set (caught an OpenAlex name-collision + a false positive; rewarded a low-citation junior specialist). Reproduce: ./sponsor-evidence.sh then the workflow; see sponsor-README.md.",
  _probes: "RARITY → rarity-scleroderma, rarity2-cystic-fibrosis, als. REDUNDANT-PHRASING → heme-malignancy. METHOD-NOT-DISEASE → ml-in-medicine, single-cell-genomics. OVER-BROAD → cardiovascular-broad. ACRONYM/AMBIGUOUS → multiple-sclerosis (MS), als (ALS).",
  _status: "Grades are AUTO from the evidence judge — spot-check the low-confidence ones and any note flagging an OpenAlex name-collision. `paste` texts are realistic DRAFT placeholders; swap in real sponsor descriptions. LOCAL-ONLY (named-person judgments) — never commit.",
  _how_to_run: "ACTUAL=run.json ./sponsor-eval.sh sponsor-fixtures.json  (run.json = {\"<id>\":[\"cwid\",...ranked...]}). Self-check: ./sponsor-eval.sh --selftest.",
  prompts: $prompts
}'
