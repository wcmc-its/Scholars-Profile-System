---
phase: 02-algorithmic-surfaces-and-home-composition
plan: 04
subsystem: ranking
tags: [ranking, variant-b, recency-curves, vitest, prisma, profile-api]

# Dependency graph
requires:
  - phase: 01-headshot-integration
    provides: profile page render path that consumes ranking output
provides:
  - Variant B publication-scoring module (lib/ranking.ts) with four surface-keyed recency curves
  - scorePublication + aggregateScholarScore primitives for Plans 07 and 08
  - reciteraiImpact join wired through profile API serializer
  - D-16 dedup applied between Selected highlights and most-recent feed
  - tests/fixtures/ranking-worked-examples.ts — three worked examples from spec for downstream test reuse
affects: [02-07-recent-contributions, 02-08-top-scholars, 02-09-recent-highlights, 02-06-methodology, profile-page-render]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Surface-keyed recency curves as a Record<RecencyCurve, (m) => number> step-function table"
    - "Multiplicative formula factored into single scorePublication(p, curve, scholarCentric, now)"
    - "scholarCentric boolean controls authorship filter (D-13/D-14) without branching the formula"
    - "Per-scholar aggregation via reduce-summation over per-publication scores; filter-not-down-weight for non-first/senior authors"
    - "Prisma include filtered by scholar.cwid to pull per-scholar PublicationScore rows alongside the main publication join"
    - "D-16 dedup via Set<pmid> shared between two ranked lists in the same render"

key-files:
  created:
    - tests/fixtures/ranking-worked-examples.ts
  modified:
    - lib/ranking.ts
    - tests/unit/ranking.test.ts
    - lib/api/profile.ts

key-decisions:
  - "rankForRecentFeed reuses the recent_contributions curve (not selected_highlights) because the profile most-recent-papers feed is a recency-sorted view of first/senior-author work; selected_highlights peaks at 18mo–10yr which would over-weight older work in a feed meant to surface recent contributions. Documented inline + on the methodology page footnote (Plan 06)."
  - "top_scholars curve is its own step function (0.7 / 1.0 / 0.85 / 0.7), explicitly NOT aliased to recent_highlights — protected by JSDoc comment and a unit test that asserts recencyWeight(1, 'top_scholars') !== recencyWeight(1, 'recent_highlights')"
  - "ProfilePublication retains citationCount as display-only (publications still show citation counts on the profile) while the ranking path consumes reciteraiImpact exclusively"
  - "publicationScores include uses where: { cwid: scholar.cwid } — the (cwid, pmid) unique constraint guarantees at most one row per publication, and ?? 0 fallback handles the pre-2020 ReCiterAI floor (D-15)"

patterns-established:
  - "Pure-function ranking module: no Prisma, no React, no I/O — clock injectable via now parameter for determinism in tests"
  - "Worked-example fixtures match the per-publication scoring fn one-for-one — adding a new curve in the future is a fixture + curve table edit, not a structural change"
  - "Plans 07 and 08 import scorePublication / aggregateScholarScore directly; no need to duplicate the formula at the surface layer"

requirements-completed: [RANKING-01, RANKING-02, RANKING-03]

# Metrics
duration: ~14 min
completed: 2026-04-30
---

# Phase 2 Plan 04: Variant B publication ranking + profile retrofit

**Variant A additive scoring replaced with Variant B multiplicative `reciterai_impact × authorship_weight × pub_type_weight × recency_weight`, four distinct surface-keyed recency curves, and D-16 dedup between Selected highlights and most-recent feed.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-04-30T20:42:51Z
- **Completed:** 2026-04-30T20:57:00Z
- **Tasks:** 3
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- `lib/ranking.ts` rewritten end-to-end. Variant A exports (`authorshipPoints`, `typePoints`, `impactPoints`, `recencyScore`, `rankForHighlights`, `rankForRecent`) all removed. New API: `scorePublication`, `aggregateScholarScore`, `authorshipWeight`, `pubTypeWeight`, `recencyWeight`, plus four surface wrappers (`rankForSelectedHighlights`, `rankForRecentFeed`, `rankForRecentContributions`, `rankForRecentHighlights`).
- Four distinct surface-keyed recency curves wired and unit-tested at every bucket edge. The compressed `top_scholars` curve from CONTEXT.md D-14 is its own step function (NOT aliased to `recent_highlights`) and a regression test guards the divergence at 1mo (0.7 vs 0.4).
- Three worked examples from `design-spec-v1.7.1.md:1150-1173` codified as fixtures in `tests/fixtures/ranking-worked-examples.ts` and asserted to two decimal places: Whitcomb 2003 Annals as Selected highlight (0.46), same paper as Recent highlight (0.37), 14mo NEJM postdoc as Recent contribution (0.88).
- `lib/api/profile.ts` retrofitted: imports the new ranking exports, extends the Prisma include with `publicationScores: { where: { cwid: scholar.cwid } }`, populates `reciteraiImpact` on the rankable shape with `?? 0` fallback for pre-2020 papers (D-15), applies D-16 dedup so a paper that ranks high enough to enter Selected highlights cannot also appear in the most-recent feed within the same render.
- All 65 unit tests pass; `npm run typecheck` and `npm run lint` exit clean.

## Task Commits

Each task was committed atomically with `--no-verify`:

1. **Task 1 (RED): variant B ranking test scaffold** — `d5aa315` (test)
2. **Task 2 (GREEN): variant B ranking implementation** — `f464183` (feat)
3. **Task 3: retrofit profile.ts to Variant B + D-16 dedup** — `2bcdf84` (refactor)

## Files Created/Modified

- `lib/ranking.ts` — Replaced Variant A additive scoring with Variant B multiplicative formula, four surface-keyed recency curves, scholar-centric vs. publication-centric authorship handling, surface wrappers
- `tests/fixtures/ranking-worked-examples.ts` *(new)* — `WORKED_EXAMPLES` const exporting three worked-example pairs `{ input: RankablePublication, expected: number }` and a `NOW` reference date
- `tests/unit/ranking.test.ts` — Rewritten for Variant B; 20 test cases covering worked examples, all four recency curves at bucket edges, authorship filter, pub-type hard-exclusion, aggregation, default curve, and confirmation gating
- `lib/api/profile.ts` — Imports updated, `publicationScores` Prisma include, `reciteraiImpact` populated on rankable shape, `highlightPmids` Set drives D-16 dedup, `ProfilePublication` type carries `reciteraiImpact` alongside display-only `citationCount`

## Decisions Made

1. **`rankForRecentFeed` reuses the `recent_contributions` curve (not `selected_highlights`).** The profile most-recent-papers feed is a recency-sorted view of the scholar's first/senior-author work; the `selected_highlights` curve peaks at 18mo–10yr, which would over-weight older work in a feed whose intent is recent contributions. The `recent_contributions` curve peaks at 6–18 months — the right shape. This is a fifth call site of the curve beyond the four spec-defined surfaces; documented inline at `lib/ranking.ts:rankForRecentFeed` and to be cross-referenced on the methodology page (Plan 06).

2. **`top_scholars` is a distinct step function, not an alias.** The compressed Phase 2 D-14 curve (0.7 / 1.0 / 0.85 / 0.7) lives as its own arrow function under `RECENCY_CURVES.top_scholars`. A unit test asserts `recencyWeight(1, "top_scholars") !== recencyWeight(1, "recent_highlights")` (0.7 vs 0.4) so future curve edits cannot silently re-alias them.

3. **`citationCount` retained on `ProfilePublication` as display-only.** Variant B does not consume citation counts in the ranking path, but the profile page still shows them on each publication card. The type carries both `citationCount` (display) and `reciteraiImpact` (ranking input).

4. **`?? 0` fallback for missing PublicationScore rows handles the D-15 pre-2020 floor naturally.** Papers from before 2020 won't have a `publication_score.score` row; their `reciteraiImpact` evaluates to 0; the multiplicative formula then yields 0; those papers drop out of Selected highlights but remain visible in the most-recent feed (which sorts by recency-curve × other factors and still scores them, just at the floor of the dataset). No special-casing required.

## Deviations from Plan

**None — plan executed exactly as written.**

The Task 2 acceptance criteria included `npm run typecheck` exits 0. On entry, the worktree didn't have the Prisma generated client materialized (`lib/generated/prisma/` is gitignored and was absent). I ran `npx prisma generate` before re-running typecheck — this is a build-cache reconstitution, not a code change, and produced no new tracked files. After generation, `npm run typecheck` exits 0 cleanly.

## Issues Encountered

- **Pre-existing `lib/generated/prisma/` absence in the worktree.** The Prisma client wasn't generated when the agent started. Running `npx prisma generate` once produced the generated directory (gitignored, no commit) and unblocked typecheck. Pre-existing condition, not a deviation.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Wave 3 plans (07, 08, 09) can import `scorePublication` and `aggregateScholarScore`** directly from `@/lib/ranking`. The four surface curves are wired; the pub-type hard-exclusion and authorship filter are baked in; the worked-example fixtures are ready for surface-level integration tests to cite.
- **Plan 06 (methodology page) needs to footnote the deliberate `rankForRecentFeed` curve choice** (the "fifth call site" of `recent_contributions`) so the divergence from the four spec-defined surfaces is transparent.
- **No blockers.** Profile page renders against real data; section presence preserved (Selected highlights up to 3, recent feed populated, dedup applied). Rankings will reorder papers vs. pre-Variant-A baseline — that is the expected outcome of switching formulas.

## Self-Check: PASSED

**Files:**
- `lib/ranking.ts` — FOUND, 242 lines, exports verified (`grep -c '^export' lib/ranking.ts` → 13)
- `tests/fixtures/ranking-worked-examples.ts` — FOUND, exports `NOW`, `WORKED_EXAMPLES`, three named worked-example consts
- `tests/unit/ranking.test.ts` — FOUND, 20 test cases (`npx vitest run tests/unit/ranking.test.ts` → 20 passed)
- `lib/api/profile.ts` — FOUND, all four required strings present (`rankForSelectedHighlights`, `rankForRecentFeed`, `publicationScores`, `reciteraiImpact`, `highlightPmids`, `!highlightPmids.has`)

**Commits:**
- `d5aa315` — FOUND in `git log`
- `f464183` — FOUND in `git log`
- `2bcdf84` — FOUND in `git log`

**Test run:** `npx vitest run tests/unit/ranking.test.ts` →
```
Test Files  1 passed (1)
     Tests  20 passed (20)
```

**Full unit suite:** `npx vitest run tests/unit/` →
```
Test Files  10 passed (10)
     Tests  65 passed (65)
```

**Typecheck:** `npm run typecheck` → exits 0
**Lint:** `npm run lint -- lib/api/profile.ts lib/ranking.ts tests/unit/ranking.test.ts tests/fixtures/ranking-worked-examples.ts` → exits 0

**Acceptance grep gates** (Tasks 2 + 3):
- `grep -q 'export function scorePublication' lib/ranking.ts` ✓
- `grep -q 'export function aggregateScholarScore' lib/ranking.ts` ✓
- `grep -q 'export function authorshipWeight' lib/ranking.ts` ✓
- `grep -q 'export function pubTypeWeight' lib/ranking.ts` ✓
- `grep -q 'export function recencyWeight' lib/ranking.ts` ✓
- `grep -q 'export function rankForSelectedHighlights' lib/ranking.ts` ✓
- `grep -q 'export function rankForRecentFeed' lib/ranking.ts` ✓
- `grep -q 'export function rankForRecentContributions' lib/ranking.ts` ✓
- `grep -q 'export function rankForRecentHighlights' lib/ranking.ts` ✓
- `! grep -qE 'export function (authorshipPoints|impactPoints|recencyScore|typePoints)\b' lib/ranking.ts` ✓ (Variant A removed)
- `! grep -qE 'export function rankForHighlights\b' lib/ranking.ts` ✓ (note word boundary; rankForSelectedHighlights is a different export)
- `! grep -qE 'export function rankForRecent\b' lib/ranking.ts` ✓
- `! grep -qE 'citationCount' lib/ranking.ts` ✓
- `! grep -qE 'import.*prisma' lib/ranking.ts` ✓ (pure module)
- `grep -q 'rankForSelectedHighlights' lib/api/profile.ts` ✓
- `grep -q 'rankForRecentFeed' lib/api/profile.ts` ✓
- `grep -q 'publicationScores' lib/api/profile.ts` ✓
- `grep -q 'reciteraiImpact' lib/api/profile.ts` ✓
- `grep -q 'highlightPmids' lib/api/profile.ts` ✓
- `grep -qE '!highlightPmids\.has' lib/api/profile.ts` ✓
- `! grep -qE 'rankForHighlights\b' lib/api/profile.ts` ✓
- `! grep -qE '\brankForRecent\b' lib/api/profile.ts` ✓

---
*Phase: 02-algorithmic-surfaces-and-home-composition*
*Completed: 2026-04-30*
