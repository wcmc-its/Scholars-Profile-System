# Phase 2 Deferred Items

Out-of-scope issues discovered during plan execution that should be addressed in a follow-up plan.

## From Plan 02-03 (executor agent-ac3d7e5b471fe4951)

**Pre-existing typecheck errors** present on base commit `f89836e206d4fe57b7ca1a59bf699a5b74207f8b`, NOT introduced by this plan. Out of SCOPE BOUNDARY for 02-03. Files affected:

- `lib/api/profile.ts:251,252,265` — TS2322 `ScoredPublication<RankablePublication>` mismatch with `ProfilePublication[]` plus an implicit `any` parameter on line 265.
- `lib/api/scholars.ts:62` — implicit `any` on parameter `a`.
- `lib/db.ts:2` and `seed/publications.ts:11` — TS2307 cannot resolve `@/lib/generated/prisma/client` (Prisma client not generated in this fresh worktree).

These errors reproduce on the base commit before any 02-03 changes are applied. Plan 02-03 acceptance criteria require `npm run typecheck` to exit 0; that is achievable only after these pre-existing issues are resolved (likely by running `npx prisma generate` in the worktree and addressing the `lib/api/profile.ts` ranking-result-shape mismatch — independent work).

Recommendation: a Wave-0 follow-up to either run `prisma generate` as part of worktree bootstrap or fix the upstream `lib/api/profile.ts` typing before the next typecheck-gated plan executes.
