---
phase: 01-headshot-integration
plan: 01
subsystem: testing
tags: [tdd, red-phase, headshot, vitest, fixture]
type: execute
wave: 0
requirements: [HEADSHOT-01, HEADSHOT-02]
dependency-graph:
  requires: []
  provides:
    - "Failing test contract for lib/headshot.ts URL builder"
    - "Failing test contract for shared lib/utils#initials export"
    - "Failing test contract for components/scholar/headshot-avatar.tsx"
    - "Failing test contract for identityImageEndpoint on ScholarPayload, ProfilePayload, PeopleHit"
    - "Shared scholar fixture (FIXTURE_CWID, EXPECTED_HEADSHOT_BASE, EXPECTED_HEADSHOT_URL, fixtureScholar)"
  affects:
    - "Wave 1 plan 02 — must turn these RED tests GREEN by creating the missing modules and fields"
tech-stack:
  added: []
  patterns:
    - "vitest mocks of Prisma (vi.mock(\"@/lib/db\")) for serializer contract tests without DB"
    - "vitest mock of OpenSearch wrapper (vi.mock(\"@/lib/search\")) for hit-mapper contract test without a live cluster"
    - "Function-name fallback chain in tests so RED failure is on the contract assertion, not on a missing function name"
key-files:
  created:
    - "tests/fixtures/scholar.ts"
    - "tests/unit/headshot.test.ts"
    - "tests/unit/initials.test.ts"
    - "tests/unit/headshot-avatar.test.tsx"
    - "tests/unit/scholars-api.test.ts"
    - "tests/unit/profile-api.test.ts"
    - "tests/unit/search-api.test.ts"
  modified: []
decisions:
  - "Hardcode the default headshot URL in the fixture (env var unset). Future calibration of the URL template touches one file."
  - "Profile-api test uses a function-name fallback chain (getProfileByCwid ?? getProfileBySlug ?? getScholarFullProfileBySlug) so the RED failure is on the identityImageEndpoint assertion, not on a missing function. The current public function is getScholarFullProfileBySlug; Wave 1 must keep that name stable."
  - "Search-api test mocks @/lib/search (the wrapper) rather than @opensearch-project/opensearch directly, because that is the actual import surface of lib/api/search.ts."
  - "Type assertions used in scholars-api.test.ts and profile-api.test.ts ((payload as { identityImageEndpoint?: string })) so the test compiles today and fails at runtime on the missing field — never at TS compile time."
metrics:
  duration: "~3 minutes (Wave 0 is paper-thin scaffolding)"
  completed: "2026-04-30"
  tasks_completed: 7
  files_created: 7
---

# Phase 01 Plan 01: Wave 0 — RED Test Skeletons Summary

Wave 0 lays down the failing-test contract that Wave 1 implementations must satisfy: six RED test files plus one shared fixture that pin the headshot integration's observable surface (URL builder, component render states, three serializer fields, shared `initials` helper).

## Outcome

`npm test` produces a deterministic 6-RED / 4-GREEN pattern. The four pre-existing test files (`sanity`, `slug`, `ranking`, `url-resolver`) remain green at 44 passing tests. The six newly-added test files contribute 10 failing tests (plus 2 vite-import-resolution failures for files whose target modules do not yet exist). All failures are for the right reason — missing module, missing export, or missing field on the returned payload — not for syntax or compile errors in the test files.

## Files Added

| Path | Purpose | RED reason |
|------|---------|------------|
| `tests/fixtures/scholar.ts` | Shared `FIXTURE_CWID`, `EXPECTED_HEADSHOT_BASE`, `EXPECTED_HEADSHOT_URL`, `fixtureScholar` | n/a — fixture, no assertions |
| `tests/unit/headshot.test.ts` | Asserts `identityImageEndpoint(cwid)` produces the WCM directory URL with `returnGenericOn404=false` | `Failed to resolve import "@/lib/headshot"` |
| `tests/unit/initials.test.ts` | 6 cases pinning `initials()` behavior (two-word, lowercase, three+ words, single word, empty, repeated whitespace) | `(0 , initials) is not a function` — `@/lib/utils` does not export `initials` |
| `tests/unit/headshot-avatar.test.tsx` | 6 component-render cases pinning UI-SPEC `data-headshot-state` values + size-variant Tailwind classes + alt text | `Failed to resolve import "@/components/scholar/headshot-avatar"` |
| `tests/unit/scholars-api.test.ts` | Asserts `getScholarByCwid` payload includes `identityImageEndpoint` (string, not null) | `expected 'undefined' to be 'string'` — field absent on `ScholarPayload` |
| `tests/unit/profile-api.test.ts` | Asserts profile-payload getter includes `identityImageEndpoint` | `expected undefined to be 'https://directory.weill.cornell.edu/...'` — field absent on `ProfilePayload` |
| `tests/unit/search-api.test.ts` | Asserts each `PeopleHit` from `searchPeople` includes `identityImageEndpoint` | `expected undefined to be 'https://directory.weill.cornell.edu/...'` — field absent on `PeopleHit` |

## `npm test` Failure List (verbatim, post-Wave-0 baseline)

```
Test Files  6 failed | 4 passed (10)
     Tests  10 failed | 44 passed (54)

FAIL  tests/unit/headshot.test.ts
  Error: Failed to resolve import "@/lib/headshot"

FAIL  tests/unit/headshot-avatar.test.tsx
  Error: Failed to resolve import "@/components/scholar/headshot-avatar"

FAIL  tests/unit/initials.test.ts (6 tests | 6 failed)
  → (0 , initials) is not a function   (×6)

FAIL  tests/unit/scholars-api.test.ts (2 tests | 2 failed)
  > includes identityImageEndpoint in the payload — expected undefined to be EXPECTED_HEADSHOT_URL
  > identityImageEndpoint is a string (never null) — expected 'undefined' to be 'string'

FAIL  tests/unit/profile-api.test.ts (1 test | 1 failed)
  > includes identityImageEndpoint computed from CWID — expected undefined to be EXPECTED_HEADSHOT_URL

FAIL  tests/unit/search-api.test.ts (1 test | 1 failed)
  > each hit includes identityImageEndpoint computed from CWID — expected undefined to be EXPECTED_HEADSHOT_URL

PASS  tests/unit/ranking.test.ts (18 tests)
PASS  tests/unit/sanity.test.ts (2 tests)
PASS  tests/unit/slug.test.ts (14 tests)
PASS  tests/unit/url-resolver.test.ts (10 tests)
```

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Shared scholar fixture | `9bf1221` | `tests/fixtures/scholar.ts` |
| 2 | RED test for `lib/headshot` URL builder | `14531a7` | `tests/unit/headshot.test.ts` |
| 3 | RED tests for shared `initials` helper | `6879a90` | `tests/unit/initials.test.ts` |
| 4 | RED tests for `HeadshotAvatar` component | `a99a37c` | `tests/unit/headshot-avatar.test.tsx` |
| 5 | RED tests for `/api/scholars/:cwid` serializer | `7343841` | `tests/unit/scholars-api.test.ts` |
| 6 | RED tests for profile + search serializers | `129411c` | `tests/unit/profile-api.test.ts`, `tests/unit/search-api.test.ts` |
| 7 | Wave 0 sanity gate (no files) | n/a — gate task with no commits | n/a |

## Pre-existing GREEN Baseline (Confirmed Unchanged)

- `tests/unit/sanity.test.ts` — 2 tests
- `tests/unit/slug.test.ts` — 14 tests
- `tests/unit/ranking.test.ts` — 18 tests
- `tests/unit/url-resolver.test.ts` — 10 tests

Total: 44 passing tests. No green test became red.

## Deviations from Plan

None. Two minor framing notes (not behavioral deviations):

1. The plan's Task 6 profile test referenced `getProfileByCwid ?? getProfileBySlug` as the function-lookup chain; the actual public function in `lib/api/profile.ts` is `getScholarFullProfileBySlug`. The chain was extended to include that name so the test fails on the `identityImageEndpoint` assertion (the contract under test) rather than on a missing function lookup. This matches the plan's stated intent: "the existing public function returns a payload that now includes `identityImageEndpoint`."

2. The plan's Task 6 search-api test mocked `@opensearch-project/opensearch`. The actual import surface used by `lib/api/search.ts` is `@/lib/search` (the wrapper providing `searchClient`, `PEOPLE_INDEX`, `PEOPLE_FIELD_BOOSTS`, etc.). The test mocks the wrapper instead — this is the same pattern noted in the plan's tail comment ("If the OpenSearch client is initialized via a different module path … Wave 1 fixes the mock path; the assertion stays") applied at Wave 0 instead of deferred.

## Hand-off to Wave 1 Plan 02

Wave 1 plan 02 turns these RED tests GREEN by:

1. Creating `lib/headshot.ts` exporting `identityImageEndpoint(cwid: string): string` per `EXPECTED_HEADSHOT_URL` template.
2. Adding `initials(name: string): string` export to `lib/utils.ts` (extract verbatim from `app/(public)/scholars/[slug]/page.tsx:346`).
3. Creating `components/scholar/headshot-avatar.tsx` with the props `{ cwid, preferredName, identityImageEndpoint, size }`, emitting `data-headshot-state="loading" | "image" | "fallback"` and the documented size-variant Tailwind classes.
4. Adding `identityImageEndpoint: string` to the three payload types (`ScholarPayload`, `ProfilePayload`, `PeopleHit`) and computing it via `identityImageEndpoint(cwid)` in each serializer/mapper.
5. Keeping the existing public function names stable: `getScholarByCwid`, `getScholarFullProfileBySlug`, `searchPeople`. Renames will break the RED tests in this plan.

## Self-Check: PASSED

Self-check verifies the seven created files exist and the six commits are present in the worktree git log. See post-write verification block in the executing agent's transcript.
