# Phase 2 — Deferred items (out of scope for current plan)

## Pre-existing typecheck errors (37 total) — discovered during 02-02

`npm run typecheck` reports 37 errors across:
- `lib/api/profile.ts` (multiple TS7006 implicit-any + TS2339 missing-property + TS2322 assignability errors)
- `lib/api/scholars.ts` (TS7006)
- `lib/db.ts` (TS2307: Cannot find module `@/lib/generated/prisma/client`)
- `seed/publications.ts` (TS2307: same)
- `etl/dynamodb/index.ts` (TS7006)

All errors are in files NOT modified by 02-02. The probe script `etl/dynamodb/probe.ts` produces zero typecheck errors.

Per SCOPE BOUNDARY in execute-plan workflow ("Only auto-fix issues DIRECTLY caused by the current task's changes. Pre-existing warnings, linting errors, or failures in unrelated files are out of scope"), these are not blockers for plan 02-02.

Likely root cause: stale Prisma generated-client artifacts (`@/lib/generated/prisma/client` missing) — `prisma generate` was probably not run in this worktree. A future plan should add a `prisma generate` step or the module path needs updating to match the current Prisma 7 client output.
