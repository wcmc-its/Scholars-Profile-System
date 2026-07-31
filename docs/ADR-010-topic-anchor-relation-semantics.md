# docs/ADR-010 — Topic anchors: the unvetted second hop

**Status:** Proposed
**Date:** 2026-07-28
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

> Raised while reviewing the curated anchors ahead of the prod promotion in
> [#2016](https://github.com/wcmc-its/Scholars-Profile-System/issues/2016) / PR #2024. The promotion
> does not depend on this decision; the review of the rows does. **Proposed**, because the options
> below are open — this document exists to make the choice, not to record one.
>
> **All data claims are against `etl/mesh-anchors/curated.csv` at `origin/master`, 2026-07-28.**
> That file grew 8 → 143 rows on 2026-06-25 (`0f674eac`); a checkout behind that commit shows the
> 8-row version, which is also the state prod is frozen on. Cite the ref when re-checking.

## Context

`mesh_curated_topic_anchor` maps a MeSH descriptor onto a ReciterAI parent topic (a WCM research
area). It is the only mechanism that exits MeSH into the local taxonomy; the other synonym-like
sources all enter MeSH from a surface form.

The table holds two populations that arrive by completely different routes:

| | rows | origin |
|---|---|---|
| **derived** | recomputed nightly | mined: descriptor's relevance-weighted share of a topic's high-relevance papers ≥ `MESH_ANCHOR_THRESHOLD` (0.30) over ≥ `MESH_ANCHOR_MIN_SUPPORT` (5) papers, drawn from papers scoring ≥ `MESH_ANCHOR_SCORE_MIN` (0.9) |
| **curated** | **143** | hand-written in `curated.csv`; **none produced by the threshold** |

**This ADR is about the curated population**, because that is what PR #2024 promotes: prod's
`MESH_ANCHOR_SCORE_MIN` is set to `2`, a documented kill-switch that yields zero derived rows.

The 143 curated rows break down as:

| kind | count | shape of the note |
|---|---|---|
| #1258 lay-term | **135** | `#1258 lay-term "longevity" -> Longevity (NLM exact). Review.` |
| #690/#642 alias targets | 6 | surgical specialties, all marked *"Inert until §1.6 anchor consumption"* |
| seeds | 2 | *"Replace via curation team review."* |

Three facts about that set that shape everything below:

1. **The review has not happened.** 135 notes end in `Review.`; both seeds say *"Replace via curation
   team review."* These are called *curated*, but `confidence: 'curated'` records **provenance** —
   hand-written rather than mined — not that anyone signed off. The 143-row review is a **first
   pass**, not a re-litigation.
2. **143 rows, 143 distinct descriptors.** No descriptor maps to two topics. Any weighting can only
   *damp* a single claim; it can never arbitrate between competing areas.
3. **`curated.candidates.csv` is not an ETL input.** The loader reads only `MESH_ANCHOR_CURATED_PATH`
   (default `curated.csv`). All 137 candidate UIs are already folded into `curated.csv`.

## The problem: a two-hop claim stored as one hop

Each #1258 row encodes two separate assertions, joined into a single stored pair:

```
  lay term  ──hop 1──▶  descriptor  ──hop 2──▶  research area
  "glioblastoma"        Glioblastoma            neuro_oncology
```

**Hop 1 is vetted and strong.** The note records the surface form and NLM's own verdict on the match:
`NLM exact` on 133 rows, `NLM contains` on 2. That is a real, already-graded quality signal.

**Hop 2 is neither.** Nothing vetted `Glioblastoma → neuro_oncology` independently, and it is the hop
whose strength varies enormously across the set. `gene therapy → Genetic Therapy → gene_cell_therapy`
is tight at both hops. `glioblastoma → Glioblastoma → neuro_oncology` is airtight at hop 1 and a
large widening at hop 2 — one disease standing in for a whole field.

Only the *pair* is stored, so the two hops cannot be reviewed, weighted, or corrected separately. A
reviewer looking at `D005909,neuro_oncology` sees neither the lay term that motivated it nor any
record that hop 2 was the judgement call.

**How the pair is then consumed.** `lib/api/search-taxonomy.ts` folds anchors in *as synonym matches*
at **similarity 1.0**, in its own words *"exactly like a curated method-family synonym hit."* Two
further consumers use the topic id as a `terms` clause at `boost: 6`, and `meshMatchTier` reads
`curatedTopicAnchors.length` as a boolean lifting the tier from `entry` (attribution 1.15 / admit
0.03) to `anchored-entry` (1.3 / 0.05). The boost is flat by design — the code states that a doc
matching N anchors scores the same as one matching 1.

So a two-hop claim whose second hop was never vetted is applied with the force of equivalence, and
every row gets identical weight regardless of how far hop 2 travels.

> **Note on derived rows.** For the derived population the mismatch takes a different form: those
> *are* produced by a subsumption test (hop 2 mined statistically) and consumed as synonymy. That
> tension is real but out of scope here, since prod's kill-switch excludes them. It becomes live the
> day `MESH_ANCHOR_SCORE_MIN` is lowered for prod.

## Worked examples

Real rows, `curated.csv` @ `origin/master` 2026-07-28.

**One topic, three relation strengths, identical weight.** `radiology_medical_imaging` receives:

| descriptor | hop 2 is… |
|---|---|
| Radiology | the area itself — a true synonym |
| Magnetic Resonance Imaging | a modality used across neuro, cardio and oncology |
| Diagnostic Imaging | a method category broader than the modality, narrower than the field |

Three different claims, one flat `boost: 6` and one similarity of 1.0. This is the defect in a single
topic.

**Tight at both hops** — `gene therapy → Genetic Therapy → gene_cell_therapy`;
`longevity → Longevity → aging_geroscience`; `palliative care → Palliative Care →
palliative_end_of_life_care`.

**Tight hop 1, wide hop 2** — `glioblastoma → Glioblastoma → neuro_oncology`;
`burnout → Burnout, Professional → bioethics_medical_humanities`;
`IVF → Fertilization in Vitro → womens_health_reproductive_medicine`.

An earlier draft used `local_pub_coverage` as a breadth proxy across these groups. It is dropped: the
ranges overlap almost completely (Glioblastoma, a wide hop 2, scores *above* Genetic Therapy, a tight
one), so it does not separate them and would have argued against the very option it was offered to
support.

## Use cases

**1. Both hops tight — works today.** A user searches `longevity`. Hop 1 is NLM-exact; hop 2 lands on
*Aging & Geroscience*, which is what the searcher meant. The area chip surfaces with no name match.
This is #1258's goal and the mechanism delivers it.

**2. Wide hop 2 — over-delivers.** A user searches `glioblastoma`, wanting GBM researchers. The
entire *Neuro-Oncology* area is injected at similarity 1.0 plus a `boost: 6` terms clause over every
scholar carrying that parent topic. A meningioma researcher with no GBM work now competes on equal
footing. Hop 2 is a true membership claim; it is not what the searcher meant.

**3. The widest case in the set — `MRI`.** `Magnetic Resonance Imaging` has ~18× the median
`local_pub_coverage` of the set (0.0141 against a 0.0008 median; only Prostatic Neoplasms is higher).
It is a term people type constantly, and the descriptor is used across neuro, cardio and oncology. So
injecting *Radiology & Medical Imaging* at similarity 1.0 distorts more than glioblastoma does, and
it does so on a high-traffic query.

**4. The tier lift is unconditional.** Because `meshMatchTier` reads only
`curatedTopicAnchors.length > 0`, *any* anchor — however wide its hop 2 — lifts the query one tier,
irrespective of topic identity. This propagates to Grant Matcha via `lib/api/matcha-spine-run.ts`.

## What the schema cannot express, and what the prose already does

The row cannot record that hop 2 is weaker than hop 1, so the only lever is include or exclude. That
forces every borderline judgement into a binary.

But the data is richer than the schema: **every #1258 note already carries the originating lay term
and NLM's match verdict**, as prose. The question use case 2 asks — *did someone typing this mean the
area?* — is answerable per row from that string, without corpus statistics. It is also the judgement
a human is genuinely better at than an ETL. The field exists; it is just trapped in a text column.

## Options

**A. Status quo; curate tightly.** Delete rows whose hop 2 is too wide. No code change. Permanently
discards true relations that cannot be expressed at reduced weight, and re-litigates on every CSV
growth.

**B. Add an applied-weight column.** A float scaling the fold-in similarity and the `terms` boost.
Name it `applied_weight` or `boost_scale`, **not** `strength` — sitting beside `confidence` it would
read as a graded version of that column, which it is not. Given fact 2 above (one topic per
descriptor) this can only damp, never arbitrate — a smaller benefit than it first appears.

**C. Type the relation.** A `kind` enum (`synonym` | `member` | `related`) with a per-kind boost
table. Self-documenting, but requires curators to assign a type and the `member`/`related` boundary is
itself a judgement.

**D. Reduce anchors to admission only.** Drop *both* the similarity-1.0 fold-in **and** the `boost: 6`
terms clause, keeping the tier lift alone. An earlier draft dropped only the fold-in while keeping the
boost — incoherent, since the fold-in is what delivers #1258's chip and the boost is what use case 2
identifies as harmful. Stated correctly, D means: give up the chip, keep the widening. Nobody should
pick it; it is recorded so the asymmetry is on the record.

**E. Compute hop 2's weight from the corpus.** Derive a widening factor per pair at ETL time and scale
the boost automatically. Apt for *derived* rows, which are already corpus-derived. Weak for the
curated 143, which were not produced from corpus statistics at all — and with one topic per descriptor
there is no competing area to normalize the ratio against.

**F. Promote the lay term to a column.** Extract `lay_term` (and NLM's verdict) out of `source_note`
into real fields, and attach the weight to the **term → area** pair rather than the descriptor → area
pair. This puts the weight on the hop that actually varies, makes the review question *"is this what
the searcher meant?"* rather than *"is this mapping true?"*, and needs no corpus statistics. Cost: a
migration plus a CSV schema change; the 6 alias targets and 2 seeds have no lay term and need a null
path.

## Recommendation

**F + B**, with A's discipline applied to the current 143 meanwhile. E is deferred until derived rows
are promoted, where it belongs.

Store the lay term and NLM verdict as columns, add an `applied_weight` on the term → area pair, and
scale the fold-in similarity and `terms` boost by it. This puts the graded lever on hop 2 — the hop
that is unvetted and variable — while leaving hop 1 as the NLM-backed fact it already is. Curation
stays a human call about intent, which is the call humans are good at.

**Adopt the tier gate with it.** B and F both scale the fold-in and the boost; neither touches
`meshMatchTier`. Without an additional change, the widest anchor in the set still lifts
`entry → anchored-entry` at full force and propagates to Matcha. The fix is one line — threshold on
the maximum `applied_weight` rather than on `length` — and it must be in scope, or use case 4 survives
adoption.

This is a recommendation, not a decision. Adopting nothing is legitimate: the defect is ordering
quality on a subset of queries, not correctness.

## Consequences

**Positive.** Hop 2 becomes reviewable and weightable on its own. The review question becomes "is this
what the searcher meant?", answerable from the row without corpus statistics. Anchor behaviour becomes
explainable to a curator.

**Negative / accepted.** A migration on a table with no backup coverage — acceptable, since it is a
derived projection (curated rows come from git, derived rows recompute), but it must be ordered
against the ETL. Any weight change reweights live queries and needs the same staging-first posture as
the promotion. The 6 inert alias targets and 2 seeds carry no lay term and need a null path.

**Not fixed by any option here.** Exposure across topics is uneven — 57 topics over 143 rows, with
`cardiovascular_disease` carrying 6 and seven topics carrying one apiece. More anchors on an area
means more distinct queries surface its chip. That asymmetry is invisible in the flat design and none
of A–F corrects it; it needs a per-topic normalisation that is out of scope here.

**Out of scope.** Which rows exist; `MESH_ANCHOR_SCORE_MIN`; gating the #2016 promotion; and the
separate finding in [#2018](https://github.com/wcmc-its/Scholars-Profile-System/issues/2018) that the
concept boost tracks research-area rollup size rather than tagged-descriptor count. The two may share
a mechanism — an anchor injects a whole area at similarity 1.0 — but that is a hypothesis, not a
result.

## Validation

The metric must match the consumer, and the two consumers differ:

- **People path** (fold-in + `terms` boost over scholars): scholars in topic Y against scholars
  carrying descriptor X.
- **Evidence path** (`terms` over publications): publications in topic Y against publications
  carrying descriptor X.

An earlier draft proposed the paper-level metric in option E and the scholar-level one in Validation.
Both are needed, one per path.

A ratio near 1 confirms a tight hop 2; a large ratio identifies the rows this ADR is about. That query
also ranks all 143 by risk and reduces the outstanding first-pass review to the outliers.

After adoption, check top-N overlap on a sample of wide-hop-2 anchors: the area chip should still
surface for tight rows while wide rows stop dominating.

## Data hygiene noted in review

Not blocking, but they belong on the record:

- **`D008498` is a provisional row with no expiry.** It exists solely to catch EHR under a suspected
  §1.3 ETL name/UI inconsistency. Nothing links it to that fix, so when §1.3 is resolved it silently
  becomes a wrong anchor. A concrete instance of this ADR's thesis: there is no way to mark a row
  provisional.
- **`biomedical_informatics` receives four anchors**, two of them the shadowing EHR seeds
  (`D057286`, `D008498`) that the file itself flags for replacement. An earlier draft used
  `Electronic Health Records` as a worked example; it was the weakest available choice and is
  withdrawn.
- **`Cost-Effectiveness Analysis` reports `local_pub_coverage` 0.0000.** If that is a true zero rather
  than an unset field, the anchor cannot fire on the evidence path and is a curation deletion
  regardless of which option is adopted. Verify before acting.

## References

- Issue [#1258](https://github.com/wcmc-its/Scholars-Profile-System/issues/1258) — MeSH lay-term → research-area fold-in
- Issue [#2016](https://github.com/wcmc-its/Scholars-Profile-System/issues/2016) — prod anchor table is a 2026-06-02 fossil
- Issue [#2018](https://github.com/wcmc-its/Scholars-Profile-System/issues/2018) — concept boost tracks area rollup size
- PR #2024 — promote the anchor step to the prod nightly, curated-only
- `etl/mesh-anchors/index.ts` — derivation, write semantics, the three threshold constants
- `lib/api/search-taxonomy.ts` — the similarity-1.0 synonym fold-in
- `lib/api/search.ts` — the `boost: 6` terms clauses and the Concept-impact set
- `lib/search.ts` — `meshMatchTier`, `MESH_ADMIT_WEIGHT`, `MESH_ATTRIBUTION_WEIGHT`
