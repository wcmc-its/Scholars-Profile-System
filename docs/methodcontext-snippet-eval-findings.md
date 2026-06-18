# Findings — #1119 method tool-usage _snippet_ calibration (lever decision)

**Companion to** `docs/methodcontext-snippet-eval-handoff.md`. This is the output of the
measurement/judgment phase that handoff asked for: judge many real (scholar, family,
exemplar-tool) snippets, **then decide which calibration levers to adopt before writing
more code**. Decision below; the adopted levers are **now implemented in the pure mappers
with unit tests** (see §6) and verified end-to-end on the live artifact.

## TL;DR — what to adopt

| Lever (handoff name)              | Decision                                                                                             | Why (from the data)                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#3 Opaque-tool gating**         | **ADOPT — primary lever**                                                                            | Gate snippet emission on tool **frequency**: surface only when `pub_count ≤ 4`. Retains **26/27 wins (96%)**, drops 38% of rows, lifts surviving win-rate **18% → 28%**. Addresses the dominant failure (61% of rows = "well-known name, snippet is one paper's result").                                                          |
| **#1 Clean-sentence filter**      | **REJECT as proposed**                                                                               | The cheap mechanical "starts mid-clause" heuristic is 45% precise and **would kill 14 of 27 wins for ~0 net precision**. A _perfect_ fragment detector would help (28%→38%, −2 wins) — so the value is real but the heuristic is the wrong tool. Demote to a best-of-N tie-breaker only; push true fix upstream (extraction span). |
| **#2 Subject-not-foil name-bias** | **ADOPT — low priority, as a selection refinement**                                                  | `namePosition` is a clean signal: wins have the tool name early (median 0.28), foils late (0.81). Use it to bias selection + guard foils. Foils are only 4% of rows, so low impact. The foil-cue regex alone is too sparse (33% precision).                                                                                        |
| **Dedupe**                        | **ADOPT — conservative**                                                                             | Collapse identical snippets _within_ a family's exemplar set / search blob; do **not** globally suppress a reused-but-good snippet (5 of 13 reused rows are wins). ~9% of rows.                                                                                                                                                    |
| **Display placement**             | **KEEP in the expandable disclosure** (label leads); do NOT promote onto the collapsed evidence line | Even after the opaque gate, surviving win-rate is only ~28% (≈72% non-win residue). The snippet should stay low-cost (revealed on expand), not front-and-center.                                                                                                                                                                   |

## 1. Method

- **Reconstruction (no DB writes):** `scripts/methodcontext-eval.ts` runs the **production pure
  mappers verbatim** (`buildToolContextIndex` → `selectBestSnippet` → `buildScholarFamilyWritesFromS3`)
  against the live, pinned artifact (`/tmp/tools.json` sha `aeb0a8f1…`, `/tmp/tool_context.json`
  sha `bbd212ed…`, v2026-06-13), then enriches each (scholar, family, exemplar-tool) snippet row
  with the mechanical signal behind each lever (salience tier, pub_count, source pmid, fragment-start,
  name-position, foil-cue, cross-family/exemplar reuse).
- **Population:** 22 scholars seeded from the method-like home "Try:" chips + the handoff's
  failure-mode cwids (`imh2003`/`mog4005`/`chm2042`), top-10 signature families per scholar →
  **445 snippet rows**.
- **Judgment:** a balanced **150-row sample** (50/50/50 across salience tiers S/A/B; 5 handoff
  anchors pinned) judged by a workflow of **two independent judges per row, blind to the mechanical
  flags**, with an **adversarial tiebreaker** on the 33 rows where they split. Inter-rater agreement
  on the pivotal call = **78%**. Mechanical flags were withheld so the judge verdicts are an unbiased
  ground truth to measure each lever against (join in `scripts/methodcontext-eval-analyze.mjs`).

**Baseline (today, no calibration):** of 150 judged rows — **win 27 (18%) / neutral 24 (16%) /
noise 99 (66%)**; the snippet "beats the plain tool name" in only **20%** of rows. Calibration is
warranted; the question was which levers and how aggressive.

## 2. Failure-mode distribution (judge)

| Failure mode                 | Share of rows | Addressed by                |
| ---------------------------- | ------------- | --------------------------- |
| `well_known_name_clear` (#1) | **61%**       | opaque-tool gating (#3)     |
| (clean win / fine)           | 19%           | —                           |
| `broken_fragment` (#2)       | 16%           | clean-sentence (but see §4) |
| `tool_is_foil` (#4)          | 4%            | name-position bias          |

The dominant problem by far is **#1** (the snippet is one paper's specific result for a method whose
name is already self-explanatory — `Wilcoxon signed-rank test`, `RNA-seq`, `online survey`). This is
what the opaque gate kills.

## 3. Lever #3 (opaque gating) — the primary lever

Value is driven by tool **frequency**, more cleanly than by salience tier alone:

| Cut                 | win%   | beatsName% |
| ------------------- | ------ | ---------- |
| `pub_count = 1`     | 25%    | 27%        |
| `pub_count 2–4`     | 34%    | 41%        |
| **`pub_count ≥ 5`** | **2%** | **2%**     |
| tier S              | 2%     | 2%         |
| tier A              | 34%    | 36%        |
| tier B              | 18%    | 22%        |

Candidate gate rules (retained wins / dropped rows / resulting precision):

| Gate                | rows kept | wins kept | wins dropped | surviving win% |
| ------------------- | --------- | --------- | ------------ | -------------- |
| none (today)        | 150       | 27/27     | 0            | 18%            |
| `tier ≠ S`          | 100       | 26/27     | 1            | 26%            |
| **`pub_count ≤ 4`** | **92**    | **26/27** | **1**        | **28%**        |
| `pub_count ≤ 2`     | 77        | 22/27     | 5            | 29%            |

**→ Recommended rule: emit a snippet only when `pub_count ≤ 4`** (equivalently: suppress for tier S
_or_ `pub_count ≥ 5`). It retains 96% of wins, drops the 2%-win high-frequency long tail, and is a
better signal than tier alone. `pub_count ≤ 2` is too aggressive (loses 5 wins for +1pt precision).
The one win the gate sacrifices is `Quantitative susceptibility mapping (QSM)` (tier S, pubN40) whose
snippet _is_ a real definition — an acceptable 1/27 loss.

> Note: #800 family-suppression already hides generic _families_, but does nothing for generic _tools_
> inside un-suppressed families. The tool-level frequency gate closes exactly that gap.

## 4. Lever #1 (clean-sentence) — why we reject the cheap version

- Mechanical `fragmentStart` (first char lowercase / continuation word) flags 41% of rows; judge
  "reads broken" is 25%. **Precision 45%, recall 76%.**
- **Collateral is fatal:** of the 62 fragmentStart-flagged rows, **13 are wins.** Layering a
  fragmentStart _drop_ on top of the opaque gate collapses wins **26 → 13 (kills 14)** while surviving
  win-rate barely moves (28% → 26%). Many great snippets legitimately begin mid-clause
  (`"central thalamic deep brain stimulation for the treatment of TBI using the Medtronic PC+S
first-in-human…"`).
- A **perfect** broken-fragment detector _would_ help: dropping the judge's true-broken rows lifts
  28% → **38%** at a cost of only 2 wins. So the value is real — the heuristic is just the wrong tool.

**→ Do not ship a sentence-boundary drop in the pure mapper.** Instead: (a) use clean-start only as a
best-of-N _tie-breaker_ (prefer a clean snippet, never drop a tool's only snippet for it); (b) raise
the real fix upstream — the snippets are extracted mid-sentence at the ReciterAI source, so a
sentence-aligned extraction span there is the high-leverage change (file against ReciterAI).

## 5. Levers #2/#4 (subject/foil) and dedupe — adopt, low priority

- **Name position** separates wins from foils cleanly (median 0.28 vs 0.81). Adopt as a preference in
  the `selectBestSnippet` name-bias pass + a "tool named late ⇒ likely foil/incidental" guard. The
  foil-cue regex alone is too sparse (4% of rows, 33% precision); name-position is the better signal.
- **Dedupe:** ~9% of rows reuse a snippet; mixed value (5 wins, 6 noise among 13). Collapse identical
  sentences within a family's exemplar set / the search blob; don't globally suppress a reused good
  snippet.

## 6. Implementation — what shipped (pure mappers, unit-tested, no DB)

All adopted levers landed in the pure, unit-tested mappers (`tool-context.ts`,
`scholar-tool-mapper-s3.ts`, `scholar-family-mapper-s3.ts`):

1. **DONE — opaque gate.** `selectBestSnippet` takes an optional `toolPubCount` and returns null when
   the tool's GLOBAL canonical `pub_count > MAX_PUB_COUNT_FOR_SNIPPET` (= 4). Both mappers plumb the
   canonical `pub_count` (id→count map in the family mapper; `rec.pub_count` in the tool mapper).
   Unknown count ⇒ no gate (conservative). Gates both `scholar_family.exemplar_contexts` and
   `scholar_tool.sample_context`.
2. **DONE — subject-not-foil guard.** Within the name-bias pass, prefer candidates that name the tool
   in the leading `EARLY_NAME_MAX_FRACTION` (= 0.75) of the sentence; bucket-prefer with fallback, so
   a tool's only snippet is never dropped.
3. **DONE — within-family dedupe.** `resolveExemplarContexts` collapses a later exemplar whose best
   snippet (normalized) duplicates an earlier sibling's. _(Cross-family / search-blob dedupe in
   `lib/search-index-docs.ts` deferred — ranking-only prose, low harm.)_
4. **DONE — clean-start tie-breaker.** `startsAtSentenceBoundary` breaks an exact length tie only;
   length stays primary, so descriptive mid-clause wins are preserved. No drop filter (the cheap
   heuristic would kill ~half the wins — §4).
5. **No change — display.** `lib/api/method-exemplar.ts` + `components/search/people-result-card.tsx`
   left as-is (snippet stays in the expandable disclosure).
6. **Filed upstream — ReciterAI#238** for sentence-aligned snippet extraction (the real fix for the
   residual ~16% broken fragments the mapper deliberately won't repair).

**Verification:** full SPS suite green (5225 tests / 426 files) + `tsc --noEmit` clean. End-to-end on
the live artifact, the gate took the home-chip population from **445 → 309 snippet rows** (−31%), with
**0** surviving rows at `pub_count > 4` and the tier-S noise collapsing **111 → 2** — while the
win-bearing A/B tiers were retained. Expected display win-rate among shown snippets ~18% → ~28% with
96% of true wins kept.

**Remaining (rollout, unchanged from `docs/tool-context-rollout.md`):** ETL backfill (re-populates the
gated columns) → reindex people → flip flags + `cdk deploy Sps-App-<env>` → soak → prod.

## 7. Caveats

- Rates are from a 150-row tier-balanced sample; population prevalences (fragmentStart 45%, foil 3%,
  reuse 9% across the 445-row top-10 set) are consistent with the full 1006-row top-50 set.
- Reconstruction surfaces families #800 would suppress in prod, so a few weak rows wouldn't actually
  reach search — i.e. the real-world baseline is marginally better than 18%, and the gate's benefit is
  if anything understated for un-suppressed generic tools.
- `tool_is_foil` judging is noisy at this volume (4%, 33% mechanical precision); treat the foil guard
  as best-effort.
- Reproduce: `npx tsx scripts/methodcontext-eval.ts` → `node scripts/methodcontext-eval-analyze.mjs`
  (after staging the workflow verdicts to `/tmp/methodcontext-eval-verdicts.json`).
