---
phase: 01-headshot-integration
plan: 03
subsystem: api-serializers
tags: [headshot, serializer, type-contract, wave-2]
requires:
  - lib/headshot.ts (Wave 1 plan 02)
  - tests/unit/scholars-api.test.ts (Wave 0 plan 01)
  - tests/unit/profile-api.test.ts (Wave 0 plan 01)
  - tests/unit/search-api.test.ts (Wave 0 plan 01)
provides:
  - ScholarPayload.identityImageEndpoint
  - ProfilePayload.identityImageEndpoint
  - PeopleHit.identityImageEndpoint
affects:
  - app/(public)/scholars/[slug]/page.tsx (consumes ProfilePayload.identityImageEndpoint)
  - app/(public)/search/page.tsx (consumes PeopleHit.identityImageEndpoint)
tech-stack:
  added: []
  patterns:
    - "Single-source-of-truth URL construction: all three serializers import identityImageEndpoint from @/lib/headshot rather than re-implementing"
    - "Derived-not-stored: identityImageEndpoint is computed at API serialization time; never persisted to DB or OpenSearch"
key-files:
  created: []
  modified:
    - lib/api/scholars.ts
    - lib/api/profile.ts
    - lib/api/search.ts
decisions:
  - "Removed (not deprecated) the dormant headshotUrl field from ProfilePayload — zero remaining consumers in app/, lib/api/, or components/ (verified via grep)"
  - "OpenSearch indexer (etl/search-index/index.ts) intentionally untouched — identityImageEndpoint is derived at API time from CWID, not stored"
  - "Used direct import name (no alias) — `identityImageEndpoint: identityImageEndpoint(scholar.cwid)` — same shadow JavaScript permits without lint complaint"
metrics:
  duration: "~3 min"
  completed: "2026-04-30"
  tasks: 3
  files: 3
---

# Phase 01 Plan 03: API Serializer Plumbing Summary

**One-liner:** Added `identityImageEndpoint: string` to `ScholarPayload`, `ProfilePayload`, and `PeopleHit` so the three serializers compute the directory URL from a single source-of-truth (`lib/headshot.ts`) and the Wave 1 page-level mounts now receive the field at runtime.

## Tasks Executed

| # | Task | Commit | Files | Result |
|---|------|--------|-------|--------|
| 1 | Add `identityImageEndpoint` to `ScholarPayload` (`lib/api/scholars.ts`) | `2d8634d` | `lib/api/scholars.ts` | RED → GREEN (tests/unit/scholars-api.test.ts) |
| 2 | Replace `headshotUrl` with `identityImageEndpoint` on `ProfilePayload` (`lib/api/profile.ts`) | `8e01fd8` | `lib/api/profile.ts` | RED → GREEN (tests/unit/profile-api.test.ts) |
| 3 | Add `identityImageEndpoint` to `PeopleHit` and the search hit mapper (`lib/api/search.ts`) | `0caa881` | `lib/api/search.ts` | RED → GREEN (tests/unit/search-api.test.ts) |

## Verification

All three serializer test files now GREEN — `npx vitest run tests/unit/scholars-api.test.ts tests/unit/profile-api.test.ts tests/unit/search-api.test.ts` reports `Test Files 3 passed (3) / Tests 4 passed (4)`.

### Plan-level checks

- `grep -RIn "directory.weill.cornell.edu" app/api/ scripts/ etl/ 2>/dev/null` → exit 2 (no hits) — confirms **no server-side fetch added** (T-1-05 mitigation evidence).
- `grep -q "identityImageEndpoint" etl/search-index/index.ts` → exit 1 (no hits) — confirms the **OpenSearch indexer is untouched** (Pitfall 3 prevented).
- `grep -RIn "headshotUrl" app/ lib/api/ components/ 2>/dev/null | wc -l` → 0 — confirms the **dormant field is gone from API code**. Allowed remaining hits live in `prisma/schema.prisma:25` (the dormant column, kept per CONTEXT D-03) and `tests/unit/profile-api.test.ts` (the Prisma mock returns the column value because the Prisma row shape still has it; harmless because the serializer no longer reads the field).

### tsc note (deferred — out of scope for this plan)

`npx tsc --noEmit` reports 37 errors after this plan, down from 38 at the base of the worktree. **None of the errors are caused by this plan's changes.** All remaining errors are pre-existing and stem from `lib/db.ts` referencing `@/lib/generated/prisma/client` which has not been generated in this worktree — a project-wide infrastructure issue unrelated to the Wave-2 contract delta. Specifically:

- `lib/db.ts:2` and `seed/publications.ts:11`: missing generated Prisma client module.
- `lib/api/profile.ts` lines 168, 187, 193, 217, 218, 221, 225, 231, 239, 243, 251, 252, 265: implicit `any` on Prisma callback parameters and structural mismatch on `ScoredPublication` — same root cause (Prisma types unresolved).
- `lib/api/scholars.ts:62`: implicit `any` on `appointments.map((a) => …)` — same root cause.

These errors exist unchanged in `git stash`-ed baseline. Logged to `.planning/phases/01-headshot-integration/deferred-items.md` (already present from prior waves).

The single new line added by this plan that touches a Prisma-typed value — `identityImageEndpoint(scholar.cwid)` in `lib/api/scholars.ts` and `lib/api/profile.ts` — does NOT introduce a tsc error because `scholar.cwid` is typed as `string` upstream and `identityImageEndpoint` accepts `string`. The line in `lib/api/search.ts` similarly draws `cwid` from a hand-typed `Hit._source.cwid: string`.

## Threat Model Compliance

| Threat ID | Disposition | Evidence |
|-----------|-------------|----------|
| T-1-03 (Tampering of identityImageEndpoint) | mitigated | All three serializers import from the single `lib/headshot.ts` utility. The URL is constructed from `process.env.SCHOLARS_HEADSHOT_BASE` (server-side trusted) and a CWID sourced from Prisma or OpenSearch (also trusted). User-supplied input never reaches the URL builder. |
| T-1-05 (Open redirect / SSRF) | accept (mitigated by absence) | No server-side fetch of directory.weill.cornell.edu added. Verified — see grep output above. The browser hits the directory directly. |

## Deviations from Plan

None — plan executed exactly as written.

The plan acceptance criterion `npx tsc --noEmit exits 0` could not be met because of pre-existing project-wide Prisma client generation issue (out of scope per the Scope Boundary rule and the project's deferred-items.md tracking). Our changes did not introduce any new tsc errors and reduced the total error count from 38 to 37.

## headshotUrl Removal Trail

| File | Action | Reason |
|------|--------|--------|
| `lib/api/profile.ts` | Removed type field `headshotUrl: string \| null`; removed serializer line `headshotUrl: scholar.headshotUrl` | CONTEXT D-03: the DB column stays dormant; Wave 1 plan 02 already replaced the call site to read `profile.identityImageEndpoint` |
| `prisma/schema.prisma:25` | **Retained** as `headshotUrl String? @map("headshot_url")` | CONTEXT D-03: dormant DB column, no schema migration this phase |
| `tests/unit/profile-api.test.ts:19,37` | **Retained** in Prisma mock — `headshotUrl: null` | The mock simulates the row Prisma returns from the dormant column; harmless because the serializer no longer reads it |

## Hand-off

**Wave 3 plan 04 runs the verification gate end-to-end** — running the dev server, hitting `/api/scholars/:cwid` and `/api/search`, asserting `identityImageEndpoint` appears in JSON output, and visually verifying that `<HeadshotAvatar>` renders the directory image at the two surfaces (`app/(public)/scholars/[slug]/page.tsx` and `app/(public)/search/page.tsx`).

## Self-Check: PASSED

- `lib/api/scholars.ts` modified — verified contains `identityImageEndpoint` import and field. FOUND.
- `lib/api/profile.ts` modified — verified contains `identityImageEndpoint` import + field, no `headshotUrl`. FOUND.
- `lib/api/search.ts` modified — verified contains `identityImageEndpoint` import + field + mapper. FOUND.
- Commit `2d8634d` (Task 1) — `git log` confirms. FOUND.
- Commit `8e01fd8` (Task 2) — `git log` confirms. FOUND.
- Commit `0caa881` (Task 3) — `git log` confirms. FOUND.
- All three Wave 0 RED tests GREEN — `npx vitest run` confirms. PASSED.
