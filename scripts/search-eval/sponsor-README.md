# Sponsor-match ranking eval (Phase 0)

The measurement harness for the sponsor-match ranker. Everything in the concept-ranking
spec Phase 1/2/3 and the Phase-2/3 design is scored against this — a ranking change is
only "better" if the scorecard says so.

Graded, not binary: sibling to the main search-eval (`eval.sh`/`score_query.jq`, which uses
MRR/top-k), but sponsor ranking is about **order quality across a judged pool**, so it scores
**nDCG@k** (top-heavy order quality) + **Spearman ρ** (rank correlation) + **coverage** (did the
ranker even return the judged people).

## Files

- `sponsor-fixtures.template.json` — the fill-in gold set. Copy to `sponsor-fixtures.json`, paste
  the real sponsor descriptions, hand-rank scholars with grades 0–3. This is the human input.
- `sponsor-score.jq` — pure scorer: one prompt's graded ideal vs the ranker's actual order.
- `sponsor-eval.sh` — orchestrator + `--selftest`.

## Workflow

```bash
./sponsor-eval.sh --selftest                              # verify the math (no infra, known answer)

# 1. Fill the fixtures
cp sponsor-fixtures.template.json sponsor-fixtures.json    # then edit: real pastes + graded ideal[]

# 2. Capture the ranker's output as run.json  { "<prompt id>": ["cwid", ...ranked...] }
#    (from the /edit/sponsor-match UI, a curl of the route, or a local run)

# 3. Score
ACTUAL=run.json ./sponsor-eval.sh sponsor-fixtures.json

# A/B a ranking change (e.g. flip SPONSOR_MATCH_CONCEPT_RANK):
ACTUAL=before.json ./sponsor-eval.sh > before.txt
ACTUAL=after.json  ./sponsor-eval.sh > after.txt
diff before.txt after.txt
```

Live-fetch mode (`--fetch`) POSTs each paste to `$HOST/api/edit/sponsor-match`. That route is
auth-gated (`/edit`, developer-only) — export `SPONSOR_COOKIE='<your dev session cookie>'` first.
Until the new-ranking flags flip on the target env, `--fetch` scores the *deployed* ranking, so the
capture-a-run.json path is the one to use for A/B across a flag change.

## Metrics

- **nDCG@k** — `Σ (2^grade - 1)/log2(rank+1)` over the top k, ÷ the ideal (grade-sorted) DCG.
  1.0 = perfect order; top positions dominate. `null` if no positive grades.
- **Spearman ρ** — rank correlation over the ideal ∩ actual set, re-ranked 1..n. `+1` perfect,
  `0` none, `-1` reversed. `null` if <2 common items. (Tie grades break by fixture order.)
- **coverage** — `found/n_ideal`: of the judged people, how many the ranker returned at all. Read
  this alongside nDCG — a great nDCG over a pool that's missing half the gold set is a mirage.

## Building the gold set (how the grades are produced)

The `ideal[]` grades are NOT hand-assigned and are NOT the MeSH tagged-count Scholars search
relevance already ranks on (grading on that is circular — the deployed ranker scored 0.95 against
a pure-MeSH gold). They come from an **evidence-grounded LLM judge + adversarial verify** that
blends signals INDEPENDENT of the ranker's mechanics:

1. `sponsor-candidates.sh "<concept>"` — surface a candidate pool from the public people-search
   (recall only; not the grade).
2. `sponsor-evidence.sh "<oa-topic>" <pool.json>` — assemble a per-candidate EVIDENCE BUNDLE:
   Scholars profile `overview` (human bio: role, program leadership) + title/dept, OpenAlex
   citation impact + OpenAlex topic classification + top-cited topical work titles (+ a
   name-collision flag), and the MeSH tagged-count as ONE cross-check signal.
3. `sponsor-judge.workflow.js` (Workflow) — per fixture, a judge grades every candidate 0–3 from
   the bundle, then an adversarial verifier tries to refute the 3s and confirm the 0s. Weighs
   human bio/role + publication substance + impact + focus; a focused junior specialist with few
   citations can still be a 3 (respects rarity); detects OpenAlex same-name collisions.
4. `sponsor-assemble.sh <wf-out.json> <pastes.json> <ev-dir>` — merge into `sponsor-fixtures.json`.

`sponsor-topics.json` is the topic spec (id, sponsor topic, pool query, OpenAlex term) driving the
above. Validated on the scleroderma known-truth set: the judge caught an OpenAlex name-collision
(a same-name cancer researcher) and a false positive (an orthopedist with incidental tagged pubs),
and rewarded a low-citation junior scleroderma specialist — all without leaning on the MeSH count.
`sponsor-grade.sh` (pure MeSH-count grader) is retained only as the circularity DIAGNOSTIC, not for
grading.

## Notes

- `K=<n>` overrides the nDCG cutoff (default 20). `JSON_OUT=out.json` also dumps machine-readable
  per-prompt results.
- The **filled** `sponsor-fixtures.json` carries cwids + relevance judgments about named people —
  same class of data as the committed `fixtures.json`. Keep it local until the judgments are
  reviewed; the template + scorer are safe to commit.
- Requires `bash`, `curl`, `jq` (same as the parent harness).
