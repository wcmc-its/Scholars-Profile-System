# docs/ADR-011 — Raise the ceiling on the concept magnitude the system already computes

**Status:** **Partially accepted** — B1/B2/B3/B4 are proposed and unjudged, but parts of this record are already in production: #2095 (instrumentation) is merged, and #2098 raised the `AREA_BOOST_TOP_N` default 200 → 500, which changes prod ranking. Do not read "Proposed" off the header and assume nothing has shipped.
**Date:** 2026-07-31
**Revision:** 3

**Revision 2** corrected three claims from revision 1, all of which failed because new data arrived: the acceptance tally counted a query measured over a broken candidate pool, publication years *are* now in the payload, and the proposed breadth gate is not computable as specified.

**Revision 3 corrects two claims made by revision 2 itself.** These are more instructive than revision 1's, because nothing new arrived — the document's own reasoning was wrong and measurement caught it:

| revision 2 claimed | measured |
|---|---|
| `AREA_BOOST_TOP_N` is harmless at `W_HI = 3` and *becomes* a correctness boundary at 20 | **Wrong in both directions.** It was already reordering page 1 at the shipped weight, and a higher weight is *more* cap-stable, not less |
| watch click-position and zero-click rate for a week after the flip | **Underpowered by one to two orders of magnitude.** At 9.7 people searches/day a week is ~68 events; the same numbers need a quarter |
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

[`search-relevance-contract.md`](./search-relevance-contract.md) rule **O8** states that a term which orders by evidence must be sensitive to how much evidence there is. Every query-derived ordering term in the people body fails it — they are presence tests, and the only continuously-varying term in the prominence sum is `ln1p(publicationCount)`, career output with no relation to the query.

The obvious reading of that is "the system has no concept magnitude, so one must be built and indexed." **That reading is wrong, and this ADR exists because two days of work were spent proving it wrong the expensive way.**

### What success looks like to a user, not to a metric

Stated because a reader in a year will otherwise find exhaustive method and no account of whose problem this was.

**The user problem:** someone searches a topic to find who at this institution works on it, and the top of the page is occupied by prolific generalists whose connection to the topic is incidental — while the person with 318 publications on it sits at rank 15 or is absent entirely. The search answers "who publishes a lot and matched some words" when it was asked "who does this."

**Success is that a topical search puts the people who actually do that work on the first screen**, and that the card says why they are there in a number the reader can check.

⚠ **Usage is ~10 people-searches a day.** That is worth stating next to the ambition, because it cuts two ways: it is a *hypothesis* that usage is low partly because topical queries return generalists and people stopped trusting them, and it is *also* a warning that this may simply be a low-traffic tool where ranking work has modest reach. This document cannot distinguish those, and should not pretend to.

**The one online signal with adequate power is people-search volume, quarter over quarter.** Not a week — a quarter, because ~900 events is the sample size the log actually provides. It is slow, badly confounded by term dates and announcements, and **useless as a rollback trigger**. But if the "bad results suppress usage" hypothesis is right, it is the only measurement in this entire programme in which a real user is observably better served. Given how much of "After the flip" is about what cannot be measured here, the one thing that can should be named.

### The magnitude already exists, is already live in prod, and is already correct

`getConceptScholarConcentration` (`lib/api/search.ts:1604`) computes, per candidate, at query time, from two publications-index aggregations over `meshDescriptorUi ∩ wcmAuthorCwids` — **both fields already indexed, no reindex** — a real per-scholar magnitude:

```
concentration = n² / total          # count × on-topic fraction
```

`SEARCH_PEOPLE_CONCEPT_ARM_FIRST` is `"on"` unconditionally (`cdk/lib/app-stack.ts:1816`, prod flipped 2026-07-30), so this is what production runs today.

`buildAreaBoostFunctions` (`lib/api/search.ts:1506`) then emits it into the outer prominence `function_score` as **additive per-cwid clauses** — `{ filter: { terms: { cwid: [...] } }, weight: w }` — after quantizing it: three fraction-of-max bands by default, or `AREA_BOOST_GRADED_BANDS` graded steps under `SEARCH_PEOPLE_AREA_BOOST_GRADED`. Either way the weight is bounded by `AREA_BOOST_W_HI`, whose default is **3**.

So the pipeline is complete end to end. The magnitude is computed over the right corpus, keyed on the resolved descriptor, attached to the right scholars, and delivered additively into the score — and then flattened into a weight that cannot exceed 3, in a sum where the unbounded volume prior spans 2.01×. O8's register row already said it: *"Computed over the right corpus at query time, discarded one step before use."*

**The quantity is right. The cap is the defect.**

Sorting a captured panel by the shipped `n²/total` reproduces a magnitude ordering's top 3 exactly on a disease query (318, 248, 226 tagged publications). Nothing needed to be built to get that number; it is what production already calculates and then throws away.

### How much of the product this touches

**59.3% of real people-search events see a changed page 1, and 19.9% see a different top result.**

Census, not sample: every distinct people query in 90 days of prod logs (299 of 314 replayed, covering 805 of 877 events) run against both arms on staging — baseline `W_HI=3` / GRADED off (today's prod), proposed `W_HI=20` / GRADED on — with the flag echo asserted on every capture and zero request errors.

| outcome | distinct | events |
|---|---|---|
| unchanged | 41.8% | 40.7% |
| reordered, same ten people | 12.0% | 13.2% |
| **membership changed** | 46.2% | **46.1%** |
| **any change** | **58.2%** | **59.3%** |
| top result changed | — | 19.9% |

By query shape (events changed / events): topic **75.6%**, hybrid 58.3%, unclassified 40.7%, name 15.4%, department 0%.

**This is the number that sets how much method the rest of this document deserves**, and it says the reach is large: three in five searches move, one in five gets a new top result. Read the sweep, the panels and the census diff below as proportionate to that.

⚠ Two honest caveats. The shape column mixes the shape *prod logged* with the page *staging evaluated*; five queries prod labelled `name` classify as `hybrid_template` on staging, which is why a shape the boost should not touch shows 15.4% — classifier drift between the older prod image and master, not the boost leaking. And "changed" is not "improved": this measures reach, and only the panels can say direction.

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

### ✅ `AREA_BOOST_TOP_N` — measured, and it was already wrong at today's weight

**Resolved. The concern was real, the framing was wrong in both directions, and the fix is PR #2098 (200 → 500).**

Revision 2 said: at `W_HI = 3` the cutoff is harmless, and it *becomes* a correctness boundary at 20. **Measured, both halves of that are false.** It was already a correctness boundary at the shipped weight, and raising the weight makes most queries *less* sensitive to it, not more.

The correction to the shape of the concern still stands and is what made the result interpretable: the cutoff is not an arbitrary candidate rank. Arm 1 keeps the top N **by the very quantity being boosted** (`sort by n²/total, then slice`), so the failure mode was never "a 300-tagged scholar sits at rank 201". It is **descriptors broad enough that more than N scholars carry substantial concentration** — and the cap is an approximation error that closes as N grows.

**Method.** Sweep `SEARCH_AREA_BOOST_TOP_N` on staging and find, per query, the smallest N whose top 10 equals the top 10 at N = 2000. Ten panel queries × the ladder {5, 10, 25, 50, 100, 150, 200} × two `AREA_BOOST_GRADED` postures × `W_HI ∈ {3, 20}`, prod-parity pin echoed and asserted on every capture.

**Positive control first, because "no difference" is also what a disconnected flag returns.** At `TOP_N = 1` every probed query reorders substantially. The lever is connected; a null result would have meant something.

**Convergence point (smallest N matching the N = 2000 page):**

| config | worst query | converges at | 8 of 10 converge at |
|---|---|---|---|
| `W_HI = 3`, GRADED off — **today's prod** | `cancer`, `functional mri` | **300** | ≤ 150 |
| `W_HI = 20`, GRADED off | `diabetes`, `functional mri` | 150 | ≤ 150 |
| `W_HI = 20`, GRADED on — the B1 ship config | `cancer` | **300** | ≤ 150 |

**Every query, in every configuration, converges at or below 300. None needed more.**

**The defect is live in prod today, not created by B1.** At today's `W_HI = 3` with the cap at 200, two queries had not converged — the page differed from the full-list answer with *identical membership, reordered*: on the broad disease query the **rank 1 and rank 2 scholars swap**, and on the technique query one scholar moves from rank 10 to rank 8. Both settle from 300 upward.

Two things follow that revision 2 got backwards:

- **A higher weight is more stable, not less.** At `W_HI = 20` the boost separates scores decisively, so the top of the page stops depending on how many others are in the list; at `W_HI = 3` the scores are tightly clustered and a small change in the list flips ranks. The intuition that a dominant term is more exposed to a truncated candidate list is wrong here, and the measurement is the only reason we know.
- **Grading raises sensitivity.** With `GRADED` on, `cancer` converges at 300 rather than 100 — more distinct bands means more scholars' relative positions depend on the full list. That is an argument for measuring the cap at the *ship* config, not at prod parity.

**The latency rationale does not bind.** The stated reason for 200 was `function_score` clause count. Origin latency on the broadest panel query is flat from 200 to 5000 — ~0.25-0.30 s across 3 cache-busted runs each, no trend. That is evidence the cost is not binding at 500; it is not evidence it never binds, so re-measure before going higher.

**Decision: raise the default to 500** (PR #2098) — 1.67× the worst observed convergence, and no larger, because the extra margin buys nothing measurable and a cap should stay a cap. This is independent of B1 and ships on its own: it is an approximation-error fix at the weight already in production.

⚠ **Two caveats, both stated rather than resolved.** `cancer`'s concentration list is built over a descendant pool truncated by #2096, so its specific convergence number is provisional — but `functional mri` is **not** truncated and shows the same 300, so the finding does not rest on the broken query. And this measures **arm 1 only**; arm 2 slices a `doc_count`-ordered list, so its cliff is not self-correcting as N grows and a concentrated low-volume specialist can still score zero there at any cap.

### Why this ADR does not propose `rank_features`

The first draft of this ADR proposed remapping `meshSubtreeCounts` from `{ type: "object", enabled: false }` to `rank_features` and reindexing. An adversarial review killed it on four independent counts, all verified against the tree:

1. **`rank_feature` is a query clause and cannot be a `function_score` function.** Prominence is `function_score { functions, score_mode: "sum", boost_mode: "multiply" }` (`lib/api/search.ts:3200`); a `functions` entry is `weight` / `field_value_factor` / `script_score` / `random_score` / decay. The proposal's central sentence — "added to the prominence sum" — was not implementable. Placing it in `baseQuery` instead makes the volume prior a **multiplier on the term meant to counter it**.
2. **`rank_features` supports neither aggregation nor sorting**, so the proposed coverage floor (max and non-zero count across the candidate set) had no computable source.
3. The proposed resolution gate keyed on `meshConfidence == "entry-term"`. Measured: **6 of the 10 panel queries are `entry-term`, including every query the design wins on**, and `gene therapy` / `gene therapies` split `entry-term` / `partial` on the *same descriptor*. The gate would have suppressed the magnitude precisely where it works, and split the standing O1 regression pair. No value in the payload distinguishes a parent hop from a legitimate synonym.
4. The method-routing gate read a count off `matchReason`, which carries none on any variant (`lib/api/search.ts:408-411`).

Beyond being unbuildable as specified, it was unnecessary: the additive per-cwid vehicle it was reinventing **already exists, already ships, and is already request-scoped for A/B**.

## Decision

**Do not fund a `rank_features` reindex for concept counts.** Raise the ceiling on the magnitude the system already computes, and stop quantizing it.

⚠ **These blocks are not all independently landable, and revision 1's claim that they were is withdrawn.** B0 and B2 are independent. **B1, B3 and B4 are one shipment** — B4 because the number that explains the reorder must reach the card the same day, B3 because landing it afterwards would invalidate the `W_HI` the acceptance panel had just accepted. Each block below says which it is.

### 🔴 B-1 — Decide the staging/prod anchor divergence BEFORE the sweep

**This is not a caveat on one number. It is a residual on every measurement in this document, including the sweep that has not run yet — and it needs a decision, not a footnote.**

Every number here was measured on staging. Flags were pinned to prod parity and the echo asserted on each capture, so the *flag* half is controlled. The data half is not: prod has **85 distinct `mesh_curated_topic_anchor` rows against staging's 349** (#2016), and anchors determine which area is credited. The two environments therefore draw concentration lists from different distributions, and **the anchor population cannot be pinned by a query parameter.**

The consequence that matters is forward-looking. If concentration lists differ by that much, **the α knee found on staging is not necessarily the prod knee**, and neither is `W*` or the gate threshold. Leaving this open means the sweep runs, produces `(α*, W*)`, and the residual is rediscovered by whoever notices the numbers do not reproduce in prod.

⚠ It has already been decided once by default: #2098 shipped `AREA_BOOST_TOP_N = 500` to prod on a staging-measured convergence figure. That was a choice, it was not deliberated, and it should not be the template.

Choose one, explicitly, before the sweep:

| option | cost | what it buys |
|---|---|---|
| **Sync the anchor table to prod parity first** | If it is a data sync, cheap — and it **retires the whole class of residual**, not just this instance | Every staging measurement becomes transferable. Strongly preferred if the tables can be reconciled |
| **Run the sweep against prod** behind the `?flags=` allowlist | `flagOverrideEnabled()` is `SPS_ENV === "staging"`, so this needs a prod task-def change — a deliberate widening of a staging-only debug surface, on a public-facing app | Removes the residual for the sweep specifically. The security posture question is real and belongs to whoever owns the edge |
| **Accept it** | Free | Then it must be written into **Accepted consequences** as "all tuned parameters carry an unpinned anchor-population residual", so the next person re-deriving `W_HI` under O5 inherits the warning rather than rediscovering it |

Doing nothing is option three without the write-down, which is the worst of the three.

### B0 — Evidence population (no reindex, no flag, ships first)

`evidenceLines[kind == "publications"]` carries a `strength` discriminator with **three** values (`lib/api/result-evidence.ts:129`): `tagged` (MeSH descriptor), `mention` (free-text keyword), and `concept` (the MeSH-expansion text variant, which carries **no `count`**). Within one hit they are mutually exclusive — the `mention` line is emitted only when nothing else fired — so the hazard is not a sum within a scholar but a **column assembled across candidates**, mixing MeSH counts from some scholars with keyword counts from others.

Measured: reading the column by `kind` ranked a cardiac electrophysiologist first for a lifespan query on six *device-battery*-longevity mentions. Only the two thinnest-coverage panel queries mix the strengths, which is exactly where the damage is largest.

⚠ **Correction — that symptom came from an eval harness, not from shipped code.** An enumeration of all 19 readers of `evidenceLines` / `kind` / `.count` across `app/`, `components/`, `lib/` and `scripts/` found **nothing that orders on an evidence count**: every ordering is RRF, `fusedScore` or OpenSearch rank, and `.count` is read in six places, all of them rendering. The cardiac-EP result is not reproducible from any code path on `master`. **B0's ranking half is therefore preventive, not a bug fix**, and this ADR previously implied otherwise.

**The same defect is live in DISPLAY, though.** `evidenceMatchCount` was strength-blind for `kind: "publications"`, and its caller renders one row per supporting concept — each from a *different* `searchPeople` call — into one shared numeric column. A free-text keyword count printed beside a curated MeSH count, unlabelled. That is O9's "column assembled across candidates", rendered to a user. Fixed in PR #2100 along with a `taggedPubCount` guard that returns `undefined` rather than `0`; the visible consequence is that mention-backed supporting rows lose their number, which is correct because it was never comparable to the one above it.

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
| **Per-request publications-index aggregation for the count** | This is not an alternative — it is what the system already does, on the scoring path, in prod, cached and capped at `AREA_BOOST_TOP_N` (500 since PR #2098, measured; see the cap section). |
| **Add C04.588 to the Neoplasms expansion** | Treats the symptom. The truncation is a lex-ordered walk hitting a 200 cap, and it affects 161 of 587 broad descriptors — Neoplasms is merely the first one big enough to make it visible. See #2096. |

## Verification

- **B0:** a consumer keyed on `kind` must fail a test that a consumer filtering on `strength == "tagged"` passes, with all three strengths in the fixture and a `concept`-strength row asserting *unknown* rather than zero.
- **B1:** ⚠ **provisional, not done.** A 10-query panel ran at pinned prod parity with predictions recorded before the arm was read, one blind judge per query, `total` byte-identical on all 70 captures across the sweep. Tally 5 BETTER / 1 MILD_BETTER / 2 NEUTRAL / 1 WORSE over nine valid queries (`cancer` excluded), no control damaged. It does **not** constitute acceptance, for three reasons: it was judged against α = 1 and the functional form is changing, one query was measured over a truncated pool, and a single judge carries the four decisive verdicts.

  ⚠ **Do not predict a verdict from median-N in the top 10.** It found the knee correctly and got 4 of 10 verdicts wrong, because it is blind to ordering *within* a page whose membership does not change. It is a weight-locating instrument, not an acceptance test.

### What the query log says about this system, and why it changes the method

Measured from `/aws/ecs/sps-app-prod`, 90 days:

| | |
|---|---|
| people `search_query` events | **877** (9.7/day) |
| distinct query strings | **314** |
| shape mix (event-weighted) | topic 58.3%, unclassified 28.0%, name 6.4%, hybrid 4.5%, department 2.5% |
| topic/unclassified queries resolving **no** descriptor | 26 of 245 replayed — **10.6%** |

Two consequences, and the second is the more useful one.

**Online metrics cannot adjudicate this change.** At 9.7 people searches a day, a one-week watch window sees roughly **68 searches**, and clicks are a subset of that. No click-position distribution or zero-click rate computed over 68 events will distinguish a real ranking improvement from noise. Any section of this document that proposes watching an online metric for a week is proposing something underpowered by one to two orders of magnitude; see "After the flip", which is corrected accordingly.

**But the query space is small enough to enumerate, which is strictly better.** 314 distinct queries is not a sample problem — it is a *census*. Every real query this system has served in a quarter can be replayed against two arms and diffed, offline, in minutes. That is a stronger claim than any panel or any online metric can support: not "ten hand-picked queries improved" but "here is every query a user actually issued, and here is exactly which pages changed and how."

The truncation-rate measurement already ran this way and covered 92% of events / 96% of distinct queries in a single pass with zero request errors. **The acceptance evidence for B1 should be a census diff, with the panels used to judge the pages the census flags as changed** — the panel's job becomes adjudicating a shortlist rather than estimating a population. This does not remove the need for the holdout: the census says *what* changed, human judgement still says whether the change is better.

### The acceptance panel needs a held-out set

🔴 **The same ten queries located the `W_HI` knee, will locate α and the dampen setting, and are then proposed as the acceptance test. That is tuning and evaluating on one set**, and with three continuous parameters fitted on ten hand-picked observations it will report a win whether or not one exists.

The frequency-weighting problem cannot be fixed cheaply — the panel exists *because* those queries expose known defects, and that is legitimate. **Holding out can be.** Sample ten queries from the query log by frequency, do not look at them during any sweep, and report the acceptance panel as **two separate tallies**:

- if the holdout comes back materially worse than the tuning set, the parameters are overfitted and the sweep must be redone with a coarser grid;
- if it comes back comparable, the "does not estimate user impact" caveat largely dissolves and the claim gets much stronger.

Roughly ten extra judgements buys that.

✅ **Done — a frequency-weighted holdout is sampled and sealed.** Ten queries drawn frequency-weighted from the prod people-query log (90 days, seed recorded), panel queries excluded, covering 10.1% of non-panel events with a shape mix close to the population's. It lives outside this repo because the strings are real user queries and this repo is public; see the tracking issue for the path. **Do not look at it while sweeping.**

#### But a frequency-weighted sample is the wrong instrument for the overfitting check

⚠ **That set was sampled before the census reframing, and on its own it is underpowered for the job this section gives it.** The document's own findings say so: sparse-coverage queries are rank-for-rank inert, 10.6% of topic/unclassified queries resolve no descriptor at all, and 40.7% of events are unchanged outright. A frequency-weighted ten will therefore be **mostly unchanged pages** — perhaps three informative judgements, and a tally heavy with NEUTRAL that *reads* as "no overfitting detected" when it actually means the sample missed where the change acts. Judging a byte-identical page is zero-information by construction.

**Use two instruments, answering two different questions, and report them as two numbers — never one tally.**

| instrument | sampled from | answers |
|---|---|---|
| **stratified quality set** — 10 queries drawn from the *changed* stratum of the census diff at `(α*, W*)` | pages the census proves moved | **Is the change good?** Every judgement is informative because every page differs |
| **sealed frequency-weighted set** (already drawn) | all real events | **How much does it matter?** The population-impact estimate the stratified set structurally cannot give |

The stratified set cannot be drawn until the census runs at the chosen parameters, so it is sampled *after* the sweep and *before* any judging — the seal that matters is between sampling and judging, not between sweeping and sampling.

#### Pre-registered pass criterion — written before unsealing, on purpose

This document records predictions before reading arms everywhere else, and then proposed to unseal a holdout with no stated threshold. That is the seal doing much less work than it appears to. **The criterion below is fixed now, while the answer is unknown.** Changing it after seeing a tally voids the holdout, and that should be recorded as a deviation rather than quietly done.

**The change PASSES only if all four hold:**

1. **Stratified quality set:** `BETTER ≥ 2 × WORSE`. Ties and NEUTRALs are ignored; a page the census flagged as changed but a judge calls NEUTRAL counts as neither.
2. **No damaged control.** Any control query judged WORSE is an automatic fail regardless of the totals.
3. **No WORSE at rank 1** on any query with more than 5 events in the 90-day log. A new top result that is worse on a query people actually issue is the failure mode with the largest blast radius, and the census says 19.9% of events get a new top result.
4. **Sealed frequency-weighted set:** `WORSE events ≤ BETTER events`. This one is deliberately weak — the set is mostly unchanged pages, so it is a floor against population-level harm, not evidence of benefit.

**Divergence rule.** If the stratified set passes and the frequency-weighted set fails, the parameters are tuned to the queries that move and are harming the ones that do not — investigate before flipping, do not average the two. If the stratified set fails, the change does not ship regardless of what any other number says.

- **B2:** measure the `max(year)` sub-aggregation route before mapping any new field. PR #2095 shipped the pattern on the reason aggregation, so the mechanism is demonstrated; what remains is measuring it on the concentration aggregation.
- **`AREA_BOOST_TOP_N`:** ✅ **done at α = 1.** Convergence swept over ten queries × two GRADED postures × `W_HI ∈ {3, 20}`; everything converges by 300, default raised to 500 (PR #2098).

  **It is an explicit post-check, NOT a fourth sweep dimension.** Earlier drafts said both; this is the ruling. The cap is not a relevance parameter to be tuned — it is a cutoff that must sit above where the page stops changing, so the only question is whether 500 still clears the bar at the chosen `(α*, W*)`. Adding it to the sweep would quadruple the grid to answer a yes/no.

  **Pre-registered prediction, recorded before the sweep runs:** convergence at α = 0.5 will be **at or below 300**, so 500 will still clear. Two measured findings jointly imply it — a higher weight is *more* cap-stable because it separates scores, and lowering α widens the raw score range, which separates them further. **If convergence at `(α*, W*)` exceeds 300, that prediction is wrong and the mechanism is not understood** — stop and explain it before raising the cap again.
- Standing: re-derive `W_HI` whenever another term in the prominence sum changes (O5). B3 is what makes this obligation affordable — and is why B3 is swept with `W_HI` rather than landed after it.

### After the flip

**Everything above is pre-flip. A change that reorders page 1 this dramatically should not go from a ten-query offline panel straight to prod with nothing watching.**

**Rollback is one deploy, and saying so is the point.** All four levers live in the `sps-app-<env>` task-def env, not the image, so reverting is a task-def change and a `cdk deploy Sps-App-prod` — no rebuild, no reindex, no data migration. On staging they are additionally request-scoped via `?flags=`, so the pre-flip arm stays reproducible after the flip. A stated rollback path is what makes an aggressive weight approvable.

⚠ **An earlier draft of this section proposed watching click-position distribution and zero-click rate for a week. That was written before the traffic volume was measured, and it is not viable.** At 9.7 people searches a day a week is ~68 events; neither metric can separate signal from noise at that count. Reaching the ~900 events behind the numbers above takes a **quarter**, not a week. Stating it plainly so nobody spends a sprint building a dashboard that cannot answer the question.

What to do instead, in decreasing order of strength:

| signal | window | what it would mean |
|---|---|---|
| **census diff, pre/post** — replay all 314 distinct real queries against both arms and diff the pages | minutes, and it can run **before** the flip | the primary evidence. Not a proxy for user impact: it *is* every query a user issued. Anything it flags as changed is what the panels should judge |
| **the affiliated-faculty complaint** | first weeks | **a falsifiable prediction already on the record**: this ADR predicts the complaint will be about **card sparsity, not ordering**. If the feedback is about ordering, **B4 did not work and the model of the failure was wrong** |
| click position / zero-click rate | **one quarter minimum** | usable only as a slow confirmation, never as a rollback trigger. Do not gate anything on it |

The second row is nearly free and it is the only place in this document where a real user's reaction tests a claim it makes. Record which way it comes out either way.

**The rollback trigger is therefore qualitative, and that is a real limitation.** At this volume there is no automated regression signal that fires fast enough to catch a bad flip. The compensating controls are that the census diff is exhaustive and runs pre-flip, and that rollback is one deploy. Anyone uncomfortable with that should ask for the census diff to be reviewed before the flip, not for a metric that cannot exist.

## Sequencing decisions

**The running checklist lives on the tracking issue (#2097), not here** — an ADR that needs an edit every time a task closes stops being a record. What belongs in the record is *why* the order is what it is. Four of these are decisions, not scheduling:

0. 🔴 **Decide the anchor divergence (B-1) before any sweep.** It is a residual on every tuned parameter, not on one number, and doing nothing decides it by default — as #2098 already did once.
1. **The `AREA_BOOST_TOP_N` boundary check and the truncation rate are done** (PR #2098). B0 remains unblocked and independent of every parameter below.
2. **The census diff is the primary acceptance evidence and runs pre-flip**; the stratified quality set is drawn *from its changed stratum* after the sweep, and judged against the pre-registered criterion. The sealed frequency-weighted set is judged in the same sitting and reported separately.
3. **α, `W_HI` and `dampen` are swept together, not in sequence** — they interact, and B3's own thesis is that `dampen` moves `W_HI`. One three-dimensional median-N sweep, one blind panel at the end.
4. **The breadth gate is validated offline before the sweep**, because if the classifier cannot separate scope-shifting drops from qualifier drops, the gate needs rebuilding and every downstream parameter changes with it.
5. **B1, B3 and B4 ship as one change.** B4 because the number explaining the reorder must be on the card the same day; B3 because landing it afterwards would invalidate the `W_HI` just accepted.

B2 (step-function recency) and the method magnitude (after the 40× is settled by diffing the two publication lists) follow, and are independent of each other.

## Open questions

- **Does the 200-scholar concentration cutoff change any page at `W_HI = 20`?** Unknown. The deep-pagination check found no discontinuity but measured the wrong ordering to answer it. The `TOP_N` boundary check settles it. If it does move pages, the follow-on question is what the right cutoff costs in `function_score` clause count — a latency question, not a relevance one.
- ✅ **What fraction of *real* queries hit the descendant cap? — 7.8%, and it is essentially one descriptor.** Measured: the prod people-query distribution (90 days, 808 events, 300 distinct) replayed against instrumented staging. Of 219 distinct concept-resolving queries (625 events), **9 distinct / 49 events truncate — 4.1% by distinct query, 7.8% frequency-weighted.** `Neoplasms` accounts for **43 of those 49 events (88%)**; the rest are 1-2 events each. So the 27.4%-of-descriptors figure badly overstates the traffic impact, and #2096's priority rests almost entirely on how much cancer queries matter — which, at this institution, is a product question rather than a technical one.
- **Which of #2096's three fixes is right?** Raise the cap for the terms clause only and A/B it; make the walk breadth-first so a truncated set at least samples the whole tree; or index an ancestor-closure field and drop the runtime expansion. The first is cheapest, the third is correct, the second is the interesting middle. Not decided.
- ✅ **Is the panel's technique-query share representative? — No, it over-represents them.** A frequency-weighted sample of ten real non-panel queries contains **zero** technique/method queries, against **three of ten** in the panel. The panel therefore over-weights exactly the class this change serves worst, which means the 1 WORSE (`functional mri`) counts for more in the tally than in user impact — the change most likely looks *worse* on the panel than it is in practice. n=10, so directional rather than settled. The same sample also skews to `partial` confidence with one query resolving no concept at all, while the panel is almost entirely clean `entry-term`/`exact`: **real traffic is harder than the panel**, in a direction the tally does not capture.
- **What is α actually?** ≈ 0.5 is inferred from two independent signals, neither of which swept α directly. The three-dimensional sweep measures it.
- **Does the unconsumed-token gate separate the two drop classes, or does it only count?** It separates the three queries it was derived from, but `pediatric asthma` → `Asthma` drops a token from a *correct* resolution. If a raw coverage ratio cannot tell that from `functional mri` → `MRI`, the gate needs the MeSH qualifier axis and is materially more work than budgeted. This is the cheapest way the design can be shown wrong early, and it is why the offline validation runs first.
- **Is `n · share^α` the right family at all?** The sweep assumes it, and no alternative functional form has been tried. That is the honest reason to doubt it.
- **Do the tuning and holdout panels agree?** If they diverge materially, three parameters were fitted to ten hand-picked queries and the result does not generalise. This is the single question that most determines whether the flip is justified.
- **Should the 200 → 500 raise have its own page-level acceptance?** It ships as an approximation-error fix, not a ranking-policy change, and it is **not behind a flag** — it reorders page 1 on broad people queries at the next prod deploy. The argument for shipping it directly is that leaving a known-wrong approximation in place to wait for an unrelated panel is worse. The argument against is that this document's own discipline says page-1 reorders get adjudicated on pages. A census diff (see Verification) settles it cheaply and should probably just be run.
- **Does the concept arm reach the queries that need it?** 10.6% of topic/unclassified queries resolve **no** descriptor at all, so no amount of concept-magnitude work touches them. That is a larger slice of traffic than the descendant-cap defect (7.8%), and nothing in this ADR addresses it.
- **Is `n · share^α` the right family for arm 2 as well?** Everything measured here is arm 1. Arm 2 slices a `doc_count`-ordered candidate list, so its truncation is not self-correcting as the cap grows and a concentrated low-volume specialist can score exactly zero at any cap. Unmeasured, and not fixed by PR #2098.
- **Does anything consume `mostRecentYear`?** It ships in the payload as instrumentation. If B2 lands as a step function on *concept-scoped* recency, the scholar-global field may have no consumer and should be reconsidered rather than left as a field nobody reads.

## Related

- [`search-relevance-contract.md`](./search-relevance-contract.md) — O1, O3, O5, O7, O8, and O9 added by this ADR.
- [`search-people-relevance.md`](./search-people-relevance.md) — the descriptive reference.
- `lib/api/area-concentration.ts` — owns the choice of what `concentration` credits, which is what makes the emitted `terms: { cwid }` clause satisfy O2.
- **PR #2095** — step-1 instrumentation, merged and dark: `SEARCH_AREA_BOOST_TOP_N` as an overridable flag, `descendantCount` / `descendantTruncated`, and publication years in the payload. Unblocks the `TOP_N` boundary check and the truncation-rate count.
- **Issue #2097** — the tracking issue. It owns the running checklist and the current state; this ADR owns the arguments. If they disagree about *why*, the ADR wins; about *what is done*, the issue wins.
- **Issue #2096** — the descendant-cap truncation, with the three candidate fixes costed.
- `docs/spec-snapshots/mesh-broad-descriptors-2026-05.json` — capped and uncapped descendant counts for 587 broad descriptors; the source for the 161/587 figure.
