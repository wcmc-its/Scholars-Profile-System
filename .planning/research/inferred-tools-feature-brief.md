---
type: research-brief
status: deferred
captured: 2026-04-30
captured_during: phase-02-execution
trigger: discussion of D-02 schema-shape decision; user flagged "scope creep alert" while considering whether to incorporate inferred-tools data alongside topic/subtopic data
related_data: reciterai-chatbot DynamoDB table, TOOL# (14,721 rows) and TOOL_INDEX# (15 rows) prefixes
related_phase: 02-algorithmic-surfaces-and-home-composition
referenced_from:
  - .planning/phases/02-algorithmic-surfaces-and-home-composition/02-SCHEMA-DECISION.md (planned)
  - .planning/phases/02-algorithmic-surfaces-and-home-composition/deferred-items.md (planned)
decision_needed_before: any future "research tools surface" milestone is opened
---

# Research Tools as a Future Surface — Out-of-Band Brief

## What the data is

ReCiterAI's chatbot table (DynamoDB, region `us-east-1`, table `reciterai-chatbot`) carries an inferred-tools dataset alongside the topics dataset. The Phase 2 probe (`.planning/phases/02-algorithmic-surfaces-and-home-composition/probe-output.json`) found:

- **`TOOL_INDEX#`** — 15 rows. A category catalog over presumably ~hundreds to ~few-thousand distinct tools. The 15 categories are inferred coarse buckets (likely something like: software / sequencing methods / imaging modalities / datasets / statistical methods / model organisms / reagent classes / clinical instruments / etc., though the actual taxonomy isn't yet inspected).
- **`TOOL#`** — 14,721 rows. Per-tool scholar attribution, almost certainly with a per-publication granularity similar to `TOPIC#` (i.e. each row is a `(tool, publication, scholar)` triple with confidence / score / year fields). The exact schema needs a follow-up probe pass — Phase 2's `02-02` only summarized the partition counts, didn't dump the sample item shape for the `TOOL#` prefix.

The plausible inference is that ReCiterAI extracts mentions of:

- **Software / computational methods** — BLAST, GATK, CellRanger, scanpy, custom pipelines
- **Lab techniques** — scRNA-seq, ChIP-seq, mass cytometry, CRISPR-Cas9, super-resolution microscopy
- **Datasets** — TCGA, UK Biobank, MIMIC-III, GTEx, ENCODE
- **Reagents / model systems** — specific antibodies, mouse strains, cell lines
- **Instruments** — specific spectrometers, sequencers, microscopes (less likely; usually instrument identity is below the noise floor in pub text)

The 14,721 row count suggests the inference is conservative — not every publication gets tool attributions, and faculty with tool-heavy methods sections accumulate more rows. At ~1,500 active faculty, that's ~10 tool attributions per faculty on average, which feels about right for a confidence-thresholded inference.

## Why this is interesting

**Differentiation.** Almost no institutional profile system surfaces inferred tools at this granularity. VIVO doesn't. ORCID, Google Scholar, Semantic Scholar all stop at publications. Even paid platforms like Dimensions, Scopus, and Pure expose tools only as keyword facets, not as a first-class profile attribute. So this would be a real product distinction for `scholars.weill.cornell.edu`.

**Audience fit.** Three of the prototype's stated audiences benefit directly:

- **Prospective collaborators** (academic + industry) — "find someone at WCM who actually does CRISPR-Cas9 in primary human cells" is the question they're asking, and right now the answer requires reading 5 papers per candidate to confirm. Tools cuts that to a chip row.
- **Funders** — capability mapping. "Which WCM labs use single-cell methods?" is the kind of question a funder writing a programmatic announcement asks before a site visit.
- **Journalists doing methods stories** — "find a CRISPR researcher to comment on the FDA decision" is a common ask; tools surface makes triage faster than wading through AOIs.

Patients (the largest audience) will not care about tools. So this is a "deepen the long tail" feature, not a "broaden the audience" feature.

**Existing infrastructure does most of the work.** If D-02 lands as candidate (e), the ETL pattern, schema pattern, and surface-building pattern all generalize. There's no new architectural muscle to build — just more rows projected in the same shape.

## Why it's out of scope for Phase 2 specifically

Five hard reasons:

1. **Zero design backing.** Design spec v1.7.1 doesn't reference tools. There's no UI-SPEC. There's no decided placement (profile sidebar? topic page rail? dedicated route?). Building data layers without a target surface is the textbook anti-pattern from CLAUDE.md ("Don't design for hypothetical future requirements").
2. **No spec-level requirement ID.** Phase 2 maps to `RANKING-01/02/03 + HOME-02/03`. Tools maps to nothing in `REQUIREMENTS.md`. Adding it would require a new requirement ID, which means re-opening the milestone-level requirements doc, which means a discuss-phase pass.
3. **Display drives schema.** The right shape for `publication_tool` depends on what the surface needs (per-publication granularity? scholar-level rollup? tool-page route? cross-faceted topic ∩ tool query?). Picking the schema before the display is locked is how you bake denormalization decisions in wrong.
4. **Phase 2 is already large.** 9 plans, 2 non-autonomous checkpoints, 4 waves, ETL touching prisma + ldap + ed + dynamodb. Adding tools means at minimum +2 plans (data layer + display) and probably +3 (data layer + profile section + tools route).
5. **Mohammad's team is the production consumer.** They're rebuilding this prototype in AWS-native production. Every feature here is a feature they have to ingest, validate, and rebuild. Charter discipline says: stay narrow, prove the V1 surface area, ship it. Tools doesn't pass the "is this V1?" test.

## What it would actually take

Best estimate, sequenced:

### Phase A — Data layer (1 plan, ~3 days)

- Re-probe `TOOL#` and `TOOL_INDEX#` to capture the real item shape.
- Project `TOOL_INDEX#` to a `tool_category` table (15 rows).
- Project distinct tool slugs (derived from `TOOL#` rows) to a `tool` table (~few-hundred to few-thousand rows). Open question: does the chatbot table have a separate tool catalog with labels, or does the slug have to be the canonical identifier (same problem as subtopics)?
- Project `TOOL#` rows to `publication_tool(pmid, cwid, tool_id, confidence, year)` mirroring the `publication_topic` pattern from candidate (e).
- Add to the daily ETL refresh cascade.

Schema sketch:

```sql
tool_category(
  id    VARCHAR PK,
  label VARCHAR NOT NULL
)

tool(
  id           VARCHAR PK,            -- slug
  label        VARCHAR NOT NULL,      -- may be slug-derived if DDB has no label
  category_id  VARCHAR FK → tool_category(id) NULL,
  description  TEXT NULL
)

publication_tool(
  pmid        INT,
  cwid        VARCHAR,
  tool_id     VARCHAR FK → tool(id),
  confidence  DECIMAL,                -- ReCiterAI inference confidence
  year        SMALLINT,
  PRIMARY KEY (pmid, cwid, tool_id),
  INDEX (cwid, tool_id),              -- profile section query
  INDEX (tool_id, year DESC),         -- /tools/{slug} Recent highlights
  INDEX (cwid, year DESC, tool_id)    -- profile most-recent feed cross-cut
)
```

### Phase B — Profile-page surface (2 plans, ~1 week)

- Discuss-phase: lock placement (sidebar group? below pubs? in an "Approach" / "Methods" section alongside AOIs?). Lock the render pattern (chip row? grouped by category? expand/collapse?). Lock the eligibility carve (likely same as topics: Full-time faculty + Postdoc + Fellow + Doctoral student). Lock the confidence threshold for display.
- UI-SPEC: design the component, mobile collapse pattern, methodology link target (probably `/about/methodology#tools`).
- Plan 1: `lib/api/profile.ts` extension for tools projection; `tools-section.tsx` component; methodology-anchors entry.
- Plan 2: integrate into the profile-page render with absence-as-default fallback (faculty with no tool attributions just don't show the section). Component-render logging extension.

### Phase C — `/tools/{slug}` route (2-3 plans, ~1.5 weeks)

- Mirror of `/topics/{slug}` Layout B. Top scholars chip row (PI surface, narrowed to Full-time faculty per the existing eligibility rule), Recent highlights using the tool, possibly a "Used alongside" rail (tools that frequently co-occur with this one — derived).
- Discuss-phase: lock layout, ranking formula (Variant B generalizes naturally — `impact × authorship × pub_type × recency` works the same way), eligibility carve, methodology link, mobile pattern.
- Plan 1: `lib/api/tools.ts` + page composition.
- Plan 2: ranking integration + chip-row component (mostly reusable from topic page).
- Plan 3: SEO / URL machinery for `/tools/{slug}` slugs (slug stability, slug-history table mirror, sitemap entry).

### Phase D — Tools browse + cross-facet (2-3 plans, ~1 week, optional)

- `/tools` browse-all-research-tools grid, mirror of Browse-all-research-areas. Categorized by `tool_category`.
- Search facet integration — tool names join the search per-field boosts (need to decide weight; probably 4-6× similar to Title or AOI boost).
- Cross-faceted query support — "Show me oncologists using CRISPR." This is UI-complex and probably should wait for a v2 search redesign.

### Phase E — Methodology + trust (1 plan, ~3 days)

- Methodology page section: `#tools` anchor explaining ReCiterAI's tool inference, confidence threshold, refresh cadence, known limitations.
- Self-edit pipeline extension — do tools join `/api/edit`'s atomic write-through? Likely yes; faculty must be able to suppress wrong attributions. This is a non-trivial UX decision.
- Component-render logging extension to capture which faculty have tool sections present / absent / hidden-by-self-edit.

**Total estimate, end-to-end:** 8-12 plans across 4-5 phases, probably 4-6 weeks of focused work. The data layer (Phase A) is cheap; the value-add phases (B, C, E) are where the real cost is.

## The hard questions a future discuss-phase has to answer

1. **Tool inference accuracy.** What's the false-positive rate? False-negative rate? Faculty-perceived correctness? This is the gating risk — if accuracy is below ~90% for visible attributions, every reputation-sensitive faculty member becomes a complaint vector. Suggest validating with a 50-faculty audit before committing to display.
2. **Self-edit override semantics.** If a PI says "I do not work with mouse models" but ReCiterAI inferred 8 mouse-model tool attributions from co-authored papers, what wins? A blanket suppress? Per-tool suppress? Per-publication suppress? The current self-edit model is profile-field-level; tool inference is publication-level — schemas don't line up.
3. **Tool name normalization.** Will ReCiterAI emit both "scRNA-seq" and "single-cell RNA sequencing" as separate tools? "CRISPR" vs "CRISPR-Cas9" vs "CRISPR/Cas9"? Either the inference resolves these upstream, or we maintain a synonym table downstream, or we accept duplicates. Each has cost.
4. **Confidence display.** Do we show the confidence score? Color-code by confidence? Hide below threshold? Faculty-facing trust is heavily affected by this choice.
5. **Eligibility carve scope.** Tools surfaces for full-time faculty only? Or include postdocs / fellows / doctoral students like the topic surfaces do? Career-stage signal differs — a postdoc using CRISPR is a candidate to recruit, a PI using CRISPR is a candidate to collaborate with.
6. **Privacy / opt-out.** Any tools where institutional liability flags arise? Probably not for the bulk of tools, but dual-use research (gain-of-function virology, certain BSL-4 reagents) may warrant a redaction list.
7. **Stale taxonomy.** New techniques emerge constantly. Who maintains the `tool_category` taxonomy as it drifts? ReCiterAI? A WCM curator? Self-organizing from inference frequency?
8. **Search integration timing.** Should tool names contribute to the existing search ranking (per-field boost like AOI / MeSH)? If yes, this requires a phase that touches `etl/search-index/index.ts` again. Probably defer until tool surfaces have shipped and we have data on how users find them.
9. **Mohammad's production team alignment.** Will their AWS-native rebuild include tools? If they say no, building it in the prototype is wasted effort. If they say yes, we should align on schema before locking it here. This conversation should happen before Phase A starts.
10. **Cross-faceted UX.** "Oncologists using CRISPR" is probably the highest-value query of all the new ones tools enables. It's also the most UI-complex (multi-facet filtering, AND/OR logic, result cardinality cliffs). Worth a sketch/spike before committing to a phase.

## The case against — taking the counterargument seriously

- **VIVO replacement charter.** VIVO doesn't have tools. Building them here makes the prototype's scope drift further from "modern VIVO" toward "modern VIVO + everything ReCiterAI knows." Charter discipline says no.
- **Real audience demand is unproven.** Prospective collaborators in 2026 mostly use ORCID + Google Scholar + GitHub + a person's lab site for tool discovery. Recreating that surface inside an institutional profile is unproven to move the needle. Talk to actual prospective collaborators before committing.
- **Inferred-data UX is hard.** Every wrong attribution is a support ticket. Maintenance overhead can swamp discovery value at scale.
- **Surface area drift.** Once tools are there: "what about chemicals?" "what about anatomical structures?" "what about diseases?" — ReCiterAI infers many entity types, and the data model can absorb all of them but the UI cannot. You lock in a "we project everything ReCiterAI emits" expectation that gets harder to roll back later.
- **Mohammad has to rebuild it.** Every feature in the prototype is a feature his team has to ingest, validate, and rebuild in production. Stay narrow.

## Cheap validation before committing

If a low-cost sniff test is wanted before deciding go/no-go:

1. **One-off accuracy audit.** Pull `TOOL#` rows for 10 representative faculty (across departments, career stages, methods-heavy vs methods-light fields). Eyeball-validate the attributions against their publication abstracts. Score true-positive / false-positive / false-negative rates. ~1 day of work; no schema, no ETL, no UI. Outcome: a confidence number that grounds the rest of the decision.
2. **5 user interviews.** A PI, a research dean / VP-Research, an industry collaborator who has actually scouted at WCM, a journalist who covers WCM, a postdoc job-seeker. 30-minute conversation each. "If you saw [mock] tool attributions on this profile, would you use them? How? What would make them untrustworthy?" ~1 week elapsed; ~5 hours of focused work.
3. **One sketch.** Mock up the profile-page tools section in three placement variants (sidebar group / below-pubs section / inline-with-AOIs chip row). 2 hours. Pick the one that looks least intrusive.

Total cost of this validation: ~2 weeks elapsed, ~10 hours of focused work. Sufficient to make a real go/no-go decision instead of a vibes-based one.

## Bottom line for the out-of-band decision

Tools are a real product opportunity that the existing data layer can support cheaply. The hard cost is in display, trust, and self-edit — not in ETL.

The question is not "can we?" but "should we, and when?" Honest read: the Phase 2 → Phase 3 → SEO/analytics work in the locked roadmap is the right path to V1 launch. Tools is a strong V1.5 / V2 candidate, predicated on (a) an accuracy audit confirming inference quality and (b) a user-research signal that prospective collaborators / funders actually want this. Both can be done in <2 weeks of cheap validation work that doesn't touch any of Phase 2's locked plans.

If those two checks pass, plan a tools-as-feature milestone with Phases A–E above. If either fails, defer indefinitely and capture the learnings.
