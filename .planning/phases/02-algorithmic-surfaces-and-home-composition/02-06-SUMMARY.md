---
phase: 02-algorithmic-surfaces-and-home-composition
plan: 06
subsystem: methodology-page
tags: [methodology, anchors, static-page, ssg, playwright, e2e]

# Dependency graph
requires:
  - phase: 02-algorithmic-surfaces-and-home-composition
    plan: 01
    provides: design tokens (Charter font, Slate accent) + (public) layout chrome
  - phase: 02-algorithmic-surfaces-and-home-composition
    plan: 04
    provides: surface-keyed recency curves whose names anchor the methodology copy
provides:
  - "lib/methodology-anchors.ts: METHODOLOGY_ANCHORS + METHODOLOGY_BASE constants — single source of truth consumed by Plans 07/08 surface components"
  - "/about/methodology static SSG page with four anchor sections deeplinked from algorithmic surfaces"
  - "/about stub linking to /about/methodology (Phase 4 expands)"
  - "tests/e2e/methodology.spec.ts: 6-test Playwright suite — H1 + 4 anchor visibility + /about link"
affects: [02-07-recent-contributions, 02-08-top-scholars-recent-highlights, future-Phase-4-about]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure constants module (no I/O, no React) as single source of truth for cross-page anchor IDs — closes RESEARCH.md Pitfall 6"
    - "Static SSG pages via `export const dynamic = 'force-static'; export const revalidate = false;` — built once, served from edge cache, no per-request work"
    - "Anchor section IDs sourced via `id={METHODOLOGY_ANCHORS.recentContributions}` (not hardcoded strings) so the e2e test detects drift"
    - "Per-anchor parameterized e2e: `for (const [key, id] of Object.entries(METHODOLOGY_ANCHORS))` — adding an anchor automatically adds a test"

key-files:
  created:
    - lib/methodology-anchors.ts
    - app/(public)/about/methodology/page.tsx
    - app/(public)/about/page.tsx
    - tests/e2e/methodology.spec.ts
  modified: []

key-decisions:
  - "Anchor IDs locked verbatim per CONTEXT.md D-04: 'recent-contributions', 'selected-research', 'top-scholars', 'recent-highlights' — kebab-case, surface-aligned. Camel-case keys (recentContributions, selectedResearch, topScholars, recentHighlights) for ergonomic TypeScript access."
  - "Methodology page stays at `/about/methodology` permanently. Phase 4's `/about` rebuild expands the stub but does NOT touch the methodology URL — the four surface deeplinks point here forever."
  - "5th call site of recent_contributions curve (rankForRecentFeed in profile most-recent-papers feed) documented explicitly in calibration footer, not buried — Plan 04 SUMMARY's deliberate-reuse rationale is now end-user-visible."
  - "All four CONTEXT.md decisions (D-09 co-corresponding limitation, D-14 Top scholars override, D-15 2020+ floor, D-16 dedup) are documented on-page in plain English — not just in `.planning/`."
  - "About stub uses Slate accent (`text-[var(--color-accent-slate)]`) for the methodology link — Cornell Big Red reserved for high-prominence moments per design spec v1.7.1."

patterns-established:
  - "Phase 2 static-prose page pattern: force-static export, max-w-[720px] mx-auto px-6 py-10, font-serif text-4xl semibold H1, text-lg semibold H2 sections"
  - "Single-source-of-truth constants modules for cross-page IDs — pattern applies anywhere page A renders an anchor that page B deeplinks to"
  - "Per-anchor parameterized Playwright tests: iterating Object.entries() of the constants object means adding a future anchor needs zero test edits"

requirements-completed: [RANKING-01, RANKING-02, RANKING-03, HOME-02]

# Metrics
duration: ~3 min
completed: 2026-04-30
---

# Phase 2 Plan 06: Methodology page + anchor constants

**Static `/about/methodology` page with four anchor sections referenced by every Phase 2 algorithmic surface, plus `lib/methodology-anchors.ts` as single source of truth so surface components and the methodology page cannot drift (RESEARCH.md Pitfall 6 closed).**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-04-30T22:15:26Z
- **Completed:** 2026-04-30T22:18:00Z
- **Tasks:** 3
- **Files created:** 4 (1 lib module, 2 pages, 1 e2e spec)

## Accomplishments

- `lib/methodology-anchors.ts` exports `METHODOLOGY_ANCHORS` (frozen object with the four locked kebab-case anchor IDs from CONTEXT.md D-04), `METHODOLOGY_BASE = "/about/methodology"`, and `methodologyHref(anchor)` helper. Pure constants — no I/O, no React, no Prisma imports. Plans 07/08 can `import { METHODOLOGY_BASE, METHODOLOGY_ANCHORS, methodologyHref } from "@/lib/methodology-anchors"` to wire surface "How this works" links to real anchors.
- `/about/methodology` SSG page renders the H1 "How algorithmic surfaces work" (Charter serif at 44px) and four `<section>` elements with `id={METHODOLOGY_ANCHORS.<key>}` (NOT hardcoded). Plain-English explanation for each surface — Recent contributions, Selected research, Top scholars, Recent highlights — covering the formula, eligibility carves, recency curves, and hard-exclusions. Calibration footer documents the six-month post-launch review.
- Documents all four CONTEXT.md decisions on-page in user-facing prose: D-09 (co-corresponding author limitation), D-14 (Top scholars FT-faculty-only override + compressed recency curve), D-15 (2020+ data floor for Selected highlights), D-16 (Selected/most-recent dedup behavior).
- Documents the **5th call site** of the `recent_contributions` curve (Plan 04 deliberate decision: `rankForRecentFeed` reuses this curve for the profile most-recent-papers feed). Footnoted in the calibration section explicitly so the divergence from the four spec-defined surfaces is transparent — not buried.
- `/about` stub page (D-05) ships as a 3-line placeholder: H1 + paragraph linking to `/about/methodology` with Slate accent (`text-[var(--color-accent-slate)]`). Phase 4 expands `/about` itself; `/about/methodology` stays at the same URL.
- `tests/e2e/methodology.spec.ts` — 6 Playwright tests, all passing operationally against the dev server: 1 H1 assertion + 4 parameterized per-anchor visibility checks (iterates `Object.entries(METHODOLOGY_ANCHORS)`) + 1 `/about` stub link assertion. Adding a future anchor will auto-add a test row.

## Task Commits

Each task was committed atomically with `--no-verify`:

1. **Task 1: methodology-anchors constants module** — `8db7100` (feat)
2. **Task 2: /about/methodology page + /about stub** — `58b1580` (feat)
3. **Task 3: Playwright e2e methodology suite** — `2aa89d9` (test)

## Files Created/Modified

- `lib/methodology-anchors.ts` *(new, 22 lines)* — `METHODOLOGY_ANCHORS` const-as-const with four kebab-case anchor IDs, `METHODOLOGY_BASE`, `methodologyHref()` helper
- `app/(public)/about/methodology/page.tsx` *(new, 138 lines)* — Static prose page with four `<section>` anchor blocks + co-corresponding limitation note + calibration footer
- `app/(public)/about/page.tsx` *(new, 26 lines)* — Stub linking to /about/methodology with Slate accent
- `tests/e2e/methodology.spec.ts` *(new, 33 lines)* — 6-test Playwright suite (H1 + 4 anchors + /about stub link)

## Decisions Made

1. **Camel-case keys, kebab-case values for METHODOLOGY_ANCHORS.** TypeScript-ergonomic property access (`METHODOLOGY_ANCHORS.recentContributions`) returns the URL-safe value (`"recent-contributions"`). Both shapes are locked: keys consumed by surface components, values consumed by browser navigation.

2. **The methodology page is a Server Component with `force-static` + `revalidate = false`.** Pure SSG — no data fetch, no per-request work, served from edge cache. The threat-register entry T-02-06-05 (DoS via cache thrash) is mitigated structurally.

3. **5th call site documented in the calibration footer, not in a hidden footnote.** Plan 04's decision to reuse the `recent_contributions` curve for `rankForRecentFeed` (profile most-recent-papers feed) is a deliberate engineering choice — the methodology page surfaces it in user-readable prose so a curious reader sees the same explanation that lives in `lib/ranking.ts`. This was the success criterion the orchestrator flagged ("must footnote this 5th call site explicitly").

4. **D-09 co-corresponding-author limitation gets its own H2 section.** Not buried in a footnote — full-time researchers reading this page may have co-corresponding authorships that surface with weight 0, and they need to see the gap acknowledged.

5. **`/about` stub uses Slate, not Cornell Red, for the methodology link.** Per design spec v1.7.1: Cornell Big Red `#B31B1B` is reserved for high-prominence moments (top header band, primary CTAs); Slate `#2c4f6e` is the working accent for everything else. Inline links count as "everything else."

## Deviations from Plan

**None — plan executed exactly as written.**

(One environment fixup, not a deviation: the worktree did not have `lib/generated/prisma/` materialized on entry, which is gitignored. Ran `npx prisma generate` once to unblock typecheck. Same condition Plan 04's executor noted; pre-existing, no code change.)

## Issues Encountered

- **Pre-existing absence of `lib/generated/prisma/` in fresh worktree.** Same as 02-04. Resolved with `npx prisma generate`. Not a code issue, not a commit-affecting change.

## User Setup Required

None — the methodology page is fully static and the e2e tests run against the auto-spawned Playwright `webServer`.

## Next Phase Readiness

- **Plans 07 and 08 (Wave 3)** can now import from `@/lib/methodology-anchors` and wire surface "How this works" links to real anchors. The methodology page exists, all four anchor IDs resolve, and a regression test catches drift.
- **No blockers.** Surface implementations land against a real page, not a TODO.
- **Phase 4 follow-up:** When the `/about` page is expanded with team / mission / contact sections, the existing `/about/methodology` URL stays exactly as-is. Per CONTEXT.md D-04, the methodology page is a Phase 2 deliverable that survives Phase 4 unchanged.

## Self-Check: PASSED

**Files:**
- `lib/methodology-anchors.ts` — FOUND, 22 lines, exports verified (METHODOLOGY_ANCHORS, METHODOLOGY_BASE, methodologyHref)
- `app/(public)/about/methodology/page.tsx` — FOUND, 138 lines, all four anchor IDs sourced from constants, all four CONTEXT.md decisions documented
- `app/(public)/about/page.tsx` — FOUND, 26 lines, links to /about/methodology with Slate accent
- `tests/e2e/methodology.spec.ts` — FOUND, 33 lines, 6 tests defined

**Commits:**
- `8db7100` — FOUND in `git log` (Task 1)
- `58b1580` — FOUND in `git log` (Task 2)
- `2aa89d9` — FOUND in `git log` (Task 3)

**Test runs:**
- `npm test` (vitest) → `Test Files 11 passed (11), Tests 69 passed (69)` (no regressions in existing unit suite)
- `npx playwright test tests/e2e/methodology.spec.ts` → `6 passed (6.2s)` — H1 assertion + 4 anchor visibility tests + /about stub link test

**Typecheck:** `npm run typecheck` → exits 0
**Lint:** `npm run lint -- "app/(public)/about/" "lib/methodology-anchors.ts" "tests/e2e/methodology.spec.ts"` → exits 0

**Acceptance grep gates (Tasks 1-3):**
- Task 1: `grep -q 'export const METHODOLOGY_ANCHORS' lib/methodology-anchors.ts` ✓
- Task 1: `grep -q 'export const METHODOLOGY_BASE' lib/methodology-anchors.ts` ✓
- Task 1: All four anchor key/value pairs present (recentContributions/selectedResearch/topScholars/recentHighlights) ✓
- Task 1: METHODOLOGY_BASE = "/about/methodology" exact match ✓
- Task 1: No prisma/react imports ✓
- Task 2: `grep -q "force-static"` both pages ✓
- Task 2: All four `id={METHODOLOGY_ANCHORS.<key>}` patterns present ✓
- Task 2: D-14 ("full-time faculty only"), D-15 ("2020"), D-16 ("filtered out of the most-recent"), six-month review, co-corresponding, recent_contributions all grep-match ✓
- Task 3: METHODOLOGY_ANCHORS imported ✓
- Task 3: page.goto for both /about/methodology and /about ✓
- Task 3: H1 text + toBeVisible assertions ✓

---
*Phase: 02-algorithmic-surfaces-and-home-composition*
*Completed: 2026-04-30*
