# Track B PLAN — authorship-expertise & clinical signal in the function_score

_Drafted 2026-06-30. Follow-on to `docs/search-author-rank-clinical-signal-handoff.md`, now
grounded by this session's empirical findings (`docs/search-trackA-clinical-inert-finding.md`,
the archetype gold-set baseline). **This is a plan for review — do not implement until approved.**_

## The reframe that drives this plan

The original handoff split the work into Track A (clinical, "cheap, do first") and Track B
(authorship restructure, "big"). The investigation collapsed that:

- **Buried specialists are buried by the `function_score` multipliers, not by text matching.**
  Igel's text score for "obesity" is fine (~29.75); his final score (248) is ~8× that from the
  concentration × prominence functions, and the docs ahead simply have higher multipliers.
- **Text-field levers can't fix a multiplier problem.** The clinical flag (a `cross_fields` text
  field) is inert (proven: zero movement, `^3` and `^5`). The matched-term/field-boost knobs are
  spent.
- **So every remaining lever lives in the `function_score`.** Track A and Track B converge there.

And the two buried archetypes need **two different** function_score additions:

| archetype | why buried | lever |
|---|---|---|
| **methods-scientist** (Mason: 468 pubs, 21% anchor, `#706`/MISS) | many topical pubs but all high-N middle-author → low authorship-weighted concentration | **(B) authorship-expertise concentration term** with a size guardrail |
| **clinician-expert** (Igel: 29 pubs, 21% anchor, no self-report) | few topical pubs; expertise is clinical, not bibliometric → low concentration *and* low prominence | **(C) clinical-as-function_score boost** (board-cert/specialty as a prominence-like multiplier) |

A single concentration term will **not** lift Igel — his publication concentration is genuinely
low. He needs (C). Mason needs (B). This is the central design decision: **two orthogonal
function_score components, one per archetype.**

## Current state (master `816c0a99`, what #1365 gave us)

- `getAreaScholarConcentration` (curated/Prisma path) and `getConceptScholarConcentration` (concept/OS
  path) compute a query-time `{cwid, total}` aggregate keyed on `authorPosition ∈ {first,last}` rows.
- That aggregate feeds `buildAreaBoostFunctions` → a **weak additive** `function_score` boost gated on
  `SEARCH_PEOPLE_AREA_BOOST`, weights `AREA_BOOST_W_HI/MID/LO = 3/1.5/0.75` (softened by #1365).
- **Proven low-leverage:** with the boost ON, Igel is still `#183`. The boost is a minor additive nudge,
  not a re-ranking term.
- The archetype gold-set harness (`scripts/search-eval/`, per-archetype scorecard) is in place for A/B.

## Design principles (carried from the handoff, now grounded)

1. **Query-tunable, no-reindex.** The concentration is computed query-time (DB/OS), so the *formula*
   (position weights, `1/√N`, floor/cap, rank-discount, blend weight) must be **env-var tunable** —
   A/B cells become task-def re-registers, not reindexes. (The index-time `AUTHORSHIP_WEIGHTS` term-
   repetition is NOT the lever here and stays put; this is the strongest reason to work in the
   function_score, not the index.)
2. **Discrete, explainable tiers** (faculty-facing) and **first == last** (splitting penalizes
   early-career first-authors; not a clear win).
3. **Generalize authorship credit to 10/4/1** (firstOrLast/secondOrPenultimate/middle), applied
   consistently — replacing the boost's binary first/last-only carve.
4. **`1/√N` size normalization** on non-anchor bands (`total_authors`, 100% populated, avg 9.4, max
   5154); anchors exempt (leading a 120-author trial is a feature). **The floor/cap (~12) is the real
   decision** because of the heavy N-tail. The size term reaches the **penultimate** band too
   (positional meaning decays with N).
5. **Methods-scientist guardrail (NON-OPTIONAL):** key the methods fallback off *positional
   concentration*, not size-normalized credit — a methods scientist is a high-N middle author, so
   `1/√N` (within-paper) + a rank-discounted sum (across-paper) would **double-suppress** them. Keep
   the two axes orthogonal: rank-discounted sum = "many relevant papers"; size/position = "within-paper
   credit."
6. **Drop co-anchor handling** — no `EqualContrib` data exists (pure byline position). Separate ETL
   enrichment, not a blocker.
7. **Unify the three credit schemes** — rollup (10/4/1), concentration boost (first/last-only),
   `publicationMeshUi` (binary) — into one. This restructure is the clean moment.

## Proposed phases (each A/B'd against the archetype gold set before the next)

**B0 — make the concentration term query-tunable (no formula change yet).**
Lift `AREA_BOOST_W_*` and the position/size parameters into env vars; thread them through
`getAreaScholarConcentration` / `getConceptScholarConcentration` / `buildAreaBoostFunctions`. Ship
behind the existing `SEARCH_PEOPLE_AREA_BOOST` flag. Deliverable: A/B cells need no reindex. Cheap;
unblocks everything.

**B1 — promote concentration from additive nudge to first-class term + `1/√N` + floor/cap.**
Rework the formula: per-(scholar, topic) credit = `positionWeight(10/4/1) × sizeNorm(1/√N, capped)`,
summed with a rank-discount across the scholar's topical pubs; fold into the `function_score` with
enough weight to actually re-rank (the #1365 softening proved the current weight is too low to move
buried specialists). **Target: Mason-type methods-scientists rise; research-pis don't regress; the
guardrail keeps high-N middles from double-suppression.** Tune the floor/cap + blend weight via B0's
env knobs against the gold set.

**B2 — clinical-as-function_score boost (the clinician-expert lever; replaces the inert Track A).**
Add a *separate* `function_score` function: when the query resolves to a clinical specialty/board-cert
that a scholar holds (`clinicalSpecialties`/`clinicalBoardSet` exact membership), apply a
prominence-like multiplier — **not** a `cross_fields` text field (proven inert). Flag-gated; tuned so a
board-certified specialist with thin publications (Igel) clears the generalist pool without distorting
publication-driven queries. **Target: Igel/Aras rise on obesity; no regression on research/method
queries.**

**B3 — unify the three authorship-credit schemes** into the single 10/4/1×sizeNorm model, so a
scholar ranks consistently across surfaces. Cleanup/correctness; no new lever.

## A/B methodology (already built)

- `scripts/search-eval/eval.sh` with the archetype-tagged `fixtures.json` → per-archetype scorecard
  (clinician-expert / research-pi / methods-scientist medRank + MRR). Baseline captured this session.
- **Staging A/B must NOT `cdk deploy` a master-based stack** — staging currently runs `feat/1366`'s
  cdk and a deploy would strip `SEARCH_EVIDENCE_REASON_COUNTS` / `SEARCH_PEOPLE_CONCENTRATION`. Use the
  **non-destructive in-VPC probe** pattern (call `searchPeople` in-VPC, toggle the env knobs in-process)
  — it faithfully measures the formula delta with zero deploy. Validate probe-off against the public-API
  baseline first.
- Success = buried clinician-experts (B2) AND methods-scientists (B1) rise into a useful band, with
  research-pi unchanged and the guardrail holding (methods-scientists not double-suppressed by `1/√N`).

## Open decisions (need your call before/while implementing)

1. **Floor/cap for `1/√N`** — what cap (~12?) given the 5154-author tail? Drives B1.
2. **B1 vs B2 ordering** — methods (B1, bigger) or clinician (B2, smaller, closes the Track A gap) first?
3. **Clinical-boost magnitude (B2)** — how hard should a board cert outrank publication evidence? (The
   inert finding says text-field `^N` can't do it; a function_score multiplier can be tuned freely —
   what's the ceiling so it doesn't over-promote thin-publication clinicians on research queries?)
4. **Concentration blend weight (B1)** — how strong relative to prominence + base text, given #1365's
   softening showed "too weak to re-rank"?
5. **Gold-set labels** — domain-review the data-derived archetype labels (esp. the `clinician-but-high-N`
   physician-scientists: Horn/Scherl/Lukin/James Lo) before trusting per-archetype A/B deltas.

## Dependencies / out of scope

- **meshMapped lay-term gap** (`docs/search-meshmapped-layterm-gap-finding.md`) — separate (#1258); but
  note `diabetes`/`alzheimer's` can't be A/B'd here until their aliases load (keyword fallback dominates).
- **`EqualContrib` ETL enrichment** (co-first/co-last credit) — separate upstream PubMed work; B1's
  position model under-credits genuine shared leadership until then.
- No index/reindex changes in B0–B2 (the whole point); B3 may touch the rollup for scheme unification.
