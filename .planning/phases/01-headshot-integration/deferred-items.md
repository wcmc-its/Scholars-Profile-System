# Deferred Items — Phase 01 Headshot Integration

## Pre-existing tsc errors (not caused by 01-02 plan)

Discovered during 01-02 plan Task 2 verification. These errors exist on master at base commit `81cd257` and are unrelated to headshot integration:

- `lib/api/profile.ts:167,186,192,216,217,220,224,230,238,242,250,251,264` — implicit any params, missing fields on appointment type, ScoredPublication ↔ ProfilePublication mismatch
- `lib/api/scholars.ts:59` — implicit any param
- `lib/db.ts:2` — missing `@/lib/generated/prisma/client` module
- `seed/publications.ts:11` — missing `@/lib/generated/prisma/client` module

Out of scope for headshot integration. Should be addressed in a separate maintenance plan.

## Plan 01 RED test files

This worktree was branched from base `81cd257`, before plan 01 (Wave 0) outputs were merged. The plan-01-required RED tests for `tests/unit/scholars-api.test.ts`, `tests/unit/profile-api.test.ts`, `tests/unit/search-api.test.ts`, and `tests/fixtures/scholar.ts` were not present and were not created by 01-02. The RED tests for `tests/unit/headshot.test.ts`, `tests/unit/initials.test.ts`, and `tests/unit/headshot-avatar.test.tsx` were created during 01-02 execution under deviation Rule 3 (blocking dependency) so the TDD cycle could complete. Orchestrator merge of 01-01's worktree should reconcile any duplicates.
