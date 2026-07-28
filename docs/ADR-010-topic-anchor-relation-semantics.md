# docs/ADR-010 — Topic anchors: relation semantics and graded strength

**Status:** Proposed
**Date:** 2026-07-28
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

> Raised while reviewing the 143 curated anchors ahead of the prod promotion in
> [#2016](https://github.com/wcmc-its/Scholars-Profile-System/issues/2016) / PR #2024. The promotion
> itself does not depend on this decision; the review of the rows does. Filed as **Proposed** because
> the options below are genuinely open — this document exists to make the choice, not to record one.

## Context

`mesh_curated_topic_anchor` maps a MeSH descriptor onto a ReciterAI parent topic (a WCM research
area). It is the only mechanism that exits MeSH into the local taxonomy; the three other
synonym-like sources all enter MeSH from a surface form:

| mechanism | direction | scale |
|---|---|---|
| NLM entry terms | surface form → descriptor | from MeSH |
| curated aliases (`etl/mesh-aliases/`, #642) | surface form → descriptor, where NLM has no such form | 75 rows |
| method-family synonyms (`lib/methods/family-synonyms.ts`) | query → method family | — |
| **topic anchors** (this ADR) | **descriptor → research area** | **143 curated + derived** |

The table models exactly one relation:

```prisma
model MeshCuratedTopicAnchor {
  descriptorUi  String
  parentTopicId String
  confidence    String   // 'curated' | 'derived'
  sourceNote    String?
  refreshedAt   DateTime
  @@id([descriptorUi, parentTopicId])
}
```

`confidence` records **provenance** — hand-written vs mined — not relation kind or strength.

## The mismatch

An anchor is **produced** by a subsumption test and **consumed** as a synonym.

**Produced by subsumption.** `etl/mesh-anchors/index.ts` derives an anchor when a descriptor's
relevance-weighted share of high-relevance papers falls at or above `MESH_ANCHOR_THRESHOLD` (0.30)
into a topic, over at least `MESH_ANCHOR_MIN_SUPPORT` (5) papers. In plain terms: *most of what this
descriptor is about lives in that area*. That is a membership claim — narrower thing under broader
thing. The column name agrees: `parent_topic_id`.

**Consumed as synonymy.** `lib/api/search-taxonomy.ts` folds anchors in as *synonym matches*, at the
maximum similarity, with the code saying so directly:

> fold curated MeSH topic anchors in **as synonym matches** … Inject those parentTopic candidates at
> **similarity 1.0** so they flow through partition/rank/enrich/areas **exactly like a curated
> method-family synonym hit** — surfacing the area's chip with zero name match.

Two further consumers use the topic id substantively: a `terms` clause at `boost: 6` on both the
people and evidence paths (`lib/api/search.ts`), and the "Concept impact" anchor set. A fourth
consumer, `meshMatchTier`, reads only `curatedTopicAnchors.length` as a boolean to lift the match
tier from `entry` (attribution 1.15 / admit 0.03) to `anchored-entry` (1.3 / 0.05).

**Every anchor is treated identically.** The boost is flat by design — `lib/api/search.ts` states
that "a doc matching N anchors scores the same as a doc matching 1" — and the fold-in similarity is
a constant 1.0. The graded ladder in `lib/search.ts` (`MESH_ADMIT_WEIGHT` / `MESH_ATTRIBUTION_WEIGHT`)
grades **how the query matched a descriptor**, not what the anchor asserts.

So a claim that is true as membership is applied with the force of equivalence, and the system has no
way to tell the two apart.

## Worked examples

All rows below are real, from the 143 curated anchors in staging. `coverage` is the descriptor's
`local_pub_coverage` — its share of the WCM corpus — included as a rough breadth signal, not as the
proposed metric.

**Near-synonymous — the relation the consumer assumes.** The descriptor essentially *is* the area;
folding the area in at similarity 1.0 is what a searcher wants.

| descriptor | → topic | coverage |
|---|---|---|
| Genetic Therapy | Gene & Cell Therapy | 0.0021 |
| Telemedicine | Digital Health & Telemedicine | 0.0013 |
| Palliative Care | Palliative & End-of-Life Care | 0.0018 |
| Regenerative Medicine | Stem Cell & Regenerative Medicine | 0.0002 |

**Narrow instance under a whole discipline — true, but not equivalence.** The descriptor names one
disease or device; the topic names the field that studies it.

| descriptor | → topic | coverage |
|---|---|---|
| Glioblastoma | Neuro-Oncology | 0.0028 |
| Burnout, Professional | Bioethics, Medical Humanities & Clinician Wellbeing | 0.0006 |
| Wearable Electronic Devices | Digital Health & Telemedicine | 0.0002 |
| Fertilization in Vitro | Women's Health & Reproductive Medicine | 0.0009 |

**Method or artifact under a field** — defensible, and widens for a different reason: the method is
used across the field rather than being a subject of it.

| descriptor | → topic | coverage |
|---|---|---|
| Cost-Effectiveness Analysis | Health Economics | 0.0000 |
| Electronic Health Records | Biomedical Informatics | 0.0011 |
| Magnetic Resonance Imaging | Radiology & Medical Imaging | 0.0141 |

Nothing in the stored row distinguishes these three groups.

## Use cases

**1. The motivating case, which works.** A user searches `longevity`. It resolves to a descriptor
anchored to *Aging & Geroscience*; the area is folded in at similarity 1.0 and its chip surfaces with
no name match. This is #1258's original goal and the anchor mechanism delivers it exactly.

**2. The narrow case, which over-delivers.** A user searches `glioblastoma`, wanting people who work
on GBM. The anchor injects the entire *Neuro-Oncology* area as though the user had typed the field's
name, and adds a `boost: 6` terms clause over every scholar carrying that parent topic. A brain-
metastasis or meningioma researcher with no glioblastoma work is now competing with GBM researchers
on equal footing. The claim "glioblastoma belongs to neuro-oncology" is true; the claim "someone
searching glioblastoma meant neuro-oncology" is not.

**3. The tier side effect, which is separate and unconditional.** Because `meshMatchTier` reads only
`curatedTopicAnchors.length > 0`, *any* anchor — however narrow — lifts the query one tier, from
`entry` to `anchored-entry`. This applies even when the topic identity is irrelevant to the query.

**4. Downstream consumers inherit the semantics.** `lib/api/matcha-spine-run.ts` derives its tier the
same way, so a decision here propagates to Grant Matcha, not only to public search.

## What the schema cannot express

There is no way to record *"this mapping is true but weaker."* The only lever per row is include or
exclude. That forces every borderline judgement into a binary, and it is why reviewing the 143 rows is
harder than it should be: the reviewer is not asked "is this true?" (nearly all are) but "does this
deserve synonym-strength treatment?" — while being unable to answer anything except yes or no.

## Options

**A. Status quo; curate tightly.** Keep the flat boost and delete rows that are too narrow to justify
synonym treatment. No code change. Cost: permanently loses true relations because they cannot be
expressed at reduced weight, and re-litigates the same judgement every time the CSV grows.

**B. Add a `strength` column.** A float on the anchor row, multiplying the fold-in similarity and the
`terms` boost. Curated rows carry a hand-set strength; derived rows inherit their computed ratio.
Cost: schema migration, ETL change, three consumer changes. Benefit: `Glioblastoma → Neuro-Oncology`
can exist at half weight instead of being deleted or over-applied.

**C. Type the relation.** Add a `kind` enum (`synonym` | `member` | `related`) with a per-kind boost
table, mirroring the existing tier ladder. More expressive than B and self-documenting, but requires
every curator to assign a type, and the boundary between `member` and `related` is itself a judgement.

**D. Stop treating anchors as synonyms.** Drop the similarity-1.0 entity fold-in and keep only the
tier lift and the `terms` boost. Cost: gives up #1258's original goal — the "longevity → Aging &
Geroscience" chip is precisely the fold-in. Only sensible if the narrow rows dominate in practice.

**E. Compute the strength instead of curating it.** At ETL time, derive a widening factor per pair
(descriptor breadth against topic breadth, both already available to the derivation SQL) and scale the
boost by it automatically. No curator burden and it self-maintains as the corpus changes. Cost: a
computed weight is harder to reason about when a specific pairing looks wrong, and it needs a
validation pass before anyone trusts it.

B and E compose: E computes the value, B stores and applies it. C is an alternative to both.

## Recommendation

**B + E**, with A's curation discipline applied to the current 143 in the meantime.

Store a `strength` on the anchor row and scale the boost by it, and compute it in the ETL from the
same co-occurrence data the derivation already produces. This keeps curation binary — a human decides
whether a mapping is *true*, which is the judgement humans are good at — and lets the system grade
*how strongly* to apply it, which is the judgement data is good at. It preserves #1258's fold-in for
near-synonymous anchors while damping the narrow ones, and it needs no new curator vocabulary.

This is a recommendation, not a decision. Adopting nothing and shipping the promotion as-is is a
legitimate outcome: the defect is ordering quality on a subset of queries, not correctness.

## Consequences

**Positive.** Narrow-but-true anchors stop being a binary choice. The 143-row review becomes "is this
mapping true?" rather than "does this deserve maximum boost?". Anchor behaviour becomes explainable —
a scored row can be shown to a curator with its weight.

**Negative / accepted.** A schema migration on a table with no backup coverage (it is a derived
projection — curated rows come from `curated.csv` in git, derived rows are recomputed — so this is
acceptable, but the migration must still be ordered against the ETL). Any strength change reweights
live queries, so it needs the same staging-first posture as the promotion itself.

**Out of scope.** This ADR does not change which rows exist, does not change
`MESH_ANCHOR_SCORE_MIN`, and does not gate the #2016 promotion. It also does not address the separate
finding in [#2018](https://github.com/wcmc-its/Scholars-Profile-System/issues/2018) that the concept
boost tracks research-area rollup size rather than tagged-descriptor count — though the two may share
a mechanism, since an anchor injects an entire area at similarity 1.0. That link is a hypothesis, not
an established result.

## Validation

Before adopting B or E, measure the widening each anchor actually causes: per pair, the count of
scholars in topic Y against the count carrying descriptor X. A ratio near 1 confirms near-synonymy; a
large ratio identifies the rows this ADR is about. That single query also ranks all 143 by risk and
reduces the outstanding curation review to the outliers.

After adoption, the check is a before/after on the affected queries — top-N overlap for a sample of
narrow anchors, confirming the area chip still surfaces for near-synonymous rows while narrow rows
stop dominating.

## References

- Issue [#1258](https://github.com/wcmc-its/Scholars-Profile-System/issues/1258) — MeSH lay-term → research-area fold-in
- Issue [#2016](https://github.com/wcmc-its/Scholars-Profile-System/issues/2016) — prod anchor table is a 2026-06-02 fossil
- Issue [#2018](https://github.com/wcmc-its/Scholars-Profile-System/issues/2018) — concept boost tracks area rollup size
- PR #2024 — promote the anchor step to the prod nightly, curated-only
- `etl/mesh-anchors/index.ts` — derivation and write semantics
- `lib/api/search-taxonomy.ts` — the synonym fold-in
- `lib/api/search.ts` — the `terms` boost and Concept-impact set
- `lib/search.ts` — `meshMatchTier`, `MESH_ADMIT_WEIGHT`, `MESH_ATTRIBUTION_WEIGHT`
