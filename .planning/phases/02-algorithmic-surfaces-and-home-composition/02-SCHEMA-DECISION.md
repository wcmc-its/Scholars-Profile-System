---
type: decision-record
phase: 02-algorithmic-surfaces-and-home-composition
decision: D-02
status: locked
locked: 2026-04-30
candidate_chosen: e
candidates_considered: [a, b, c, d, e]
sources:
  - .planning/phases/02-algorithmic-surfaces-and-home-composition/02-CONTEXT.md (D-02)
  - .planning/phases/02-algorithmic-surfaces-and-home-composition/probe-output.json (empirical evidence)
  - .planning/research/inferred-tools-feature-brief.md (TOOL# / TOOL_INDEX# deferred scope)
consumed_by:
  - .planning/phases/02-algorithmic-surfaces-and-home-composition/02-05-PLAN.md (Plan 05 Prisma migration)
  - .planning/phases/02-algorithmic-surfaces-and-home-composition/02-07-PLAN.md (home composition queries)
  - .planning/phases/02-algorithmic-surfaces-and-home-composition/02-08-PLAN.md (topic-page surfaces)
---

# D-02 Schema Shape — Locked Decision

## Decision

**Candidate (e) — project the granular `TOPIC#` rows directly.** The DynamoDB `TOPIC#` rows ARE the ground truth (`(publication × scholar × parent_topic)` triples with subtopic data embedded). Every Phase 2 algorithmic surface and every projected aggregation is derived from a single `publication_topic` table plus a `topic` catalog projected from `TAXONOMY#taxonomy_v2`.

This candidate was not on the original 02-CONTEXT.md menu (a/b/c) because the discuss-phase did not have probe data yet. Candidate (d) — surfaced as a fourth option once the probe ran — mirrors the FACULTY-level `subtopic_scores` map; (e) is one level more granular and supersedes (d).

## Probe summary

The probe (`etl/dynamodb/probe.ts`) ran on 2026-04-30 against `reciterai-chatbot` in `us-east-1` and captured `probe-output.json`:

| PK prefix | Count | Role |
|-----------|------:|------|
| `TAXONOMY#` | 1 | Single meta record `TAXONOMY#taxonomy_v2 / SK=META` carrying the full 67-parent topic catalog as a nested `topics[]` array. Each entry: `id` (slug), `label` (display name), `description` (paragraph). Has `topic_count: 67`, `taxonomy_version: "taxonomy_v2"`. **Does NOT contain subtopics.** |
| `TOPIC#` | 78,103 | Per-publication scoring records. `PK = TOPIC#<parent_topic_id>`, `SK = SCORE#<score>#ACTIVITY#pmid_<id>#cwid_<faculty>`. Fields: `pmid`, `faculty_uid`, `score`, `impact_score`, `author_position`, `year`, `subtopic_ids[]`, `primary_subtopic_id`, `subtopic_confidences{slug:score}`, `rationale`, `synopsis`, `title`, `journal`, `topic_scores_version`, `impact_justification`. |
| `FACULTY#` | 1,563 | One per faculty. Fields: `top_topics[]`, `subtopic_scores {parent_id: {subtopic_id: score}}`, `article_count`, `h_index`, `first_author_count`, `last_author_count`, `scored_pub_count`, `department`, `name`, `taxonomy_version`. |
| `IMPACT#` | 7,097 | Per-pmid impact score. Fields: `pmid`, `impact_score`, `model`, `justification`. (Already feeds existing `publication_score`; not in scope for D-02.) |
| `TOOL#` | 14,721 | Per-tool scholar attribution. **Out of D-02 scope.** Deferred to a future tools-feature milestone — see `.planning/research/inferred-tools-feature-brief.md`. |
| `TOOL_INDEX#` | 15 | Tool category index. **Out of D-02 scope.** Same deferral. |
| `DEEPDIVE#` | 1 | Per-topic narrative (mostly `review_status: pending`). Phase 3+ scope. |

Total scanned: 101,501 items.

## Critical empirical finding — subtopics are not first-class entities

Subtopics appear ONLY as embedded fields on existing rows:

1. `subtopic_ids[]` array on every `TOPIC#` record (per publication)
2. `primary_subtopic_id` (single slug) on `TOPIC#` records
3. `subtopic_confidences {slug: score}` map on `TOPIC#` records
4. `subtopic_scores {parent_id: {subtopic_id: score}}` nested map on `FACULTY#` records

There is **no standalone `SUBTOPIC#` PK prefix, no nested subtopic list inside `TAXONOMY#taxonomy_v2`, and no human-readable label or description for subtopics anywhere**. The slug (e.g., `breast_screening_risk_prediction`) IS the canonical identifier; the UI must titlecase / replace underscores to render a human-friendly name.

This finding eliminates candidates (a) and (c) from contention — both would require synthesizing ~2,000 subtopic rows from `TOPIC#.subtopic_ids[]` enumeration with NULL `description` and slug-derived `label`. Candidate (b) keeps the data flat but loses the parent-topic catalog. Candidate (d) keeps the FACULTY-level `subtopic_scores` shape but pushes per-publication rendering through a separate JOIN. Candidate (e) projects the granular ground truth and lets surfaces query against it.

## Schema (Prisma sketch — Plan 05 will refine)

```prisma
model Topic {
  id            String   @id                          // slug, e.g. "cancer_genomics"
  label         String                                // from TAXONOMY#taxonomy_v2.topics[].label
  description   String?  @db.Text                     // from TAXONOMY#taxonomy_v2.topics[].description
  publications  PublicationTopic[]
}

model PublicationTopic {
  pmid                  Int
  cwid                  String                        // FK to scholar.cwid (existing CWID-keyed convention)
  parentTopicId         String                        // FK to Topic.id
  primarySubtopicId     String?                       // slug; NO FK (subtopics are not first-class)
  subtopicIds           Json                          // ["slug1","slug2",...] from TOPIC#.subtopic_ids
  subtopicConfidences   Json                          // {slug: score} from TOPIC#.subtopic_confidences
  score                 Decimal  @db.Decimal(8,4)     // ReciterAI parent-topic score
  impactScore           Decimal? @db.Decimal(8,4)     // mirror of IMPACT#.impact_score for this pmid
  authorPosition        String                        // 'first' | 'last' | 'middle' | 'second' | 'penultimate'
  year                  Int                           @db.SmallInt
  scholar               Scholar  @relation(fields: [cwid], references: [cwid], onDelete: Cascade)
  topic                 Topic    @relation(fields: [parentTopicId], references: [id], onDelete: Cascade)

  @@id([pmid, cwid, parentTopicId])
  @@index([cwid, parentTopicId, score(sort: Desc)])              // profile Selected highlights + chip-row aggregations
  @@index([parentTopicId, year(sort: Desc), score(sort: Desc)])  // /topics/{slug} Recent highlights
  @@index([cwid, year(sort: Desc)])                              // profile most-recent feed (with D-16 dedup)
  @@index([parentTopicId, cwid])                                 // Top scholars chip row group-by
}
```

`scholar.cwid` is the primary key per ADR-002; FKs reference it directly.

## Surface query map

| Surface | Query (sketch) |
|---------|----------------|
| **Selected highlights** (profile) | `WHERE cwid=? AND author_position IN ('first','last') AND year >= 2020 ORDER BY weighted_score DESC LIMIT N` (D-15 floor on year) |
| **Most-recent feed** (profile) | `WHERE cwid=? ORDER BY year DESC, score DESC` then D-16 dedup against the Selected-highlights pmid set |
| **Recent contributions** (home) | `WHERE author_position IN ('first','last') AND scholar.role_category IN (eligible) ORDER BY weighted_recency DESC LIMIT 6` (joins `scholar` for role carve from 02-03) |
| **Top scholars chip row** (topic page) | `WHERE parent_topic_id=? AND author_position IN ('first','last') AND scholar.role_category='Full-time faculty' GROUP BY cwid ORDER BY SUM(weighted_score) DESC LIMIT 5` (D-13 + D-14) |
| **Recent highlights** (topic page) | `WHERE parent_topic_id=? ORDER BY year DESC, score DESC LIMIT N` — no author-position filter at pool selection (D-13) |
| **Browse all research areas** (home) | `SELECT parent_topic_id, COUNT(DISTINCT cwid) FROM publication_topic JOIN scholar USING (cwid) WHERE role_category='Full-time faculty' GROUP BY parent_topic_id` |

`weighted_score` and `weighted_recency` are computed in `lib/ranking.ts` (Variant B, locked in 02-04) using `score × authorshipWeight × pubTypeWeight × recencyWeight(surface)`.

## Why (e) over the alternatives

| Vs candidate | Disqualifier |
|--------------|--------------|
| (a) self-FK `topic` | Forces synthesis of ~2,000 subtopic rows with NULL description, slug-derived labels. Maintains a fake catalog. Any DDB subtopic rename/merge/split becomes a multi-table migration. |
| (b) flat columns on `topic_assignment` | No parent-topic catalog → `/topics/{slug}` can't render label/description. Browse-all-areas grid expensive. |
| (c) two tables `topic` + `topic_subtopic` | Same NULL-label / synthesis problem as (a), plus more tables for one hierarchy. |
| (d) two tables `topic` + `subtopic_assignment` | Mirrors FACULTY-level `subtopic_scores` only — loses per-publication granularity. Selected highlights / Recent highlights surfaces need (publication, scholar, parent_topic) tuples; (d) requires a JOIN to publication for every render. |

Selection criterion that drove (e): **store ground truth, derive aggregations.** Every other candidate stores a derived form and accepts the maintenance cost of keeping it in sync with the source. (e) is the only candidate where the upstream system can re-classify a publication and every surface reflects it after one row update.

## Migration risks

1. **Existing `topic_assignment` table.** The current `topic_assignment` is a flat `(scholar_id, topic_string)` projection from `FACULTY#.top_topics[]`. Plan 05 must decide whether to (a) drop it entirely (derive `top_topics` via `SELECT cwid, parent_topic_id, COUNT(*) ... LIMIT 5`), or (b) keep it as a denormalized cache for fast home-page queries. Recommend (a) on first pass; reintroduce a materialized view only if query latency demands it.
2. **`primary_subtopic_id` is slug-only, no FK.** Documented above. If a future taxonomy migration deprecates a slug, `publication_topic` rows with that slug remain referencing a non-existent identifier. Mitigation: ETL refresh recomputes from `TOPIC#`, so stale slugs flush out within one daily refresh cycle. No downstream cascade.
3. **Subtopic display labels are slug-derived.** UI must consistently titlecase / replace underscores. Candidates a/b/c/d had the same constraint — no change.
4. **Volume.** ~78,103 rows projected weekly per ADR-005. At ~150 bytes/row average (conservative; JSON fields are small), this is ~12 MB on disk. Aurora MySQL handles this trivially. Initial seed via `INSERT ... SELECT` from a staging table; weekly refresh via watermark or full rebuild.
5. **JSON columns (`subtopicIds`, `subtopicConfidences`).** MySQL 8 / Aurora MySQL supports JSON natively. Indexed access not needed for Phase 2 surfaces — the surfaces filter by `parent_topic_id` and order by score/year. Phase 3 may need a generated column if subtopic-rail queries require it.
6. **D-15 ReCiterAI floor.** `TOPIC#` rows only cover 2020+ publications; the floor is enforced by what data exists. No application-level guard needed. Methodology page must document this (Plan 06 anchor `#selected-highlights`).
7. **D-16 dedup.** Single `publication_topic` table makes dedup a `EXCEPT` or `NOT IN` on `pmid` within a profile render. Already factored into 02-04's ranking implementation (`highlightPmids` Set in `lib/api/profile.ts`).
8. **`role_category` join.** Every "eligibility carve" filter joins `publication_topic.cwid` → `scholar.cwid` to read `scholar.role_category` (landed in 02-03). Composite index `(scholar.cwid, scholar.role_category)` already exists from 02-03's migration.

## Plan delta downstream of this decision

- **Plan 05 (Wave 2 topic taxonomy ETL):** projects `TAXONOMY#taxonomy_v2.topics[]` to `topic` (67 rows) + projects `TOPIC#` to `publication_topic` (~78k rows). Migration file `prisma/migrations/2026XXXX_phase2_topics/migration.sql` replaces the candidate-(a/c/d) shape. ETL adds idempotent upsert on `(pmid, cwid, parent_topic_id)`.
- **Plan 07 (home composition):** queries `publication_topic` directly for Recent contributions and Browse-all-research-areas. No JOIN to a separate scholar-aggregation table.
- **Plan 08 (topic-page surfaces):** queries `publication_topic` for Top scholars chip row (group-by aggregation) and Recent highlights (range query). Both indexed.
- **Plan 09 (revalidation):** unchanged.

## Out-of-scope deferrals

- **`TOOL#` (14,721 rows) and `TOOL_INDEX#` (15 rows)** are NOT projected in Phase 2. The data is real, the value is plausible, the Phase 2 spec does not call for it. Detailed analysis and proposed phasing in `.planning/research/inferred-tools-feature-brief.md` (saved out-of-band during this discuss/decide cycle). Future milestone candidate.
- **`DEEPDIVE#` (1 row, mostly `review_status: pending`)** — not consumed in Phase 2.
- **`FACULTY#` aggregation columns (`h_index`, `article_count`, `first_author_count`, `last_author_count`)** — not projected. If a profile surface ever needs these, derive from `publication_topic` (`COUNT(DISTINCT pmid)`) or project as columns on `scholar` in a future plan. Currently not surfaced anywhere.

## References

- Probe artifact: `.planning/phases/02-algorithmic-surfaces-and-home-composition/probe-output.json` (CWIDs and faculty names redacted before commit per public-repo discipline)
- Probe script: `etl/dynamodb/probe.ts` (re-runnable for future taxonomy refreshes)
- Tools deferral brief: `.planning/research/inferred-tools-feature-brief.md`
- Variant B ranking implementation: `lib/ranking.ts` (locked in 02-04)
- Eligibility carve: `lib/eligibility.ts` + `scholar.role_category` (locked in 02-03)
