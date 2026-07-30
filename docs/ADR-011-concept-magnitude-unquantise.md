# docs/ADR-011 — Unquantise the concept magnitude the system already computes

**Status:** Proposed
**Date:** 2026-07-31
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

[`search-relevance-contract.md`](./search-relevance-contract.md) rule **O8** states that a term which orders by evidence must be sensitive to how much evidence there is. Every query-derived ordering term in the people body fails it — they are presence tests, and the only continuously-varying term in the prominence sum is `ln1p(publicationCount)`, career output with no relation to the query.

The obvious reading of that is "the system has no concept magnitude, so one must be built and indexed." **That reading is wrong, and this ADR exists because two days of work were spent proving it wrong the expensive way.**

### The magnitude already exists, is already live in prod, and is already correct

`getConceptScholarConcentration` (`lib/api/search.ts:1604`) computes, per candidate, at query time, from two publications-index aggregations over `meshDescriptorUi ∩ wcmAuthorCwids` — **both fields already indexed, no reindex** — a real per-scholar magnitude:

```
concentration = n² / total          # count × on-topic fraction
```

`SEARCH_PEOPLE_CONCEPT_ARM_FIRST` is `"on"` unconditionally (`cdk/lib/app-stack.ts:1816`, prod flipped 2026-07-30), so this is what production runs today.

`buildAreaBoostFunctions` (`lib/api/search.ts:1506`) then emits it into the outer prominence `function_score` as **additive per-cwid clauses** — `{ filter: { terms: { cwid: [...] } }, weight: w }` — after quantising it: three fraction-of-max bands by default, or `AREA_BOOST_GRADED_BANDS` graded steps under `SEARCH_PEOPLE_AREA_BOOST_GRADED`. Either way the weight is bounded by `AREA_BOOST_W_HI`, whose default is **3**.

So the pipeline is complete end to end. The magnitude is computed over the right corpus, keyed on the resolved descriptor, attached to the right scholars, and delivered additively into the score — and then flattened into a weight that cannot exceed 3, in a sum where the unbounded volume prior spans 2.01×. O8's register row already said it: *"Computed over the right corpus at query time, discarded one step before use."*

**The quantity is right. The cap is the defect.**

Sorting a captured panel by the shipped `n²/total` reproduces a magnitude ordering's top 3 exactly on a disease query (318, 248, 226 tagged publications). Nothing needed to be built to get that number; it is what production already calculates and then throws away.

### What was measured

`SEARCH_AREA_BOOST_W_HI` is on the `?flags=` allowlist (#2085), so the sweep is curls against one process, one index, one second. Prod flag parity pinned on every capture; **`total` held identical to baseline on all 70 captures (7 weights × 10 queries) — reorder-only, admission untouched.**

Median tagged-publication count across the top 10:

| query | W=3 (today) | W=6 | W=12 | **W=20** | W=40 | W=80 |
|---|---|---|---|---|---|---|
| lung cancer | 27 | 187 | 187 | **187** | 187 | 187 |
| cancer | 32 | 32 | 32 | **168** | 174 | 174 |
| diabetes | 54 | 54 | 54 | **57** | 57 | 57 |
| aging | 8 | 8 | 11 | **11** | 14 | 14 |
| functional mri | 20 | 20 | 40 | **110** | 149 | 149 |
| gene therapy / gene therapies | 31 | 31 | 31 | **31** | 31 | 31 |
| crispr | 0 | 0 | 0 | **0** | 0 | 0 |
| longevity | 1 | 1 | 1 | **1** | 1 | 1 |
| flow cytometry | 1 | 2 | 2 | **2** | 2 | 3 |

**W_HI = 20 is the knee.** Past it the only material movement is `functional mri` climbing further, and on that query climbing is the damage.

On the headline disease query, raising one weight moves the top of the page from a scholar with 13 of 339 publications tagged (3.8%) to a page where nine of ten carry 60 or more — and it reaches scholars who were **not in the fetched 20 at all**, because this is a scoring change and not a reordering. The rank-15 and rank-11 scholars a page-1 experiment could surface are joined by several it structurally could not.

Judged on the 10-query acceptance panel, predictions recorded before the arm was read, one blind judge per query: **6 BETTER, 1 MILD_BETTER, 2 NEUTRAL, 1 WORSE, and no control damaged.** The page-1 `rank_features` proxy scored 7/1/2 but **damaged a control**; this arm does not.

The mechanism behind that difference is the strongest argument in this ADR. Where descriptor coverage is thin, the concentration score never leaves its lowest band and the page returns **rank-for-rank identical** — a page sort acts on ties at any scale, a scaled scoring band does not fire below a floor. **The coverage floor is emergent here and absent from the `rank_features` design**, which would have to reimplement it as an explicit gate whose statistic that field type cannot even compute.

### Why this ADR does not propose `rank_features`

The first draft of this ADR proposed remapping `meshSubtreeCounts` from `{ type: "object", enabled: false }` to `rank_features` and reindexing. An adversarial review killed it on four independent counts, all verified against the tree:

1. **`rank_feature` is a query clause and cannot be a `function_score` function.** Prominence is `function_score { functions, score_mode: "sum", boost_mode: "multiply" }` (`lib/api/search.ts:3200`); a `functions` entry is `weight` / `field_value_factor` / `script_score` / `random_score` / decay. The proposal's central sentence — "added to the prominence sum" — was not implementable. Placing it in `baseQuery` instead makes the volume prior a **multiplier on the term meant to counter it**.
2. **`rank_features` supports neither aggregation nor sorting**, so the proposed coverage floor (max and non-zero count across the candidate set) had no computable source.
3. The proposed resolution gate keyed on `meshConfidence == "entry-term"`. Measured: **6 of the 10 panel queries are `entry-term`, including every query the design wins on**, and `gene therapy` / `gene therapies` split `entry-term` / `partial` on the *same descriptor*. The gate would have suppressed the magnitude precisely where it works, and split the standing O1 regression pair. No value in the payload distinguishes a parent hop from a legitimate synonym.
4. The method-routing gate read a count off `matchReason`, which carries none on any variant (`lib/api/search.ts:408-411`).

Beyond being unbuildable as specified, it was unnecessary: the additive per-cwid vehicle it was reinventing **already exists, already ships, and is already request-scoped for A/B**.

## Decision

**Do not fund a `rank_features` reindex for concept counts.** Raise the ceiling on the magnitude the system already computes, and stop quantising it. Sequence as independently landable blocks.

### B0 — Evidence population (no reindex, no flag, ships first)

`evidenceLines[kind == "publications"]` carries a `strength` discriminator with **three** values (`lib/api/result-evidence.ts:129`): `tagged` (MeSH descriptor), `mention` (free-text keyword), and `concept` (the MeSH-expansion text variant, which carries **no `count`**). Within one hit they are mutually exclusive — the `mention` line is emitted only when nothing else fired — so the hazard is not a sum within a scholar but a **column assembled across candidates**, mixing MeSH counts from some scholars with keyword counts from others.

Measured: reading the column by `kind` ranked a cardiac electrophysiologist first for a lifespan query on six *device-battery*-longevity mentions. Only the two thinnest-coverage panel queries mix the strengths, which is exactly where the damage is largest.

Filter to `strength == "tagged"`; treat `concept`-strength hits as **unknown**, never as zero. Contract rule **O9**.

### B1 — Raise and grade the concept weight

`SEARCH_PEOPLE_AREA_BOOST_GRADED` on, `SEARCH_AREA_BOOST_W_HI` at the measured knee. Both are already flags and both are already on the `?flags=` allowlist, so this is a task-def change and a `cdk deploy` — **no reindex, no ETL change, no new field, no new code path**.

⚠ `SEARCH_PEOPLE_AREA_BOOST_GRADED` is currently `on` in staging and `off` in prod, and was previously recorded as "worse alone, do not promote". That verdict stands **at `W_HI = 3`** and is now explained: grading a magnitude into a range the ceiling has already collapsed changes the ordering within bands that are all worth about the same. The two flags are one change and must ship together; neither is safe to promote alone.

### B2 — Recency, and only recency, needs new indexed data

The one failure magnitude cannot fix is temporal. A control's top row under every arm is a scholar whose entire tagged evidence is from 1982–1989, and **publication years are not in the API payload at all**, so no reading of the page can detect it. This is the sole justification for touching the index:

| field | source | why |
|---|---|---|
| `meshSubtreeLatestYear` | same ETL loop as `meshSubtreeCounts`, `max(year)` instead of `count` | concept-scoped recency; nothing else in the system carries it |

Scholar-global `mostRecentPubDate` is **not** a substitute: the failing scholars publish recently, just not on the queried concept.

Consumption is deliberately left open. It may not need `rank_features` either — `getConceptScholarConcentration` already makes two aggregation round trips, and a `max(year)` sub-aggregation on the existing on-topic agg would deliver it query-time with no reindex at all. **Measure that before mapping anything.**

### B3 — The volume cap, only after B1 is judged

#2068's `SEARCH_PEOPLE_PUBCOUNT_DAMPEN=capped` ships **with** B1, never before. Career volume is currently an accidental proxy for topical evidence; capping it alone removes the proxy without supplying the signal, and on two of ten panel queries it demoted the highest-evidence scholar on the page.

### B4 — Reconcile the displayed numbers

Once the ranked quantity is the concept count, the displayed number and the ranked number converge by construction, which is the durable fix for the Layer 3 register.

## Consequences

### Accepted

- **Two flag flips and a `cdk deploy`.** No reindex, no ETL change, no index-size cost, no dark field a future reindex must carry.
- **A weight that is tuned, not derived.** `W_HI = 20` comes from a knee in a 7-point sweep over 10 queries. It is a number chosen by measurement, and it will need re-measuring when anything else in the prominence sum moves (O5).

### Not resolved, and stated plainly

- **Mis-resolution is amplified, not caused, and this ADR does not fix it.** On the one technique query that resolves to its parent modality, raising the weight makes the page *worse than the baseline*: summed on-concept method evidence in the top 10 falls **39 → 10**, every promoted scholar has a method count of **0** for the thing asked about, and the three scholars with 14, 10 and 4 publications of it are all evicted. This is **#2088**, upstream of everything here.

  The gate this needs is **not** `meshConfidence`. Measured: the winning disease query and the losing technique query are *both* `entry-term` with `alsoParent: true`. The discriminator is whether **`conceptLabel` is strictly broader than the query string** — `lung cancer` → `Lung Neoplasms` (descendants all ⊆ the query) and `gene therapy` → `Genetic Therapy` (a synonym) versus `functional mri` → `Magnetic Resonance Imaging` (a strict superset; there is no fMRI descriptor in MeSH at all). That test is computable from the payload before ranking and is the one gate B1 should carry.

- 🔴 **`Neoplasms` descendant expansion is truncated to C04.557 (by histologic type) and omits C04.588 (by site).** Grepping a captured broad-disease query for Breast / Lung / Prostatic / Colorectal Neoplasms, Melanoma, Carcinoma\*, Glioma returns zero, so that query is haematology-biased *by construction* — a scholar with 318 publications tagged, demonstrably present on the narrower query, is absent from the broad query's candidate set entirely. This is upstream of all ranking work, it is not caused by this ADR, and it bounds what any magnitude term can achieve on broad queries. **File and fix before drawing conclusions from broad-query pages.**
- **Method queries are not served by this.** Three of three technique queries on the panel are the non-wins; every disease, entity and process query improves. The right number for them exists (`evidenceLines[kind == "method"].count`, from `_source.methodFamilyCounts`) and no ordering term reads it. ⚠ It also disagrees with the sibling `methodPubCount` by up to 40× on the same scholar; those two must be reconciled before either is ranked on.
- **The O1 convergence does not transfer.** A page-1 magnitude rerank made `gene therapy` and `gene therapies` produce identical top-10s. This lever leaves both pages **flat at every weight** — the concept arm is not what separates them. O1's repair is real but it is not this change.
- **Sparse-coverage queries are inert — measured, and it is a property worth protecting.** Where descriptor coverage is thin the concentration score never leaves its lowest band, so the page returns rank-for-rank identical. Nothing *enforces* this; it follows from the band being scaled rather than a sort. Any successor design that replaces the band with an uncapped linear term loses it, and the query that damaged the `rank_features` proxy is precisely the one this protects.

- **Affiliated faculty are systematically promoted over full-time faculty**, because lifetime publication counts are largest for senior affiliated clinicians whose SPS profiles are thinnest. The promotions are topically correct, but the cards render with empty `humanizedAreas` and no grants next to the fuller cards they displace. Expect "why is this person ranked first" feedback that is about **card sparsity**, not ordering.
- **Share is baked in at full weight.** The shipped score is `n² / total` — count times on-topic fraction, i.e. share at full strength. An independent sweep found share should be *secondary* to count, and at full weight it demotes the correct scholar on two queries. `n²/total` is inside the knee's win, so it is not urgent, but the exponent is a one-line lever nobody has swept. It is the obvious next experiment and it is free.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **`rank_features` reindex of `meshSubtreeCounts`** | Not implementable as specified (see Context), and unnecessary — the additive per-cwid vehicle already exists and ships. Reconsider only if a magnitude is needed that cannot be computed from the publications index at query time. |
| **Ungrade the bands alone** (`AREA_BOOST_GRADED` on, `W_HI` unchanged) | Measured inert: 5 of 10 queries byte-identical, and where it moved membership it moved it the wrong way. The ceiling, not the banding, is the binding constraint — which is why the flag was previously judged "worse alone". |
| **Delete the method tier** | Rejected on measurement: it scored as the largest available O8 win (−153 inversion pairs) and reading the pages reversed the verdict — with the tier off, every practitioner of the technique is evicted in favour of high-volume generalists. |
| **Ship the volume cap first** | Measured worse. See B3. |
| **Per-request publications-index aggregation for the count** | This is not an alternative — it is what the system already does, on the scoring path, in prod, cached and capped at `AREA_BOOST_TOP_N = 200`. |

## Verification

- **B0:** a consumer keyed on `kind` must fail a test that a consumer filtering on `strength == "tagged"` passes, with all three strengths in the fixture and a `concept`-strength row asserting *unknown* rather than zero.
- **B1:** ✅ **done 2026-07-31.** 10-query panel at pinned prod parity, predictions recorded before the arm was read, one blind judge per query: 6 BETTER / 1 MILD_BETTER / 2 NEUTRAL / 1 WORSE, no control damaged, `total` byte-identical on all 70 captures across the sweep. Re-run before any prod flip, and again whenever another term in the prominence sum moves.

  ⚠ **Do not predict a verdict from median-N in the top 10.** It found the knee correctly and got 4 of 10 verdicts wrong, because it is blind to ordering *within* a page whose membership does not change. It is a weight-locating instrument, not an acceptance test.
- **B2:** measure the `max(year)` sub-aggregation route before mapping any new field.
- Standing: re-derive `W_HI` whenever another term in the prominence sum changes (O5).

## Related

- [`search-relevance-contract.md`](./search-relevance-contract.md) — O1, O3, O5, O7, O8, and O9 added by this ADR.
- [`search-people-relevance.md`](./search-people-relevance.md) — the descriptive reference.
- `lib/api/area-concentration.ts` — owns the choice of what `concentration` credits, which is what makes the emitted `terms: { cwid }` clause satisfy O2.
