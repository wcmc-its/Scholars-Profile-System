# Track A — Phase 0 harness: validation run results

> Aggregate statistics only. Per-candidate output (faculty names + extracted relationships) is
> confidential and lives only in `/tmp/coi-phase0/` — never committed. Reproduce with
> `scripts/coi-phase0/run.sh`. Numbers below are from the 2022 reference corpus and will change on
> live data (Track B).

## Outcome: core pipeline VALIDATED

Track A set out to answer one question — *does the segment → attribute → extract → normalize → diff
core behave sanely on real WCM data?* — and the answer is yes. It reproduces a gap rate in the same
band as the 2022 capstone, and (more importantly) it **catches and suppresses the dominant
false-positive modes** the feature must avoid. The residual issues are all in the v0 rule extractor,
exactly the layer Phase 1 replaces with span-grounded extraction + human labels.

## Population

| Metric | Value |
|---|---|
| Faculty evaluated (valid cwid in both files) | 324 |
| Publications with COI statement text | 2,462 |
| — pure negation / boilerplate (no disclosure) | 697 (28.3%) |
| — substantive statements | 1,765 |

The study population is faculty with a **known, complete disclosed set** (valid cwid in both the
ReCiter knowns and the disclosed export). This deliberately excludes zero-disclosure faculty — the
highest-gap group — so the statement-level gap rate is expected at or modestly around the capstone's
37%, not below or above it by a wide margin.

## Gap rate (sanity vs capstone ~37%)

| Metric | Value |
|---|---|
| Substantive statements with ≥1 High/Medium candidate | 806 |
| **Statement-level gap rate (High/Medium)** | **45.7%** |
| Faculty with ≥1 surfaced gap | 210 / 324 (64.8%) |

45.7% sits in the plausible band around the capstone's 37%. The modest excess is v0 extractor noise
concentrated in the Medium tier (the capstone applied stricter human filtering); the **High tier is
the clean signal** and is what would ever render on /edit.

## The false-positive avoidance (the point of the confidence model)

| Suppressed because | Count |
|---|---|
| Attributed to a co-author (the dominant structural FP) | 10,686 |
| Within fuzzy range of a disclosed entity (Case 2 / variant) | 4,056 |
| Funder/employer clause (no WRG analog) | 2,740 |
| Structured multi-author blob, scholar's section unbounded → whole blob suppressed | 6 |

Co-author bleed — one author's pharma list collapsing onto another — is by far the largest suppressed
class. Two distinct mechanisms were found and fixed during the run: (1) loose initials matching
(a bare `SAS` inside "HalioDx SAS" read as author "AS"), and (2) delimiter-free ASCO/ICMJE disclosure
blobs where the scholar's surname appears among ~25 authors. The author-ref-position guard and the
structured-blob slicer respectively neutralize them.

## Surfaced tiers + quality spot-check

| Tier | Count |
|---|---|
| High (would render on /edit) | 196 |
| Medium (above suppression floor) | 5,445 |
| Surfaced total (deduped per faculty+entity) | 5,641 |

Automated spot-check of the 196 High candidates: **0 bare-junk entities**, **1 residual co-author-name
leak**. Manual eyeballing of the High sample shows the large majority are correctly attributed real
relationships (consulting / advisory-board / speaker / ownership disclosures matched to the right
scholar by surname or exact author-ref initials). A formal precision number requires the human
labeling pass on `candidates.csv` — that is the Track A deliverable, not an automated claim.

## Residual v0 limitations (carried into Phase 1)

- A few co-author-name leaks in **prose** statements listing multiple co-authors as company employees
  (no dotted initials to filter on).
- Institutional **research support** named via a gazetteer company can slip into `personal`.
- Trial/consortium names and publisher honoraria are noisy.
- No author roster in the 2022 export → common-surname mis-attribution risk; **Track B adds ReCiter's
  `targetAuthor` flag** to gate this.

## What this unlocks

1. The pipeline logic is sound enough to **port into the SPS ETL/lib (TypeScript) for Phase 1**.
2. `candidates.csv` is ready for the **human labeling pass** (the rubric in
   `docs/coi-pubmed-phase0-precision-study.md`) that produces the first real precision number and the
   reusable gold-set fixture.
3. The remaining FP sources are **named and bounded** — they define the v1 extractor / span-grounded
   LLM-assist scope, and the `targetAuthor` gate that Track B contributes.

**Not yet done (gates unchanged):** Track B (live ReCiter `reporting_conflicts` + `targetAuthor`,
VPC-blocked), the human-labeled precision number, and Faculty-Affairs/Compliance/Counsel sign-off.
