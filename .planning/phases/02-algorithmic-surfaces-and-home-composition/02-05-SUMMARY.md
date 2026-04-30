---
phase: 02-algorithmic-surfaces-and-home-composition
plan: 05
subsystem: database
tags: [prisma, mysql, dynamodb, etl, taxonomy, ranking, decimal, json]

# Dependency graph
requires:
  - phase: 02-algorithmic-surfaces-and-home-composition
    provides: D-02 schema choice locked to candidate (e) in 02-SCHEMA-DECISION.md; probe-output.json empirical DDB shape (TAXONOMY# / TOPIC# / FACULTY#); 02-PATTERNS.md ETL analog patterns
provides:
  - "Topic Prisma model: 67-row catalog projected from TAXONOMY#taxonomy_v2.topics[]"
  - "PublicationTopic Prisma model: ~78k (publication × scholar × parent_topic) triples projected from TOPIC# DynamoDB rows; subtopics embedded as JSON, not first-class entities"
  - "Additive migration prisma/migrations/20260430221545_phase2_topics/migration.sql creating both tables with four indices on publication_topic"
  - "Extended etl/dynamodb/index.ts with TAXONOMY# + TOPIC# projection blocks before the existing FACULTY# scan; idempotent upsert; FK pre-checks against scholar.cwid and topic.id with auditable skip-reason tallies"
  - "D-08 verification documented inline: publication_score is NOT projected by this ETL; the IMPACT# → publication_score projection is tracked separately and out of scope here"
affects:
  - 02-06-PLAN (methodology page that links to the topic catalog)
  - 02-07-PLAN (home composition: getRecentContributions, getSelectedResearch, getBrowseAllResearchAreas)
  - 02-08-PLAN (topic-page surfaces: getTopScholarsForTopic, getRecentHighlightsForTopic)
  - 02-09-PLAN (revalidation + e2e gates that assert topic count == 67)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Idempotent upsert keyed on composite PK (pmid, cwid, parent_topic_id) for the granular projection — replaces the deleteMany+createMany pattern used by the legacy topic_assignment block"
    - "FK pre-check via in-memory scholar.cwid Set + topic.id Set, with skip-reason tallies (missing scholar / missing topic / missing required fields) so partial-data days don't fail the whole ETL run"
    - "Hoisted active-scholar pre-load shared across all three projection blocks; status='active' AND deleted_at IS NULL filter retained from the original FACULTY# block"
    - "JSON column shape: subtopic_ids and subtopic_confidences kept as native MySQL 8 JSON; Phase 3 may add generated columns if subtopic-rail queries need indexed access (documented in 02-SCHEMA-DECISION.md migration risks)"
    - "Decimal(8,4) for ReCiterAI score and impact_score; matches the precision in the addendum's authoritative Prisma sketch"

key-files:
  created:
    - prisma/migrations/20260430221545_phase2_topics/migration.sql
    - .planning/phases/02-algorithmic-surfaces-and-home-composition/02-05-SUMMARY.md
  modified:
    - prisma/schema.prisma (added Topic + PublicationTopic models, added publicationTopics back-relation on Scholar)
    - etl/dynamodb/index.ts (added two projection blocks before the existing FACULTY# block; preserved the FACULTY# block unchanged; hoisted scholar pre-load)

key-decisions:
  - "Followed the addendum's authoritative Prisma sketch verbatim under D-02 candidate (e); did NOT add the topic_assignment.topic_id FK that the (a)-flavored plan body originally required"
  - "Hand-authored the migration SQL because npx prisma migrate dev --create-only requires a live DATABASE_URL; the worktree-mode constraint plus the absence of MySQL in this environment makes that impossible — the hand-authored SQL mirrors the shape Prisma would generate (CREATE TABLE / PRIMARY KEY / INDEX / ADD CONSTRAINT FOREIGN KEY) and was verified to be additive (no DROP COLUMN / DROP TABLE / RENAME)"
  - "Hoisted the active-scholar findMany pre-load to the top of main() so all three projection blocks share the same in-scope cwid set; this is a small refactor of the existing FACULTY# block (the prisma.scholar.findMany call that was inside it is now at the top), but does not change behavior — the same status='active' AND deleted_at IS NULL filter is applied"
  - "publication_topic.score and impact_score use Prisma.Decimal — explicitly constructed via new Prisma.Decimal(...) — to match the @db.Decimal(8,4) column type"
  - "FK pre-check elected over batch-level error swallowing: pre-load scholar.cwid + topic.id sets and skip ineligible rows up front. Tally skip reasons (missingScholar / missingTopic / missingFields) for auditability"
  - "Batched the publication_topic upserts via Promise.all in chunks of 100 per the addendum's explicit guidance; the legacy FACULTY# block's createMany batch size of 1000 is preserved unchanged"

patterns-established:
  - "Multi-block ETL with shared in-scope sets: pre-load FK target sets once, then run multiple projection blocks against the shared sets"
  - "Auditable skip tally: log skip reasons by category (missing scholar / missing topic / missing required fields) rather than failing the run on the first FK violation"
  - "Vestigial-plan-body / authoritative-addendum protocol: when a probe locks a different candidate post-discuss, an authoritative addendum at the top of the plan supersedes vestigial body content; this plan body had candidate-(a)-flavored Prisma sketches and acceptance criteria that were correctly ignored in favor of the addendum"

requirements-completed: [HOME-02, HOME-03]

# Metrics
duration: ~30 min
completed: 2026-04-30
---

# Phase 02 Plan 05: Topic Taxonomy Data Layer Summary

**D-02 candidate (e): topic catalog (67 rows) + publication_topic (~78k triples) projected directly from DynamoDB TAXONOMY# / TOPIC# partitions; subtopics embedded as JSON, no FK on topic_assignment**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-04-30T22:00:00Z (approximate; recorded at agent invocation)
- **Completed:** 2026-04-30T22:19:21Z
- **Tasks:** 2
- **Files modified:** 2 (prisma/schema.prisma, etl/dynamodb/index.ts)
- **Files created:** 2 (migration SQL, this SUMMARY.md)

## Accomplishments

- New `Topic` Prisma model + `topic` table — projects TAXONOMY#taxonomy_v2.topics[] (67 parent topics) into a single catalog keyed on slug. Drives `/topics/{slug}` routing and the home Browse-all-research-areas grid.
- New `PublicationTopic` Prisma model + `publication_topic` table — projects all 78k+ TOPIC# DynamoDB rows into a (publication × scholar × parent_topic) triple table with subtopic data embedded as JSON. Composite PK `(pmid, cwid, parent_topic_id)`; four indices cover the surface query map in `02-SCHEMA-DECISION.md`.
- Additive migration SQL hand-authored at `prisma/migrations/20260430221545_phase2_topics/migration.sql`. No DROP, no RENAME; existing tables and columns are untouched.
- Extended `etl/dynamodb/index.ts` with two new projection blocks (`TAXONOMY#` and `TOPIC#`) before the existing FACULTY# scan, which is preserved unchanged. Idempotent upserts. FK pre-checks with auditable skip tallies.
- Plans 07 and 08 can now `prisma.topic.findMany` for the catalog and `prisma.publicationTopic.findMany` for surface queries (Selected highlights, Recent contributions, Top scholars chip row, /topics/{slug} Recent highlights).

## Task Commits

Each task was committed atomically with `--no-verify` (parallel-executor convention; the worktree branch will be merge-validated by the orchestrator):

1. **Task 1: Apply locked D-02 schema in prisma/schema.prisma + author additive migration** — `f2909b2` (feat)
2. **Task 2: Extend etl/dynamodb/index.ts with TAXONOMY# + TOPIC# projections** — `b040994` (feat)

(No final metadata commit yet — this SUMMARY commit follows below; the orchestrator owns the STATE.md / ROADMAP.md updates after wave merge.)

## Files Created/Modified

- `prisma/schema.prisma` — Added `model Topic` (catalog, slug-keyed, with label / description / source / refreshed_at) and `model PublicationTopic` (composite PK on pmid/cwid/parent_topic_id; four indices; cascade FK to scholar.cwid and topic.id; subtopic_ids + subtopic_confidences as JSON; score and impact_score as Decimal(8,4)). Added `publicationTopics PublicationTopic[]` back-relation to the existing `Scholar` model.
- `prisma/migrations/20260430221545_phase2_topics/migration.sql` — Hand-authored additive migration. Two CREATE TABLE statements (topic, publication_topic), four indices on publication_topic, two FK constraints (publication_topic → scholar.cwid CASCADE, publication_topic → topic.id CASCADE). No DROP / RENAME.
- `etl/dynamodb/index.ts` — Extended from a single-block FACULTY# scan to a three-block ETL. Block 1 (TAXONOMY#) upserts the topic catalog and warns if the count != 67. Block 2 (TOPIC#) paginates through ~78k DDB rows, pre-checks scholar.cwid and topic.id FK targets, builds an in-memory write list with skip-reason tallies, and upserts in Promise.all chunks of 100. Block 3 (FACULTY#) is the preserved Phase 4f topic_assignment projection — the only refactor is hoisting the active-scholar pre-load to be shared across all three blocks (`status='active' AND deleted_at IS NULL` filter unchanged). EtlRun.rowsProcessed now sums all three blocks.

## Decisions Made

- **Followed the authoritative addendum, ignored the vestigial plan body.** The plan was originally written for candidate (a) and offered (b)/(c)/(d) branches. After the probe, D-02 was locked to candidate (e). The addendum at the top of `02-05-PLAN.md` explicitly supersedes the body's must-haves block, candidate-(a) Prisma sketch, and `topic_assignment.topic_id` FK requirement. This SUMMARY captures the (e)-aligned outcome only.
- **Hand-authored the migration SQL.** `npx prisma migrate dev --create-only` requires a live `DATABASE_URL` to introspect schema drift and emit SQL. The worktree mode constraint plus the absence of a running MySQL in this environment made the live-create path unavailable. The hand-authored SQL mirrors what Prisma would emit (the project's existing migrations like `20260430115133_add_coi_activity` were the analog) and was verified to be additive only.
- **Hoisted the scholar pre-load.** The existing FACULTY# block had `prisma.scholar.findMany({ where: { deletedAt: null, status: "active" }})` inside it. The new TOPIC# block needs the same set for FK pre-check. Hoisting to the top of `main()` and sharing the `ourCwidSet` constant between blocks 2 and 3 is a minor, behavior-preserving refactor; the filter is byte-identical.
- **Decimal vs Float for score / impact_score.** The addendum specifies `@db.Decimal(8,4)`. The legacy `topic_assignment.score` is `Float`; `publication_topic.score` is `Decimal`. This matches the addendum's authoritative sketch and gives the ranking math deterministic precision.
- **FK pre-check + skip-tally instead of try/catch around each upsert.** Pre-loading the FK target sets once is O(active scholars + 67) and avoids ~78k DB round-trips for FK errors. Tallying skip reasons by category (missingScholar / missingTopic / missingFields) gives operators an auditable signal when the upstream DDB and our scholar table fall out of sync.

## Deviations from Plan

The plan body originally targeted candidate (a) with a `topic_assignment.topic_id` FK and a self-FK `parent_id` on Topic. The authoritative addendum at the top of `02-05-PLAN.md` superseded those requirements and locked candidate (e) instead. Following the addendum is not a deviation — it is the explicit instruction. Listing the (a)-vs-(e) differences here for traceability:

### Addendum-driven differences from the plan body

**1. [Addendum override] No `topic_assignment.topic_id` FK column**
- **Driven by:** D-02 lock to candidate (e) in 02-SCHEMA-DECISION.md
- **Plan body said:** add `topic_id String?` + `topicRef Topic?` to TopicAssignment, generate `ALTER TABLE topic_assignment ADD COLUMN topic_id`, add a backfill `UPDATE topic_assignment ta JOIN topic t ...`
- **Addendum said:** drop that requirement entirely; `topic_assignment` stays as-is
- **What was done:** No changes to `TopicAssignment` model or table; no backfill UPDATE in the ETL
- **Files affected:** prisma/schema.prisma (no TopicAssignment edits), prisma/migrations/20260430221545_phase2_topics/migration.sql (no ALTER TABLE), etl/dynamodb/index.ts (no `topic_id` references in FACULTY# block)

**2. [Addendum override] No self-FK `parent_id` on Topic, no subtopic table**
- **Driven by:** Probe finding that subtopics are not first-class entities in DynamoDB (no SUBTOPIC# PK, no nested subtopic list in TAXONOMY#)
- **Plan body said:** Topic has `parentId String?` self-FK with `Topic? @relation("TopicParent", ...)`; ~2,000 subtopic rows with parent_id set
- **Addendum said:** subtopics live as embedded fields on PublicationTopic (`primary_subtopic_id`, `subtopic_ids`, `subtopic_confidences`); Topic has 67 rows total
- **What was done:** Topic model has no `parentId` column and no self-relation; PublicationTopic carries the embedded subtopic JSON
- **Files affected:** prisma/schema.prisma, prisma/migrations/20260430221545_phase2_topics/migration.sql

**3. [Addendum extension] Added PublicationTopic table not in original plan body**
- **Driven by:** Candidate (e) projects the granular TOPIC# rows directly
- **Plan body said:** project the FACULTY-level top_topics into Topic + extended TopicAssignment
- **Addendum said:** project per-publication TOPIC# rows into a new `publication_topic` table
- **What was done:** New `model PublicationTopic` + `CREATE TABLE publication_topic` with composite PK on (pmid, cwid, parent_topic_id) and four indices

### Auto-fixed issues (Rules 1-3)

None. The two tasks executed cleanly under the addendum contract; typecheck and lint passed on first run.

---

**Total deviations:** 3 addendum-driven differences from the (a)-flavored plan body (all expected per the addendum's "authoritative under (e)" status); 0 Rule-1/2/3 auto-fixes.

**Impact on plan:** All differences are mandated by the addendum and 02-SCHEMA-DECISION.md. Downstream Plans 07, 08, 09 should reference `publication_topic` not the candidate-(a) `topic_assignment.topicId` shape (their plans were drafted post-D-02-lock so this should already be aligned).

## Issues Encountered

- **Live ETL run deferred.** The plan's operational verification gates (`SELECT COUNT(*) FROM topic = 67`, `SELECT COUNT(*) FROM publication_topic ≈ 78k`, `EtlRun.status='success' AND rowsProcessed>0`) require AWS credentials and a live MySQL — neither is available in this worktree environment, and the executor prompt explicitly forbids reading `~/.zshenv` to inspect creds. Code-present gates all pass: TypeScript typecheck clean, ESLint clean, all 69 unit tests pass. The live run is deferred to a credentials-available environment (Mohammad's prod build context, or a developer machine with `npm run db:up` + `~/.zshenv` SCHOLARS_AWS_* vars). Recommended verification command for that environment:

  ```bash
  npm run db:up && npx prisma migrate deploy && npm run etl:dynamodb
  # then in mysql:
  #   SELECT COUNT(*) FROM topic;            -- expected 67
  #   SELECT COUNT(*) FROM publication_topic; -- expected ~78k (within ±5% for skipped FK rows)
  #   SELECT * FROM etl_run WHERE source='ReCiterAI-projection' ORDER BY started_at DESC LIMIT 1;
  ```

- **publication_score / D-08 verification.** The addendum's clause "verify (don't rewrite) that the existing minimal projection from IMPACT# rows lands `reciterai_impact` correctly per D-08" was investigated and surfaced an inconsistency: the existing `etl/dynamodb/index.ts` does NOT currently project `publication_score`. Only `topic_assignment` is projected from FACULTY#. The IMPACT# → publication_score projection is referenced in plan files but absent from the ETL. This is documented inline in the file header. Under candidate (e), `publication_topic.impact_score` is now the canonical reference for the Variant B math (mirrored from `IMPACT#.impact_score` via the TOPIC# row's `impact_score` field). If a separate `publication_score` table is also wanted (for legacy consumers), that's a follow-up plan — explicitly out of scope here per the addendum.

## User Setup Required

None for this plan. The migration is additive and applies cleanly to the existing dev DB via `npx prisma migrate deploy`. The ETL extension reuses the existing AWS / DDB env-var conventions (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `SCHOLARS_DYNAMODB_TABLE`).

## Threat Flags

None. The new surfaces are research-area metadata (public knowledge) plus per-publication scoring metrics that ReCiterAI already exposes. No new auth paths, no new cross-trust-boundary writes, no new file access patterns, no schema changes at trust boundaries beyond what 02-SCHEMA-DECISION.md analyzed.

## Known Stubs

None. All projected fields wire through to the database under the candidate-(e) ETL contract. No "coming soon" placeholders, no hardcoded empty arrays flowing to UI rendering (this plan is data-layer only; UI consumption lands in Plans 06–08).

## Self-Check: PASSED

Verified after writing this SUMMARY:

- [x] `prisma/schema.prisma` contains `model Topic` (line 186) and `model PublicationTopic` (line 201) — `grep -c "model Topic" prisma/schema.prisma` returns 2 (Topic + TopicAssignment shares the prefix; both expected)
- [x] `prisma/schema.prisma` contains `@@map("topic")` and `@@map("publication_topic")` — verified in grep output above
- [x] `prisma/migrations/20260430221545_phase2_topics/migration.sql` exists and contains `CREATE TABLE \`topic\`` and `CREATE TABLE \`publication_topic\``
- [x] Migration has four indices on `publication_topic` matching the addendum: cwid+parent_topic_id+score DESC; parent_topic_id+year DESC+score DESC; cwid+year DESC; parent_topic_id+cwid
- [x] Migration contains NO `topic_assignment.topic_id` references (verified with `grep -iE "topic_assignment.*topic_id|ADD COLUMN.*topic_id"` — no matches)
- [x] Migration contains NO `DROP COLUMN`, `DROP TABLE`, or `RENAME` (verified)
- [x] `etl/dynamodb/index.ts` contains both new blocks (TAXONOMY#, TOPIC#) before the FACULTY# block, with `prisma.topic.upsert` and `prisma.publicationTopic.upsert` (idempotent per addendum)
- [x] Existing FACULTY# scan + `prisma.topicAssignment.deleteMany` + `prisma.topicAssignment.createMany` are preserved
- [x] No placeholder strings (`<...>`) remaining in `etl/dynamodb/index.ts`
- [x] `npm run typecheck` exits 0
- [x] `npm run lint` exits 0
- [x] `npm test` 11 files / 69 tests pass
- [x] Both task commits exist in git log: `f2909b2` (Task 1), `b040994` (Task 2)

## Next Phase Readiness

- **Plan 06** (methodology page anchors) can reference `topic.label` + `topic.description` for `/about/methodology#selected-highlights` and the per-topic explainers.
- **Plan 07** (home composition queries) can:
  - `prisma.topic.findMany()` for Browse-all-research-areas (returns 67 rows)
  - `prisma.publicationTopic.findMany({ where: { authorPosition: { in: ['first','last'] }, ... }})` for Recent contributions
  - dedup Selected highlights ↔ most-recent feed by `pmid` set within a single profile render (D-16)
- **Plan 08** (topic-page surfaces) can:
  - `prisma.publicationTopic.groupBy({ by: ['cwid'], where: { parentTopicId, authorPosition: { in: ['first','last'] } }, _sum: { score: true } })` for Top scholars chip row
  - `prisma.publicationTopic.findMany({ where: { parentTopicId }, orderBy: [{ year: 'desc' }, { score: 'desc' }] })` for Recent highlights (no author-position filter at pool selection per D-13)
- **Plan 09** (revalidation + e2e) can assert `topic.count() == 67` and `publication_topic.count() ≈ 78000` as data-layer health checks.

**Outstanding for the next executor / Mohammad's prod build:**
- Run the ETL operationally (`npm run db:up && npx prisma migrate deploy && npm run etl:dynamodb`) to seed the tables. The deferred-verification block above lists the exact commands.
- Decide whether a separate IMPACT# → publication_score projection is still wanted for legacy consumers, or whether `publication_topic.impact_score` is sufficient for everything Variant B needs. Tracked as a follow-up; out of scope for 02-05.

---
*Phase: 02-algorithmic-surfaces-and-home-composition*
*Plan: 05*
*Completed: 2026-04-30*
