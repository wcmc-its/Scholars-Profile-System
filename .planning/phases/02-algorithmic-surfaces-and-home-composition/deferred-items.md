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
