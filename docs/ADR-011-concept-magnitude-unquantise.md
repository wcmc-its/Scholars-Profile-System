# docs/ADR-011 — Unquantise the concept magnitude the system already computes

**Status:** Proposed
**Date:** 2026-07-31
**Revision:** 2 — revised after PR #2095 (step-1 instrumentation) merged. Three claims in revision 1 are now falsified and corrected below: the acceptance tally counted a query measured over a broken candidate pool, publication years *are* now in the payload, and the proposed breadth gate is not computable as specified.
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
| cancer ⚠ | 32 | 32 | 32 | **168** | 174 | 174 |
| diabetes | 54 | 54 | 54 | **57** | 57 | 57 |
| aging | 8 | 8 | 11 | **11** | 14 | 14 |
| functional mri | 20 | 20 | 40 | **110** | 149 | 149 |
| gene therapy / gene therapies | 31 | 31 | 31 | **31** | 31 | 31 |
| crispr | 0 | 0 | 0 | **0** | 0 | 0 |
| longevity | 1 | 1 | 1 | **1** | 1 | 1 |
| flow cytometry | 1 | 2 | 2 | **2** | 2 | 3 |

**W_HI = 20 is the knee.** Past it the only material movement is `functional mri` climbing further, and on that query climbing is the damage.

⚠ **The `cancer` row is measured over a broken candidate pool and must not be counted.** The `Neoplasms` descendant expansion is truncated (see Consequences), so every number on that row describes a magnitude ordering over a haematology-biased subset of the scholars who should have been candidates. The row is left in the table because the *knee location* is corroborated by the other nine queries, but it carries no weight in the verdict.

On the headline disease query, raising one weight moves the top of the page from a scholar with 13 of 339 publications tagged (3.8%) to a page where nine of ten carry 60 or more — and it reaches scholars who were **not in the fetched 20 at all**, because this is a scoring change and not a reordering. The rank-15 and rank-11 scholars a page-1 experiment could surface are joined by several it structurally could not.

Judged on the 10-query acceptance panel, predictions recorded before the arm was read, one blind judge per query. The raw tally was 6 BETTER / 1 MILD_BETTER / 2 NEUTRAL / 1 WORSE with no control damaged. **Quote it as 5 BETTER / 1 MILD_BETTER / 2 NEUTRAL / 1 WORSE over nine valid queries, `cancer` excluded.** `cancer`'s BETTER verdict is struck because that query's candidate pool is truncated by construction and the judge was ordering a broken set. That is a **methodological exclusion, not a verdict** — do not fold it in as a fifth category, which invites reading it as 5-of-10. The page-1 `rank_features` proxy scored 7/1/2 but **damaged a control**; this arm does not.

Two caveats on the panel itself, both of which bound how much the tally can carry:

- **One judge per query, so there is no inter-rater signal at all.** A proxy metric got 4 of 10 verdicts wrong in the same session; human relevance judgement on a single read is at least as noisy. Four extra judgements — a second judge on the WORSE (`functional mri`), the two NEUTRALs (`longevity`, `crispr`) and the headline BETTER (`lung cancer`) — is the difference between this being a result and an anecdote.
- **The panel is not drawn from the query log and is not frequency-weighted, so the tally does not estimate user impact.** The ten queries were chosen by *known defect* — the 1978-paper specimen, #2072, #1342, #2088, the O1 surface-form pair, #2070, plus three declared controls. Three of ten are technique queries. If techniques are over-represented versus real traffic this change looks worse than it is; if under-represented, better. Checking the real mix is cheap and it changes how much the 1 WORSE should worry anyone.

The mechanism behind that difference is the strongest argument in this ADR. Where descriptor coverage is thin, the concentration score never leaves its lowest band and the page returns **rank-for-rank identical** — a page sort acts on ties at any scale, a scaled scoring band does not fire below a floor. **The coverage floor is emergent here and absent from the `rank_features` design**, which would have to reimplement it as an explicit gate whose statistic that field type cannot even compute.

### 🔴 `AREA_BOOST_TOP_N = 200` becomes a correctness boundary at the new weight

**This was absent from revision 1 and it is the one way this change could be quietly wrong in production, on exactly the broad queries it most claims to fix.**

The concentration list is computed for 200 scholars only (`lib/api/area-concentration.ts`). At `W_HI = 3` that cutoff is harmless — the boost barely reorders anything, so a scholar outside the list was not going to reach page 1 regardless. **At `W_HI = 20` the boost dominates the sum, and the cutoff converts from a latency optimisation into a correctness boundary.** The headline argument for this ADR is that the change reaches scholars who were not in the fetched 20; the identical argument applies at 200, and it has not been measured.

One correction to the shape of the concern. The cutoff is not an arbitrary candidate rank — the implementation keeps the top 200 **by the very quantity being boosted** (`sort by n²/total, then slice`). So the failure mode is not "a 300-tagged scholar sits at rank 201 and gets weight zero"; that scholar would have to be beaten by 200 others on `n²/total`. The failure mode is narrower and sharper: **descriptors broad enough that more than 200 scholars carry substantial concentration.** That is `Neoplasms` — and it is exactly the query where the descendant truncation below *also* bites. The two interact.

What has been checked, and what it does *not* show. Deep-paginated `cancer` and `aging` at `W_HI = 20`, prod parity, looking for a discontinuity in tagged count at result rank 200:

```
cancer   ranks 161-180  max N= 89    ranks 201-220  max N= 51
         ranks 181-200  max N= 58    ranks 221-240  max N= 55
                                     ranks 281-300  max N= 51
aging    ranks 181-200  max N=  4    ranks 201-220  max N=  3
```

No discontinuity at 200. **This is weak evidence and does not retire the concern**, because *result* rank is not *concentration* rank — the concentration list is ordered by `n²/total`, the result list by the whole score, and a smooth decay in one says little about truncation in the other. What it does establish: `aging` cannot be affected (the list is nowhere near saturated), and `cancer` plausibly can.

**The check is now two curls.** `SEARCH_AREA_BOOST_TOP_N` was a hardcoded const; PR #2095 made it a request-overridable numeric flag (default unchanged at 200, allowlisted rather than CDK-wired, so staging-only). Run `TOP_N:200` versus `TOP_N:2000` at `W_HI:20` and diff the top 10:

```
/api/search?q=<q>&type=people&flags=SEARCH_AREA_BOOST_W_HI:20,SEARCH_AREA_BOOST_TOP_N:200
/api/search?q=<q>&type=people&flags=SEARCH_AREA_BOOST_W_HI:20,SEARCH_AREA_BOOST_TOP_N:2000
```

Identical pages on all ten queries retires the cutoff and this section can say so. If any page moves, dump `n²/total` at concentration ranks 190-210 for that query and pick a new cutoff — **at that point it is a latency conversation, not a relevance one**, because the cost is `function_score` clause count, which is the stated reason for 200 in the first place.

**Do this before any prod flip.**

### Why this ADR does not propose `rank_features`

The first draft of this ADR proposed remapping `meshSubtreeCounts` from `{ type: "object", enabled: false }` to `rank_features` and reindexing. An adversarial review killed it on four independent counts, all verified against the tree:

1. **`rank_feature` is a query clause and cannot be a `function_score` function.** Prominence is `function_score { functions, score_mode: "sum", boost_mode: "multiply" }` (`lib/api/search.ts:3200`); a `functions` entry is `weight` / `field_value_factor` / `script_score` / `random_score` / decay. The proposal's central sentence — "added to the prominence sum" — was not implementable. Placing it in `baseQuery` instead makes the volume prior a **multiplier on the term meant to counter it**.
2. **`rank_features` supports neither aggregation nor sorting**, so the proposed coverage floor (max and non-zero count across the candidate set) had no computable source.
3. The proposed resolution gate keyed on `meshConfidence == "entry-term"`. Measured: **6 of the 10 panel queries are `entry-term`, including every query the design wins on**, and `gene therapy` / `gene therapies` split `entry-term` / `partial` on the *same descriptor*. The gate would have suppressed the magnitude precisely where it works, and split the standing O1 regression pair. No value in the payload distinguishes a parent hop from a legitimate synonym.
4. The method-routing gate read a count off `matchReason`, which carries none on any variant (`lib/api/search.ts:408-411`).

Beyond being unbuildable as specified, it was unnecessary: the additive per-cwid vehicle it was reinventing **already exists, already ships, and is already request-scoped for A/B**.

## Decision

**Do not fund a `rank_features` reindex for concept counts.** Raise the ceiling on the magnitude the system already computes, and stop quantising it.

⚠ **These blocks are not all independently landable, and revision 1's claim that they were is withdrawn.** B0 and B2 are independent. **B1, B3 and B4 are one shipment** — B4 because the number that explains the reorder must reach the card the same day, B3 because landing it afterwards would invalidate the `W_HI` the acceptance panel had just accepted. Each block below says which it is.

### B0 — Evidence population (no reindex, no flag, ships first)

`evidenceLines[kind == "publications"]` carries a `strength` discriminator with **three** values (`lib/api/result-evidence.ts:129`): `tagged` (MeSH descriptor), `mention` (free-text keyword), and `concept` (the MeSH-expansion text variant, which carries **no `count`**). Within one hit they are mutually exclusive — the `mention` line is emitted only when nothing else fired — so the hazard is not a sum within a scholar but a **column assembled across candidates**, mixing MeSH counts from some scholars with keyword counts from others.

Measured: reading the column by `kind` ranked a cardiac electrophysiologist first for a lifespan query on six *device-battery*-longevity mentions. Only the two thinnest-coverage panel queries mix the strengths, which is exactly where the damage is largest.

Filter to `strength == "tagged"`; treat `concept`-strength hits as **unknown**, never as zero. Contract rule **O9**.

### B1 — Raise, grade and reshape the concept weight

⚠ **Revision 1 scoped this as "two flag flips and a `cdk deploy`, no new code path". That is no longer what this document argues for.** The α sweep and the breadth gate are both now prerequisites of the flip rather than follow-ups, and both are code. Stated honestly, B1 is:

| part | flags? | new code? |
|---|---|---|
| `SEARCH_PEOPLE_AREA_BOOST_GRADED` on, `SEARCH_AREA_BOOST_W_HI` at the measured knee | both exist, both on the `?flags=` allowlist | no |
| the share exponent — generalise `n²/total` to `n · share^α` | new flag needed to sweep it | **yes**, and it changes the scoring formula |
| the breadth gate — unconsumed-token coverage selecting `W_HI` per query | new flag | **yes**, a classifier with its own threshold |
| `SEARCH_PEOPLE_PUBCOUNT_DAMPEN` (B3) — swept in the same pass, see below | exists | no |

**The cheapness claim survives, but it must be re-derived.** It was never really "no code"; it is **no index work**. Against the `rank_features` alternative this change still needs no reindex, adds no dark field a future reindex must carry, costs no index size, and — decisively — is request-scoped on staging, so every parameter above is A/B-able by curl against one process without a deploy. A classifier and a one-line formula generalisation are ordinary application changes; a reindex of `meshSubtreeCounts` is a migration with a rollback that costs another one. That asymmetry, not the line count, is why this wins.

⚠ `SEARCH_PEOPLE_AREA_BOOST_GRADED` is currently `on` in staging and `off` in prod, and was previously recorded as "worse alone, do not promote". That verdict stands **at `W_HI = 3`** and is now explained: grading a magnitude into a range the ceiling has already collapsed changes the ordering within bands that are all worth about the same. The two flags are one change and must ship together; neither is safe to promote alone.

### B2 — Recency as an eligibility step, not a decay factor

The one failure magnitude cannot fix is temporal. A control's top row under every arm is a scholar whose entire tagged evidence is from 1982–1989.

**The instrumentation half of this is done and the ADR's original framing of it is now obsolete.** Revision 1 said "publication years are not in the API payload at all, so no reading of the page can detect it." As of PR #2095 they are: evidence lines carry `latestYear` and hits carry `mostRecentYear`. That was a bug in its own right — the judges could not detect the 1982–89 failure by reading the payload, and one found it by hand on PubMed — and it was fixed independently of ranking, because that instrumentation gap taxes every future panel.

Two limits on it, both documented in code and neither blocking:

- **The year reaches the API, not the rendered page.** The reason-from-doc branch serves tagged counts from `meshSubtreeCounts`, a count map with no years; the SSR `/search` page sets that flag in both envs, `/api/search` does not. Panels read the API, so panels get years. Closing the page-side gap is a reindex and is not proposed here.
- **`mostRecentYear` and `latestYear` are different clocks** — `dateAddedToEntrez` versus `Publication.year`, 0-2 years of skew. They must not be differenced to judge staleness.

On the route: a `max(year)` sub-aggregation almost certainly beats a mapped `meshSubtreeLatestYear` field. Two round trips already exist, the sub-agg rides an aggregation already being issued, and it avoids a dark field a future reindex must carry. PR #2095 already shipped exactly this pattern on the reason aggregation, so the mechanism is demonstrated. Measure it on the concentration aggregation, but expect it to win. `meshSubtreeLatestYear` stays a fallback, not the plan.

**On the shape, the ADR's instinct was wrong: do not multiply concentration by a recency decay.** That is a second continuous tunable interacting with `W_HI`, and no ordering will ever be explainable again.

**Use recency as an eligibility constraint on the top band.** A concept-scoped latest year older than N excludes a scholar from the *top* weight but leaves them in the next one down. A step function, explainable in one sentence — "we don't head a page with work someone stopped doing in 1989" — that fixes the exact control failure observed and adds no interaction term. Sweep N over {5, 10, 15}.

Scholar-global `mostRecentPubDate` remains **not** a substitute: the failing scholars publish recently, just not on the queried concept.

### B3 — The volume cap, swept WITH `W_HI` and shipped WITH B1

#2068's `SEARCH_PEOPLE_PUBCOUNT_DAMPEN=capped` ships **with** B1, never before. Career volume is currently an accidental proxy for topical evidence; capping it alone removes the proxy without supplying the signal, and on two of ten panel queries it demoted the highest-evidence scholar on the page.

**That is an argument about sequencing, not about value, and it undersells B3.** The durable justification: **B3 is what stops `W_HI` from drifting.** `W_HI` needs re-derivation whenever anything else in the sum moves (O5) *precisely because* it is an absolute weight sitting against an unbounded multiplier spanning 2.01×. Cap the volume prior and the ratio becomes stable by construction. Without B3, every future change to the prominence sum costs another acceptance panel.

🔴 **That thesis has a consequence the sequencing must respect, and revision 2's first draft got it wrong.** If capping the volume prior is what makes `W_HI` stable, then landing B3 *after* the acceptance panel **moves a term in the prominence sum and invalidates the `W_HI` that panel just accepted** — by this document's own O5 rule. Flipping at `W = 20` and then immediately landing the change that makes 20 the wrong number, with no re-derivation anywhere after it, is not a defensible order.

The fix is the argument already made for α. α and `W_HI` are swept together *because they interact*; `PUBCOUNT_DAMPEN` interacts with `W_HI` too — **that is not an inference, it is B3's thesis.** So it belongs in the same sweep:

```
α  ×  W_HI  ×  dampen ∈ {off, capped}
```

Median-N locating over three dimensions is still curls and still one afternoon, and it still costs exactly **one** blind panel at the end. B1 and B3 then ship together and O5's obligation is discharged once instead of twice.

This strengthens B3 rather than weakening it. As a standalone item at the end of a list it is easy to defer indefinitely; folded into the sweep it is part of the change that gets accepted.

### B4 — Reconcile the displayed numbers — **ships WITH B1**

Once the ranked quantity is the concept count, the displayed number and the ranked number converge by construction, which is the durable fix for the Layer 3 register.

**Revision 1 scheduled this last. That was the wrong call and it is the sequencing change to feel most strongly about.** This ADR correctly predicts the affiliated-faculty complaint will be about **card sparsity, not ordering** — and then schedules the card fix after the reorder. If the page reorders this dramatically, **the number that explains the reorder has to be on the card the same day.** Otherwise the first week of feedback is unfalsifiable ("this looks wrong") and gets spent defending a ranking whose evidence is invisible.

**Refuse the other fix if anyone proposes it: no full-time-faculty prior.** That is a political adjustment dressed as relevance, it is unjustifiable in the contract, and it will ratchet. Make the ranking legible instead.

## Consequences

### Accepted

- **Application code and flag flips, but no index work.** A scoring-formula generalisation, a breadth classifier, and four flags reaching a `cdk deploy`. No reindex, no ETL change, no index-size cost, no dark field a future reindex must carry. See B1 for why that is the right axis to compare against `rank_features` on.
- **Three tunables that are tuned, not derived.** `W_HI`, α and the gate threshold all come from knees in curl sweeps over a query panel. They are numbers chosen by measurement. B3 is what stops `W_HI` needing re-derivation every time something else moves (O5); the gate threshold and α have no such stabiliser and remain standing re-measurement obligations.
- **Tuning and acceptance need separate query sets.** Three continuous parameters fitted on ten hand-picked queries and then declared accepted on those same ten is overfitting by construction. A frequency-sampled holdout is required — see Verification.

### Not resolved, and stated plainly

- **Mis-resolution is amplified, not caused, and this ADR does not fix it.** On the one technique query that resolves to its parent modality, raising the weight makes the page *worse than the baseline*: summed on-concept method evidence in the top 10 falls **39 → 10**, every promoted scholar has a method count of **0** for the thing asked about, and the three scholars with 14, 10 and 4 publications of it are all evicted. This is **#2088**, upstream of everything here.

  The gate this needs is **not** `meshConfidence`. Measured: the winning disease query and the losing technique query are *both* `entry-term` with `alsoParent: true`.

  **Revision 1 proposed gating on "`conceptLabel` strictly broader than the query string". That is not computable as a string test and will fail review the same way the `meshConfidence` gate did.** `lung cancer` → `Lung Neoplasms` and `functional mri` → `Magnetic Resonance Imaging` are *both* string mismatches. Broadness is a tree relation and testing it needs the tree.

  What actually separates them is already in the payload: **query tokens left unconsumed by the matched entry term.**

  ```
  lung cancer     entry term "Lung Cancer"    both tokens consumed
  gene therapy    entry term "Gene Therapy"   both consumed
  functional mri  entry term "MRI"            "functional" dropped on the floor
  ```

  The resolver hopped to a parent *precisely because* it could not match a token, and the dropped token is the evidence. A content-word coverage ratio over the matched entry term — computable before ranking, no tree walk. **Starting threshold: gate to the low weight when coverage < 1.0** (i.e. any unconsumed content word), which is the strictest setting and the one the three worked examples separate at. It is a starting point for the offline validation to move, not a derived value; state whatever it ends up as, because "a content-word coverage ratio" with no cutoff named is not yet a spec.

  **The gate must select a weight, not kill the boost:** `W_HI = unconsumedTokens ? 3 : 20`. A boolean suppression can regress below today's page; a weight selector can only cost the delta.

  🔴 **Predicted false-positive class, and it is a big one: the signal conflates two different situations.**

  | query | resolves to | dropped token | resolution is |
  |---|---|---|---|
  | `functional mri` | `Magnetic Resonance Imaging` | `functional` | **wrong in kind** — the resolver hopped because it could not match the token; the concept is a strict superset |
  | `pediatric asthma` | `Asthma` | `pediatric` | **right, just under-specific** — the head matched correctly and a modifier was dropped |

  Both leave a content word on the floor, so a flat coverage threshold gates both to `W_HI = 3` — **costing the win on every modifier-qualified query.** At a medical school, population and site modifiers (`pediatric`, `elderly`, `metastatic`, `refractory`) are a large slice of real traffic, so this is not a corner case.

  **The offline validation must carry this as an explicit hypothesis**, not discover it by luck: *does the classifier separate scope-shifting drops from qualifier drops, or does it only count?* If it only counts, the gate likely needs the unconsumed token checked against MeSH's qualifier axis rather than a raw ratio — which is more work than currently budgeted, and far better to learn before the sweep than after the panel.

  **Validate it entirely offline first.** Run the classifier over the query log, eyeball a few hundred classifications with the two-class question above in hand, tune the threshold — without touching ranking at all. It is the cheapest de-risking available and it is fully decoupled from B1.

- 🔴 **The descendant expansion silently truncates 27% of broad descriptors. Mechanism confirmed; filed as #2096.**

  Revision 1 recorded the symptom — `Neoplasms` expanded to C04.557 (by histologic type) and omitting C04.588 (by site), so Breast / Lung / Prostatic / Colorectal Neoplasms, Melanoma, Carcinoma\* and Glioma return zero on a broad-disease query, and a scholar with 318 publications tagged, demonstrably present on the narrower query, is absent from the broad query's candidate set entirely. **Revision 1 then kept quoting that query as evidence. Both cannot be true, and the tally above is corrected accordingly.**

  The cause is now established, and it is not about Neoplasms. `computeDescendants` walks a **lex-sorted** `(treeNumber, descriptorUi)` array and early-returns the instant the list reaches `DESCENDANT_HARD_CAP = 200`. Neoplasms is `C04`, has exactly one tree number, and has **702 true descendants**; the scan fills the cap inside `C04.557` (440 descendants) and never reaches `C04.588` (240). Adding C04.588 is therefore *not* the fix — it would treat the symptom.

  The blast radius was already sitting in the repo, no probe required. `docs/spec-snapshots/mesh-broad-descriptors-2026-05.json` records both a capped and an uncapped count per descriptor: **161 of 587 broad descriptors (27.4%) are truncated today** — Amino Acids/Peptides/Proteins keeps 200 of 4175, Protein Conformation 200 of 3850, Eukaryota 200 of 2454.

  PR #2095 makes it observable at runtime (`searchInterpretation.descendantCount` / `.descendantTruncated`, plus `meshDescendantTruncated` in both query-log branches) without changing what the expansion returns, so the rate over real traffic can be counted without replaying it.

  **It is not a one-line fix, which is why it is filed rather than folded in here.** Raising the cap converts the `terms { meshDescriptorUi: [...] }` clause from 200 to 702 terms for Neoplasms — 4175 for `D12` — moving BM25, the People attribution boost, the funding concept gate, `collectGrantMatchedCwids` and every derived count at once. That is a ranking change needing its own panel A/B. The cheap escape hatch is closed too: `meshSubtreeCounts` is mapped `{ enabled: false }`, readable from `_source` but unusable as a filter, so there is no existing uncapped queryable subtree field.

  This is upstream of all ranking work, is not caused by this ADR, and bounds what any magnitude term can achieve on broad queries. **Any verdict on a broad query is provisional until #2096 lands.**
- **Method queries are not served by this, and that matters more than this ADR's tone suggests.** Three of three technique queries on the panel are the non-wins; every disease, entity and process query improves. *"Find me someone who does X"* is a large share of real usage at a medical school, and the concept arm structurally cannot serve it.

  The right number exists (`evidenceLines[kind == "method"].count`, from `_source.methodFamilyCounts`) and no ordering term reads it. ⚠ It disagrees with the sibling `methodPubCount` by up to 40× on the same scholar.

  **Settle the 40× definitionally, not by argument.** A 40× gap on the same scholar is a *definitional* difference, not a data-quality one — almost certainly distinct-publications versus method-mentions, or family-rolled-up versus leaf. Take the one scholar with the worst gap, pull both underlying publication lists, diff them. An hour, and it ends the discussion with a fact.

  Once settled, **this is not new architecture**: the same query-time aggregation feeding the same additive per-cwid clause over a different field. Scoped that way it is small.
- **The O1 convergence does not transfer.** A page-1 magnitude rerank made `gene therapy` and `gene therapies` produce identical top-10s. This lever leaves both pages **flat at every weight** — the concept arm is not what separates them. O1's repair is real but it is not this change.
- **Sparse-coverage queries are inert — measured, and it is a property worth protecting.** Where descriptor coverage is thin the concentration score never leaves its lowest band, so the page returns rank-for-rank identical. Nothing *enforces* this; it follows from the band being scaled rather than a sort. Any successor design that replaces the band with an uncapped linear term loses it, and the query that damaged the `rank_features` proxy is precisely the one this protects.

- **Affiliated faculty are systematically promoted over full-time faculty**, because lifetime publication counts are largest for senior affiliated clinicians whose SPS profiles are thinnest. The promotions are topically correct, but the cards render with empty `humanizedAreas` and no grants next to the fuller cards they displace. Expect "why is this person ranked first" feedback that is about **card sparsity**, not ordering.
- **Share is baked in at full weight — and sweeping the exponent must happen BEFORE the flip, not after.** The shipped score is `n² / total` — count times on-topic fraction, i.e. share at full strength. An independent sweep found share should be *secondary* to count, and at full weight it demotes the correct scholar on two queries.

  Revision 1 called this "the obvious next experiment, and it is free" and then sequenced it after B1. **Invert that.** `W_HI = 20` is tuned against a functional form that is about to change, and re-tuning it afterwards costs a second acceptance panel. Judging time is the scarce resource here, not curls.

  Generalise the shipped score to `n · share^α` (α = 1 today, α = 0 is pure count). α decides whether the prolific generalist or the mid-career specialist wins:

  ```
  318/900 vs 150/200     α=1   → 112 vs 113   (near-tie)
                         α=0.5 → 189 vs 130   (the prolific generalist wins)
  ```

  **No verdict is attached to that example on purpose** — which of those two orderings is right is exactly what the sweep measures, and asserting it here would pre-commit the reader to the answer before the sweep runs. The independent λ sweep concluding share should be *secondary* to count, plus the two queries where full-weight share demotes the right scholar, both point to **α ≈ 0.5** as the region to search, not as the answer.

  ⚠ **This looks like it contradicts the "delete the method tier" row in Alternatives**, which was rejected precisely because it evicted specialists in favour of high-volume generalists. Reconciled: those are different comparisons. The method-tier case is **across evidence types** — generalists with zero publications *of the queried technique* displacing practitioners of it, which is a correctness failure at any α. The α case is **within one evidence type** — both scholars have on-concept tagged publications, and α only decides how much a high on-topic *share* compensates for a lower absolute count. Lowering α never admits a scholar with no on-concept evidence. Keep this distinction explicit; the pair is the first thing an adversarial reviewer will find.

  **α and `W_HI` interact** — lowering α widens the raw score range, which changes what the top band is worth — so it is one sweep, not two. Use median-N to locate the knee in both dimensions (that is exactly what it is good for), then spend the single blind panel on one `(α*, W*)` pair with the breadth gate on. **One panel, correct functional form.**

## Alternatives considered

| Alternative | Why not |
|---|---|
| **`rank_features` reindex of `meshSubtreeCounts`** | Not implementable as specified (see Context), and unnecessary — the additive per-cwid vehicle already exists and ships. Reconsider only if a magnitude is needed that cannot be computed from the publications index at query time. |
| **Ungrade the bands alone** (`AREA_BOOST_GRADED` on, `W_HI` unchanged) | Measured inert: 5 of 10 queries byte-identical, and where it moved membership it moved it the wrong way. The ceiling, not the banding, is the binding constraint — which is why the flag was previously judged "worse alone". |
| **Delete the method tier** | Rejected on measurement: it scored as the largest available O8 win (−153 inversion pairs) and reading the pages reversed the verdict — with the tier off, every practitioner of the technique is evicted in favour of high-volume generalists. |
| **Ship the volume cap first** | Measured worse. See B3. |
| **Per-request publications-index aggregation for the count** | This is not an alternative — it is what the system already does, on the scoring path, in prod, cached and capped at `AREA_BOOST_TOP_N = 200`. That cap is now sweepable via `SEARCH_AREA_BOOST_TOP_N` on staging (PR #2095); see the correctness-boundary section. |
| **Add C04.588 to the Neoplasms expansion** | Treats the symptom. The truncation is a lex-ordered walk hitting a 200 cap, and it affects 161 of 587 broad descriptors — Neoplasms is merely the first one big enough to make it visible. See #2096. |

## Verification

- **B0:** a consumer keyed on `kind` must fail a test that a consumer filtering on `strength == "tagged"` passes, with all three strengths in the fixture and a `concept`-strength row asserting *unknown* rather than zero.
- **B1:** ⚠ **provisional, not done.** A 10-query panel ran at pinned prod parity with predictions recorded before the arm was read, one blind judge per query, `total` byte-identical on all 70 captures across the sweep. Tally 5 BETTER / 1 MILD_BETTER / 2 NEUTRAL / 1 WORSE over nine valid queries (`cancer` excluded), no control damaged. It does **not** constitute acceptance, for three reasons: it was judged against α = 1 and the functional form is changing, one query was measured over a truncated pool, and a single judge carries the four decisive verdicts.

  ⚠ **Do not predict a verdict from median-N in the top 10.** It found the knee correctly and got 4 of 10 verdicts wrong, because it is blind to ordering *within* a page whose membership does not change. It is a weight-locating instrument, not an acceptance test.

### The acceptance panel needs a held-out set

🔴 **The same ten queries located the `W_HI` knee, will locate α and the dampen setting, and are then proposed as the acceptance test. That is tuning and evaluating on one set**, and with three continuous parameters fitted on ten hand-picked observations it will report a win whether or not one exists.

The frequency-weighting problem cannot be fixed cheaply — the panel exists *because* those queries expose known defects, and that is legitimate. **Holding out can be.** Sample ten queries from the query log by frequency, do not look at them during any sweep, and report the acceptance panel as **two separate tallies**:

- if the holdout comes back materially worse than the tuning set, the parameters are overfitted and the sweep must be redone with a coarser grid;
- if it comes back comparable, the "does not estimate user impact" caveat largely dissolves and the claim gets much stronger.

Roughly ten extra judgements buys that. **Sample the holdout while pulling the truncation-rate slice** — that work already opens the query log, so the marginal cost is close to zero.

- **B2:** measure the `max(year)` sub-aggregation route before mapping any new field. PR #2095 shipped the pattern on the reason aggregation, so the mechanism is demonstrated; what remains is measuring it on the concentration aggregation.
- **`AREA_BOOST_TOP_N`:** `TOP_N:200` vs `TOP_N:2000` at `W_HI:20`, top-10 diff, all ten queries. Must be clean before any prod flip.
- Standing: re-derive `W_HI` whenever another term in the prominence sum changes (O5). B3 is what makes this obligation affordable — and is why B3 is swept with `W_HI` rather than landed after it.

### After the flip

**Everything above is pre-flip. A change that reorders page 1 this dramatically should not go from a ten-query offline panel straight to prod with nothing watching.**

**Rollback is one deploy, and saying so is the point.** All four levers live in the `sps-app-<env>` task-def env, not the image, so reverting is a task-def change and a `cdk deploy Sps-App-prod` — no rebuild, no reindex, no data migration. On staging they are additionally request-scoped via `?flags=`, so the pre-flip arm stays reproducible after the flip. A stated rollback path is what makes an aggressive weight approvable.

Watch for one week:

| signal | why | what it would mean |
|---|---|---|
| click position distribution on people results | the direct read on whether the reorder helps | mass moving **up** the page is the win; flat or moving down is not |
| zero-click rate on people searches | catches "the page got worse in a way nobody clicks through" | a rise is the single clearest regression signal |
| the affiliated-faculty complaint | **a falsifiable prediction already on the record** | this ADR predicts the complaint will be about **card sparsity, not ordering**. If the feedback is about ordering, **B4 did not work and the model of the failure was wrong** |

That third row is nearly free and it is the only place in this document where a real user's reaction tests a claim it makes. Record which way it comes out either way.

## Sequencing decisions

**The running checklist lives on the tracking issue (#2097), not here** — an ADR that needs an edit every time a task closes stops being a record. What belongs in the record is *why* the order is what it is. Four of these are decisions, not scheduling:

1. **Three things are unblocked and gate everything else**: the `AREA_BOOST_TOP_N` boundary check, the truncation rate over real traffic, and B0. They are independent of each other and of every parameter below. Nothing else should start until the first is clean, because it can invalidate the premise.
2. **α, `W_HI` and `dampen` are swept together, not in sequence** — they interact, and B3's own thesis is that `dampen` moves `W_HI`. One three-dimensional median-N sweep, one blind panel at the end.
3. **The breadth gate is validated offline before the sweep**, because if the classifier cannot separate scope-shifting drops from qualifier drops, the gate needs rebuilding and every downstream parameter changes with it.
4. **B1, B3 and B4 ship as one change.** B4 because the number explaining the reorder must be on the card the same day; B3 because landing it afterwards would invalidate the `W_HI` just accepted.

B2 (step-function recency) and the method magnitude (after the 40× is settled by diffing the two publication lists) follow, and are independent of each other.

## Open questions

- **Does the 200-scholar concentration cutoff change any page at `W_HI = 20`?** Unknown. The deep-pagination check found no discontinuity but measured the wrong ordering to answer it. The `TOP_N` boundary check settles it. If it does move pages, the follow-on question is what the right cutoff costs in `function_score` clause count — a latency question, not a relevance one.
- **What fraction of *real* queries hit the descendant cap?** 27.4% of broad *descriptors* are truncated, but descriptor frequency in the query log is unknown and almost certainly not uniform. The rate over traffic could be far higher or far lower.
- **Which of #2096's three fixes is right?** Raise the cap for the terms clause only and A/B it; make the walk breadth-first so a truncated set at least samples the whole tree; or index an ancestor-closure field and drop the runtime expansion. The first is cheapest, the third is correct, the second is the interesting middle. Not decided.
- **Is the panel's technique-query share representative?** Three of ten are technique queries, chosen by known defect rather than frequency. Until the real mix is checked, the tally does not estimate user impact in either direction.
- **What is α actually?** ≈ 0.5 is inferred from two independent signals, neither of which swept α directly. The three-dimensional sweep measures it.
- **Does the unconsumed-token gate separate the two drop classes, or does it only count?** It separates the three queries it was derived from, but `pediatric asthma` → `Asthma` drops a token from a *correct* resolution. If a raw coverage ratio cannot tell that from `functional mri` → `MRI`, the gate needs the MeSH qualifier axis and is materially more work than budgeted. This is the cheapest way the design can be shown wrong early, and it is why the offline validation runs first.
- **Is `n · share^α` the right family at all?** The sweep assumes it, and no alternative functional form has been tried. That is the honest reason to doubt it.
- **Do the tuning and holdout panels agree?** If they diverge materially, three parameters were fitted to ten hand-picked queries and the result does not generalise. This is the single question that most determines whether the flip is justified.
- **Does anything consume `mostRecentYear`?** It ships in the payload as instrumentation. If B2 lands as a step function on *concept-scoped* recency, the scholar-global field may have no consumer and should be reconsidered rather than left as a field nobody reads.

## Related

- [`search-relevance-contract.md`](./search-relevance-contract.md) — O1, O3, O5, O7, O8, and O9 added by this ADR.
- [`search-people-relevance.md`](./search-people-relevance.md) — the descriptive reference.
- `lib/api/area-concentration.ts` — owns the choice of what `concentration` credits, which is what makes the emitted `terms: { cwid }` clause satisfy O2.
- **PR #2095** — step-1 instrumentation, merged and dark: `SEARCH_AREA_BOOST_TOP_N` as an overridable flag, `descendantCount` / `descendantTruncated`, and publication years in the payload. Unblocks the `TOP_N` boundary check and the truncation-rate count.
- **Issue #2097** — the tracking issue. It owns the running checklist and the current state; this ADR owns the arguments. If they disagree about *why*, the ADR wins; about *what is done*, the issue wins.
- **Issue #2096** — the descendant-cap truncation, with the three candidate fixes costed.
- `docs/spec-snapshots/mesh-broad-descriptors-2026-05.json` — capped and uncapped descendant counts for 587 broad descriptors; the source for the 161/587 figure.
