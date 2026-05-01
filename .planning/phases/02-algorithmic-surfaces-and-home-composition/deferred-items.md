# Phase 2 — Deferred Items

Out-of-scope issues discovered during plan execution. To be addressed in a follow-up plan.

## Pre-existing typecheck errors (discovered independently by 02-02 and 02-03)

`npm run typecheck` reports ~37 errors on the base commit `f89836e` — present BEFORE any Wave 1 plan executed, NOT introduced by 02-02, 02-03, or 02-04. Out of SCOPE BOUNDARY for those plans per execute-plan rules ("Only auto-fix issues DIRECTLY caused by the current task's changes. Pre-existing warnings, linting errors, or failures in unrelated files are out of scope").

Files affected:

- **`lib/api/profile.ts`** — multiple errors:
  - lines 251, 252: TS2322 `ScoredPublication<RankablePublication>` mismatch with `ProfilePublication[]`
  - line 265: implicit `any` (TS7006) on parameter
  - additional TS2339 missing-property + TS2322 assignability errors
- **`lib/api/scholars.ts:62`** — TS7006 implicit `any` on parameter `a`
- **`lib/db.ts:2`** — TS2307 cannot resolve `@/lib/generated/prisma/client`
- **`seed/publications.ts:11`** — TS2307 same as above
- **`etl/dynamodb/index.ts`** — TS7006 implicit any

**Likely root cause:** Prisma generated client artifacts missing (`@/lib/generated/prisma/client` path unresolved). `prisma generate` was not run in the worktrees; the module path may need to track Prisma 7's client-output location after the upgrade locked by ADR-006.

**Recommended follow-up:** A small Wave-0-style plan that either:
1. Adds a `prisma generate` step to worktree bootstrap (CI step or pre-execute hook), OR
2. Updates the import path to match Prisma 7's current client output, OR
3. Fixes the upstream `lib/api/profile.ts` ranking-result-shape mismatch independently.

This becomes a typecheck-gated blocker for any future plan whose acceptance criteria include `npm run typecheck` exit 0 across the full repo. Plans that ran in Wave 1 worked around it by typechecking only modified files in isolation.

## ~~PublicationTopic.pmid ↔ Publication.pmid type mismatch~~ — RESOLVED 2026-04-30

**Resolved.** Reconciled `PublicationTopic.pmid` from `Int @db.UnsignedInt` to `String @db.VarChar(32)` matching `Publication.pmid`, added `@relation` between the two models, added `publication_topic_pmid_fkey` FK to the migration SQL, updated ETL to stringify DDB's numeric pmid, and unwound the two-step query stitches in `lib/api/home.ts` and `lib/api/topics.ts` to use `include: { publication }` directly. All 99 unit tests + lint + typecheck still pass. Test fixtures updated to nest the publication payload inside `publicationTopic` row mocks.

The migration file was edited in place (rather than stacking a follow-up) because no environment had yet applied it — live ETL run was deferred per 02-05 SUMMARY.

Original entry below for archive:

## ~~PublicationTopic.pmid ↔ Publication.pmid type mismatch~~ (discovered by 02-07 and 02-08)

`PublicationTopic.pmid` is `Int @db.UnsignedInt` (mirroring DDB's numeric `pmid` field on `TOPIC#` rows). `Publication.pmid` is `String @id` (existing convention). These cannot share a Prisma FK relation, so the natural query pattern `prisma.publicationTopic.findMany({ include: { publication: true } })` fails typecheck.

Both 02-07 (home composition) and 02-08 (topic-page surfaces) worked around this with a **two-step query stitch**:

```typescript
const ptRows = await prisma.publicationTopic.findMany({ where: { ... }, include: { scholar: true, topic: true } });
const pmids = [...new Set(ptRows.map(r => String(r.pmid)))];
const pubs = await prisma.publication.findMany({ where: { pmid: { in: pmids }, type: { notIn: EXCLUDED_PUB_TYPES } } });
const pubByPmid = new Map(pubs.map(p => [p.pmid, p]));
// stitch app-side
```

**Functionally correct.** All 99 unit tests pass. The hard-excluded-pub-type filter (Letter / Editorial / Erratum) gets applied at the publication query rather than in the same WHERE clause as the publication_topic filter — same effect, marginally less efficient at the database layer (the planner can't push the type filter into a single query plan).

**Recommended follow-up:** A small migration plan that reconciles the type. Two options:

1. **Change `PublicationTopic.pmid` to `String`** to match `Publication.pmid`. Requires re-running the ETL with stringification, plus a migration that ALTERs the column. Adds an actual `@relation` to `Publication`. Cleanest long-term.
2. **Change `Publication.pmid` to `Int`.** PMIDs ARE integers in PubMed source data; the existing `String` typing is a legacy choice. Requires touching every consumer of `Publication.pmid` (search index ETL, profile API, scholars API, etc.) — bigger blast radius.

Recommend option (1) — narrower scope, only `publication_topic` is affected. Future plan should also add the `@relation` so `include: { publication }` works directly, eliminating the two-step stitch in `lib/api/home.ts` and `lib/api/topics.ts`.

Until reconciled, the two-step stitch pattern is the canonical approach for any new query that needs both `publication_topic` and `publication` data. Document this in any future plan addendum that surfaces this query shape.
