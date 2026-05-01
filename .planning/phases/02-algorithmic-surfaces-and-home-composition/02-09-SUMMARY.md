---
phase: 02-algorithmic-surfaces-and-home-composition
plan: 09
status: complete
completed: 2026-04-30
---

# Plan 02-09 — Revalidation route + ETL orchestrator wiring

## What was built

Wave 4 integration loop. Built `app/api/revalidate/route.ts` (token-gated POST endpoint that accepts a `?path=` query and calls Next.js `revalidatePath()`) and wired it into `etl/orchestrate.ts` so the daily ETL run keeps Phase 2's ISR-rendered surfaces (home page, topic pages) fresh after each refresh cycle.

Closes the integration loop opened by ADR-008 (ISR with on-demand revalidation): data flowing in via the daily DDB+ED+ASMS+InfoEd+ReCiter+COI ETL cascade now causes the corresponding rendered pages to invalidate without waiting for the 6h ISR TTL.

## Tasks completed

| Task | Name | Commit |
|------|------|--------|
| 1a (RED) | Failing tests for `/api/revalidate` (12 cases) | `7b4a445` |
| 1b (GREEN) | Implement `/api/revalidate` POST route with token auth | `7c1e54e` |
| 2 | Wire orchestrator to call `/api/revalidate` after OpenSearch reindex (post-checkpoint approval) | `c1c9b34` |

## Key decisions confirmed at the human-verify checkpoint

1. **Topic slug = `Topic.id`** — Plan body's example used `t.slug`, but the candidate-(e) schema defines `Topic.id` AS the slug (`prisma/schema.prisma`). No `Topic.slug` field exists. Used `t.id` accordingly. Rule 1 fix.
2. **Per-scholar `/scholars/{slug}` revalidation deferred** — Wiring 8,943 per-CWID HTTP calls into the orchestrator daily is wasteful when most profiles are unchanged on any given day. Source-system ETLs that touch individual scholar records will own per-scholar revalidation in a future phase. ISR 6h TTL is the Phase 2 fallback for stale scholar caches.
3. **All 67 topics on every daily run** — Cheap (67 calls, sub-second), simple, no change-detection complexity. Phase 6 can optimize to changed-only if monitoring shows the call rate matters.

## Surfaces revalidated after each daily ETL run

| Path | Source | Notes |
|------|--------|-------|
| `/` | always | Home page (HOME-02 + HOME-03 + RANKING-01) |
| `/topics/{slug}` × 67 | enumerated from `topic` table | RANKING-02 + RANKING-03 placeholder route per D-10 |
| `/scholars/{slug}` | NOT wired here | Deferred to per-source ETL refactor |
| `/about/methodology` | NOT wired | Static (`dynamic = "force-static"`); revalidate only on content change (out of band) |

## Threat-model adherence

- **T-02-09-01 (unauthenticated revalidation):** Mitigated. `/api/revalidate` requires `x-revalidate-token` header matching `process.env.SCHOLARS_REVALIDATE_TOKEN`; returns 401 on mismatch. Token never logged.
- **T-02-09-05 (silent fetch failure):** Mitigated. Orchestrator's `revalidatePath` helper warns via `console.warn` on token-unset / non-2xx / network throw and never re-throws. ISR 6h TTL is the eventual fallback per ADR-008.
- **T-02-09-06 (production token unset):** Mitigated. Orchestrator logs `[Revalidate] SCHOLARS_REVALIDATE_TOKEN unset; skipping ${p}` and skips the call rather than failing the ETL.

## Verification gates

- `npm test` — 12 new revalidate-route tests pass; full suite passes
- `npm run typecheck` — modified files clean in isolation; pre-existing repo-wide errors documented in `deferred-items.md`
- `npm run lint` — clean on all changed files
- Acceptance grep gates all satisfied (`SCHOLARS_REVALIDATE_TOKEN`, `/api/revalidate`, `revalidatePath('/')`, topic enumeration)

## Deviations

1. **`Topic.id` instead of `Topic.slug`** — Rule 1 fix, confirmed at checkpoint. Plan body's example referenced a non-existent field; candidate-(e) schema uses `id` as the slug.
2. **Per-scholar revalidation scope** — Plan body left this open; checkpoint confirmed deferral to a future per-source ETL refactor.

## Self-Check: PASSED

- Route exists, token-gated, iterates all paths in request
- Orchestrator wired in `main()` after OpenSearch reindex, before `summarize()`
- All three checkpoint questions answered and recorded above
- 12 new unit tests pass
- No modifications to STATE.md or ROADMAP.md
- Best-effort failure mode preserves ETL run on revalidate failures

## Files

| File | Status |
|------|--------|
| `app/api/revalidate/route.ts` | new |
| `tests/unit/revalidate-route.test.ts` | new (12 cases) |
| `etl/orchestrate.ts` | modified (helper + Step 4) |
| `.planning/phases/02-algorithmic-surfaces-and-home-composition/02-09-SUMMARY.md` | new (this file) |

## Commits

| SHA | Subject |
|-----|---------|
| `7b4a445` | test(02-09): add failing tests for /api/revalidate route |
| `7c1e54e` | feat(02-09): implement /api/revalidate POST route |
| `c1c9b34` | feat(02-09): wire ISR revalidation into ETL orchestrator |
| (this commit) | docs(02-09): summary for revalidation route + orchestrator wiring plan |
