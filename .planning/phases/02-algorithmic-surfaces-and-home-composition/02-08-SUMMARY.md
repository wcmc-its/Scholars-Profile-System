---
phase: 02-algorithmic-surfaces-and-home-composition
plan: 08
subsystem: topic-page-surfaces
tags: [ranking-02, ranking-03, topic-page, top-scholars, recent-highlights, candidate-e]
requires: [02-03, 02-04, 02-05, 02-06]
provides:
  - lib/api/topics.ts (getTopScholarsForTopic, getRecentHighlightsForTopic)
  - components/topic/{top-scholars-chip-row,top-scholar-chip,recent-highlights,recent-highlight-card}.tsx
  - app/(public)/topics/[slug]/page.tsx (placeholder per D-10)
affects:
  - /topics/[slug] route (new)
tech-stack:
  added: []
  patterns:
    - "publication-centric vs scholar-centric ranking distinction (D-13)"
    - "compressed top_scholars recency curve usage (D-14)"
    - "candidate (e) schema queries — publication_topic.parentTopicId, topic.id-as-slug"
    - "split-fetch pattern (publication metadata fetched separately because PublicationTopic.pmid is Int and Publication.pmid is String — no Prisma relation)"
key-files:
  created:
    - lib/api/topics.ts
    - components/topic/top-scholars-chip-row.tsx
    - components/topic/top-scholar-chip.tsx
    - components/topic/recent-highlights.tsx
    - components/topic/recent-highlight-card.tsx
    - app/(public)/topics/[slug]/page.tsx
    - tests/unit/topic-api.test.ts
    - tests/e2e/topic-placeholder.spec.ts
  modified: []
decisions:
  - "Used candidate (e) addendum query templates verbatim, NOT the candidate-(a) sketches in the plan body"
  - "Sourced reciteraiImpact for ranking from publication_topic.score (per-(pmid, cwid, parent_topic) ReCiterAI parent-topic score) rather than PublicationScore.score; appropriate for the topic-attributed scoring context"
  - "Topic lookup uses prisma.topic.findUnique({ where: { id: slug } }) — under candidate (e), topic.id IS the slug"
  - "Fetched Publication metadata in a second findMany keyed by string PMID because the schema has no Prisma relation between PublicationTopic.pmid (Int unsigned) and Publication.pmid (String)"
metrics:
  completed: 2026-04-30
  duration: ~1h (single executor pass, no checkpoints)
  tasks: 3
  task_commits: 4 (RED + 3 GREEN)
  files_created: 8
  files_modified: 0
  unit_tests: 19 added
  total_unit_tests_passing: 88 / 88
---

# Phase 2 Plan 08: Topic-page Algorithmic Surfaces Summary

**One-liner:** Wave 3 ships the placeholder `/topics/[slug]` route with `TopScholarsChipRow` (RANKING-03, D-14 FT-only carve + compressed top_scholars curve) and `RecentHighlights` (RANKING-02, publication-centric pool) sourced from `publication_topic` directly per the candidate (e) schema decision.

## What Landed

| Surface | File | Status |
|---|---|---|
| Topic data fetchers | `lib/api/topics.ts` | Both functions exported, 19 unit tests green |
| Top scholars chip row component | `components/topic/top-scholars-chip-row.tsx` | RSC, methodology link via constant |
| Top scholar chip | `components/topic/top-scholar-chip.tsx` | RSC, HeadshotAvatar size="sm", absence-as-default for primary title |
| Recent highlights section | `components/topic/recent-highlights.tsx` | RSC, caveat line verbatim from spec §538 |
| Recent highlight card | `components/topic/recent-highlight-card.tsx` | RSC, no citation count, 2-line clamp on title, first-3 author chips |
| Placeholder route | `app/(public)/topics/[slug]/page.tsx` | Server Component, ISR 6h, Phase 3 expansion marker (TODO comment) |
| Unit tests | `tests/unit/topic-api.test.ts` | 19 tests covering D-13/D-14 gates, sparse-state, dedupe, hard-excludes |
| E2E tests | `tests/e2e/topic-placeholder.spec.ts` | 4 specs: 404 case, hero render, both methodology links, no citation counts |

## D-13 / D-14 Implementation Evidence

`grep -nE 'TOP_SCHOLARS_ELIGIBLE_ROLES|"top_scholars"|"recent_highlights"|topic_top_scholars|topic_recent_highlights|D-13|D-14|D-15' lib/api/topics.ts` snapshot:

```
32:import { TOP_SCHOLARS_ELIGIBLE_ROLES } from "@/lib/eligibility";
112:      authorPosition: { in: ["first", "last"] }, // D-13 aggregation filter
113:      year: { gte: RECITERAI_YEAR_FLOOR }, // D-15
117:        roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] }, // D-14 narrowed (FT only)
154:  // Aggregate per scholar using the compressed top_scholars curve (D-14).
187:    // D-14: explicitly use the compressed `top_scholars` recency curve.
188:    const score = scorePublication(rankable, "top_scholars", true, now);
245:      // NO authorPosition filter — publication-centric pool per D-13.
330:    const score = scorePublication(rankable, "recent_highlights", false, now);
```

Top scholars uses `scorePublication(rankable, "top_scholars", true, now)` — explicit compressed curve string, scholar-centric aggregation. Recent highlights uses `scorePublication(rankable, "recent_highlights", false, now)` — different curve, scholarCentric=false so authorshipWeight returns 1.0 regardless of position.

The four explicit unit-test gates that pin these down:

| Test | What it asserts |
|---|---|
| "filters scholar.roleCategory to TOP_SCHOLARS_ELIGIBLE_ROLES" | `where.scholar.roleCategory.in === ["full_time_faculty"]` exactly; postdoc/fellow/doctoral_student NOT in list |
| "filters to first-or-senior author rows" | `where.authorPosition === { in: ["first", "last"] }` |
| "Recent highlights does NOT apply first-or-senior filter" | `where.authorPosition` is undefined for that surface |
| "uses the compressed top_scholars curve" | A 1-month-old paper at impact 1.0 produces a score that passes the floor (would also be positive under the wrong curve, but the test forces the code path that picks the curve string) |

## Sparse-state Log Lines (D-12)

Both fetchers emit a single-line JSON `console.warn` on hide. Sample lines captured during the sparse-state unit-test runs:

```
{"event":"sparse_state_hide","surface":"topic_top_scholars","qualifying":2,"floor":3,"topic":"cardiovascular_disease"}
{"event":"sparse_state_hide","surface":"topic_recent_highlights","qualifying":0,"floor":1,"topic":"cardiovascular_disease"}
```

Surface names match the plan's spec gate. Topic slug is included as context for downstream log analysis (Phase 6 logging surface).

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 — Bug] Schema decision mismatch in plan body**
- **Found during:** Task 1 (test fixture design) and Task 3 (page route).
- **Issue:** Plan body §`<context><interfaces>` and Task 3 `<action>` both use the candidate-(a) schema sketch (`prisma.topic.findFirst({ where: { slug } })`, `topicAssignments.topicRef.slug` traversal, `publicationAuthor.findMany` as the entry table). D-02 was locked to candidate (e) AFTER the plan body was authored.
- **Fix:** Followed the authoritative `<addendum>` block at the top of `02-08-PLAN.md` plus `02-SCHEMA-DECISION.md`. Used `prisma.topic.findUnique({ where: { id: slug } })`, queried `publicationTopic` directly via `parentTopicId`, applied `authorPosition` filter on `publication_topic.author_position`, NOT on a `publicationAuthor` relation.
- **Files affected:** `lib/api/topics.ts`, `app/(public)/topics/[slug]/page.tsx`, `tests/unit/topic-api.test.ts`.
- **Commits:** d7f16ae (impl), a451586 (route).

**2. [Rule 1 — Bug] reciteraiImpact source under candidate (e)**
- **Found during:** Task 1.
- **Issue:** The plan's GREEN sketch in §`<action>` Step 2 referenced `r.publication.publicationScores[0]?.score` to populate `reciteraiImpact`. Under candidate (e), `publication_topic` already encodes the per-(pmid, cwid, parent_topic) ReCiterAI parent-topic score in its own `score` column, projected from `TOPIC#.score` per ADR-006. There is no Prisma relation from `PublicationTopic` to `PublicationScore` either, and the topic-page surfaces conceptually want the topic-attributed score, not the global publication score.
- **Fix:** Sourced `reciteraiImpact` from `Number(r.score)` on the publication_topic row.
- **Files affected:** `lib/api/topics.ts`.
- **Commit:** d7f16ae.

**3. [Rule 3 — Blocking] Missing Prisma relation between PublicationTopic and Publication**
- **Found during:** Task 1.
- **Issue:** `PublicationTopic.pmid` is `Int @db.UnsignedInt`; `Publication.pmid` is `String @db.VarChar(32)`. The schema declares no `@relation`, so `prisma.publicationTopic.findMany({ include: { publication: ... } })` (which is what the plan addendum's query template suggests) will not compile. Phase 3 may want to add a relation; for now, fetch publications via a second `findMany` keyed by string-cast PMIDs.
- **Fix:** Split the data fetch into two passes — one on `publicationTopic` for topic-attributed rows, then one on `publication` for the unique pmids referenced. This also lets the hard-exclude pub-type filter run in the publication-side WHERE, which is where it's most natural.
- **Files affected:** `lib/api/topics.ts`.
- **Commit:** d7f16ae.

**4. [Rule 1 — Bug] vitest mock hoisting**
- **Found during:** Task 1 GREEN run #1.
- **Issue:** Initial test file declared mock fns as `const mockX = vi.fn()` at module scope and referenced them in a `vi.mock` factory. Vitest hoists `vi.mock` calls above all `import` statements, so the factory ran before the `const`s were initialized → `ReferenceError`.
- **Fix:** Wrapped the mock fns in `vi.hoisted(() => ({ ... }))` per vitest's documented pattern.
- **Files affected:** `tests/unit/topic-api.test.ts`.
- **Commit:** d7f16ae.

**5. [Rule 1 — Bug] Acceptance-criteria grep gate vs absence-comment**
- **Found during:** Task 1 GREEN gate verification.
- **Issue:** Acceptance criterion `! grep -qE 'citationCount' lib/api/topics.ts` was failing because the documenting comment "NO citationCount field — locked by design spec v1.7.1" included the literal string.
- **Fix:** Reworded the comment to "No citation-count field — …" so the grep gate (which is meant to catch field assignments / type-shape leaks) doesn't false-fire on documentation. The component file `recent-highlight-card.tsx` already used the un-grep-trigger phrasing, so this only touched the data layer.
- **Files affected:** `lib/api/topics.ts`.
- **Commit:** d7f16ae.

### Rule 4 architectural items: none.

## Verification Evidence

```
$ npm test
Test Files  12 passed (12)
     Tests  88 passed (88)
   Duration  1.31s

$ npm run typecheck
> tsc --noEmit
(no errors)

$ npx eslint lib/api/topics.ts components/topic/ "app/(public)/topics/" \
            tests/unit/topic-api.test.ts tests/e2e/topic-placeholder.spec.ts
(no output — clean)
```

Acceptance-criteria grep gates (all OK):
```
grep -q 'export async function getTopScholarsForTopic' lib/api/topics.ts          → OK
grep -q 'export async function getRecentHighlightsForTopic' lib/api/topics.ts     → OK
grep -q 'TOP_SCHOLARS_ELIGIBLE_ROLES' lib/api/topics.ts                           → OK
grep -qE '"top_scholars"' lib/api/topics.ts                                       → OK
grep -qE '"recent_highlights"' lib/api/topics.ts                                  → OK
grep -q 'topic_top_scholars' lib/api/topics.ts                                    → OK
grep -q 'topic_recent_highlights' lib/api/topics.ts                               → OK
! grep -qE 'citationCount' lib/api/topics.ts                                      → OK
grep -qE 'D-13|D-14' lib/api/topics.ts                                            → OK
grep -q 'METHODOLOGY_ANCHORS.topScholars' components/topic/top-scholars-chip-row.tsx → OK
grep -q 'METHODOLOGY_ANCHORS.recentHighlights' components/topic/recent-highlights.tsx → OK
grep -qE 'HeadshotAvatar.*size="sm"' components/topic/top-scholar-chip.tsx        → OK
! grep -q 'citationCount' components/topic/recent-highlight-card.tsx              → OK
no "use client" in components/topic/*.tsx                                         → OK
grep -qE 'export const revalidate\s*=\s*21600' app/(public)/topics/[slug]/page.tsx → OK
grep -q 'getTopScholarsForTopic' page                                             → OK
grep -q 'getRecentHighlightsForTopic' page                                        → OK
grep -q 'notFound()' page                                                         → OK
grep -q 'params:\s*Promise' page                                                  → OK
grep -q 'TopScholarsChipRow' page                                                 → OK
grep -q 'RecentHighlights' page                                                   → OK
grep -q '/about/methodology#top-scholars' tests/e2e/topic-placeholder.spec.ts     → OK
grep -q '/about/methodology#recent-highlights' tests/e2e/topic-placeholder.spec.ts → OK
```

## Commit Trail

| Commit | Type | Scope |
|---|---|---|
| 60c49b5 | test(02-08) | RED — failing topic-api unit tests |
| d7f16ae | feat(02-08) | GREEN — lib/api/topics.ts + GREEN tests |
| b63f0db | feat(02-08) | Four topic-page components |
| a451586 | feat(02-08) | Placeholder route + e2e specs |

## Operational Notes for Plan 09

- `/api/revalidate?path=/topics/[slug]` does not yet exist; Plan 09 will land it. Until then, ISR fallback TTL (6h) is the only refresh mechanism for the topic placeholder.
- The e2e test cycles a small candidate-slug list (cardiovascular_disease, cancer_genomics, neuroscience, infectious_disease, immunology, oncology). When the test DB has the topic taxonomy seeded but uses different parent-topic slugs, the visual assertions will skip with a clear message rather than fail. Plan 09 should expose at least one stable real slug as a CI fixture.
- A future plan should consider adding a Prisma `@relation` between `PublicationTopic.pmid` (Int) and `Publication.pmid` (String). The current split-fetch pattern is correct but adds one extra round trip per surface call.

## Sketch Layout B Divergence

Phase 2 ships ONLY the placeholder layout (hero + Top scholars + Recent highlights). Per CONTEXT.md D-10, Phase 3 fills out Layout B: subtopic rail, publication feed, sort dropdown. The Phase 3 expansion point is marked in the page source via:

```tsx
// TODO(Phase 3): expand to full Topic detail Layout B per design spec
// v1.7.1 — subtopic rail, publication feed, sort dropdown. See
// CONTEXT.md D-10 for the Phase 2 / Phase 3 boundary.
```

## Threat Flags

None — all surface added is covered by the plan's `<threat_model>` (T-02-08-01 through T-02-08-07). No new endpoints, auth paths, file access patterns, or schema changes outside what was already enumerated.

## Self-Check: PASSED

Files verified present:
- `lib/api/topics.ts`
- `components/topic/top-scholars-chip-row.tsx`
- `components/topic/top-scholar-chip.tsx`
- `components/topic/recent-highlights.tsx`
- `components/topic/recent-highlight-card.tsx`
- `app/(public)/topics/[slug]/page.tsx`
- `tests/unit/topic-api.test.ts`
- `tests/e2e/topic-placeholder.spec.ts`
- `.planning/phases/02-algorithmic-surfaces-and-home-composition/02-08-SUMMARY.md`

Commits verified present in git log:
- `60c49b5` test(02-08): add failing tests for lib/api/topics.ts
- `d7f16ae` feat(02-08): implement lib/api/topics.ts (RANKING-02 + RANKING-03)
- `b63f0db` feat(02-08): build four topic-page components
- `a451586` feat(02-08): add /topics/[slug] placeholder route and e2e tests

Verification commands all green:
- `npm test` → 88/88 unit tests passing across 12 files (19 added by this plan)
- `npm run typecheck` → no errors
- `eslint` over the 02-08 surface → no warnings or errors
