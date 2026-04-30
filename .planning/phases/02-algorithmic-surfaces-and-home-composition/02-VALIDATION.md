---
phase: 2
slug: algorithmic-surfaces-and-home-composition
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-30
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from `02-RESEARCH.md § Validation Architecture` and the Phase 2 D-13 / D-14 / D-15 / D-16 spec resolutions in CONTEXT.md.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3.0.2 + @testing-library/react 16.1.0 + Playwright 1.49.1 |
| **Config files** | `vitest.config.ts`, `playwright.config.ts` |
| **Quick run command** | `npm test` (Vitest unit suite) |
| **Full suite command** | `npm test && npm run test:e2e` |
| **Type check** | `npm run typecheck` |
| **Lint** | `npm run lint` |
| **Estimated unit runtime** | ~10–20 seconds (Vitest, JIT) |
| **Estimated full runtime** | ~60–120 seconds (Vitest + Playwright `home`/`topic`/`methodology` specs) |

---

## Sampling Rate

- **After every task commit:** `npm run typecheck && npm test -- <changed-test-file>` (< 30 seconds)
- **After every plan wave:** `npm test && npm run lint && npm run typecheck` (full unit + lint + typecheck)
- **Before `/gsd-verify-work`:** `npm test && npm run test:e2e && npm run lint && npm run typecheck` (all greens; visual review of home + topic against sketch 003 Variant D + sketch 004)
- **Max feedback latency:** 30 seconds for per-task; 120 seconds for phase gate.

---

## Per-Task Verification Map

> Filled in by gsd-planner once PLAN.md task IDs are assigned. The map below is the requirement-level expectation; planner translates each row into per-task automated commands.

| Req ID | Behavior | Test Type | Automated Command | File Exists | Status |
|--------|----------|-----------|-------------------|-------------|--------|
| RANKING-01 | Home Recent contributions selects 6 cards, first-or-senior, eligibility-carved (FT+Postdoc+Fellow+Doctoral), no citations, methodology link | unit + e2e | `vitest run tests/unit/home-api.test.ts` + `playwright test tests/e2e/home.spec.ts` | ❌ W0 | ⬜ pending |
| RANKING-01 (math) | `scorePublication` for `recent_contributions` curve matches worked example 3 (NEJM 14mo postdoc → 0.88) | unit | `vitest run tests/unit/ranking.test.ts` | ✅ exists; rewrite in W1 | ⬜ pending |
| RANKING-02 | Topic Recent highlights selects 3 cards, publication-centric pool, no citations | unit + e2e | `vitest run tests/unit/topic-api.test.ts` + `playwright test tests/e2e/topic-placeholder.spec.ts` | ❌ W0 | ⬜ pending |
| RANKING-03 | Topic Top scholars chip row: FT-faculty-only carve, per-scholar aggregation sums first-or-senior papers only, compressed Phase 2 recency curve (D-14), 7 chips | unit | `vitest run tests/unit/topic-api.test.ts` (assertion: `aggregateScholarScore` matches fixture sum + 2nd/penult/middle papers contribute 0 + non-FT scholars excluded) | ❌ W0 | ⬜ pending |
| HOME-02 | Selected research carousel shows 8 subtopic cards, one per parent area, weekly refresh, scroll-snap | unit + e2e | `vitest run tests/unit/home-api.test.ts` (parent-dedup assertion) + `playwright test tests/e2e/home.spec.ts` (8 cards visible, scroll-snap) | ❌ W0 | ⬜ pending |
| HOME-03 | Browse all research areas shows 67 parent topics with counts, 4-column grid | unit + e2e | `vitest run tests/unit/home-api.test.ts` (count == 67) + `playwright test tests/e2e/home.spec.ts` | ❌ W0 | ⬜ pending |
| Eligibility carve (RANKING-01) | `scholar.role_category` correctly populated for all 8,943+ active scholars (FT/Postdoc/Fellow/Doctoral) | unit (against ETL output) | `vitest run tests/unit/eligibility.test.ts` + manual SQL counts after ED ETL run | ❌ W0 | ⬜ pending |
| FT-faculty-only carve (RANKING-03 D-14) | Top scholars chip row excludes Postdoc / Fellow / Doctoral student rows | unit | `vitest run tests/unit/topic-api.test.ts` (assertion: chip row contains only `role_category = 'ft_faculty'`) | ❌ W0 | ⬜ pending |
| Sparse-state hide | `getRecentContributions` / `getTopScholars` / `getRecentHighlights` returns null when below floor; structured log emitted | unit | `vitest run tests/unit/home-api.test.ts` + `vitest run tests/unit/topic-api.test.ts` | ❌ W0 | ⬜ pending |
| Selected highlights / most-recent dedup (D-16) | Within a single profile-page render, papers in Selected highlights are filtered out of the most-recent feed | unit | `vitest run tests/unit/profile-api.test.ts` (assertion: `intersection(selected, mostRecent) == empty`) | ❌ W0 | ⬜ pending |
| Methodology anchors (RANKING-01/02/03 + HOME-02) | All four "How this works" links resolve to `/about/methodology#<id>` and the anchor exists in DOM (`#recent-contributions`, `#selected-research`, `#top-scholars`, `#recent-highlights`) | e2e | `playwright test tests/e2e/methodology.spec.ts` | ❌ W0 | ⬜ pending |
| Variant B worked example 1 (D-15 caveat) | Whitcomb Annals 2003 paper: synthesized fixture (paper not in real data due to 2020+ floor) returns Selected highlights score 0.46 | unit | `vitest run tests/unit/ranking.test.ts` | ❌ W0 (rewrite) | ⬜ pending |
| Variant B worked example 2 | Same paper Recent highlights score 0.37 | unit | `vitest run tests/unit/ranking.test.ts` | ❌ W0 (rewrite) | ⬜ pending |
| Variant B worked example 3 | NEJM 14mo postdoc Recent contributions score 0.88 | unit | `vitest run tests/unit/ranking.test.ts` | ❌ W0 (rewrite) | ⬜ pending |
| Top scholars compressed curve (D-14) | `recencyWeight(ageMonths, 'top_scholars')` returns 0.7 / 1.0 / 0.85 / 0.7 at the four bucket edges | unit | `vitest run tests/unit/ranking.test.ts` | ❌ W0 (rewrite) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/eligibility.test.ts` (NEW) — covers `role_category` derivation rule from ED + FTE + program code
- [ ] `tests/unit/home-api.test.ts` (NEW) — covers Recent contributions, Selected research, Browse grid query shape + sparse-state behavior
- [ ] `tests/unit/topic-api.test.ts` (NEW) — covers Top scholars aggregation (FT-only carve, first-or-senior filter, compressed curve) + Recent highlights
- [ ] `tests/unit/profile-api.test.ts` (MODIFY or NEW) — covers Selected highlights / most-recent dedup (D-16)
- [ ] `tests/fixtures/ranking-worked-examples.ts` (NEW) — three fixtures from `design-spec-v1.7.1.md:1150-1173`
- [ ] `tests/fixtures/topic-fixture.ts` (NEW) — synthetic topic + scholars (mixed roles) + publications (mixed authorship positions) for surface tests
- [ ] `tests/e2e/topic-placeholder.spec.ts` (NEW) — placeholder route renders Top scholars + Recent highlights
- [ ] `tests/e2e/methodology.spec.ts` (NEW) — anchors resolve from all four surfaces
- [ ] `tests/e2e/home.spec.ts` (MODIFY) — assertions for new sections (Recent contributions, Selected research carousel, Browse grid)
- [ ] `tests/unit/ranking.test.ts` (REWRITE) — Variant B worked examples replace Variant A unit tests; also covers four recency curves at bucket edges including the new `top_scholars` curve

*(Framework already installed; no `npm install` step needed.)*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual layout matches sketch 003 Variant D | HOME-02, HOME-03 | Pixel-level visual comparison; not amenable to DOM assertions alone | Side-by-side screenshot of `localhost:4321/` vs `.planning/sketches/003-home-landing/index.html`; verify hero, carousel scroll-snap, Browse grid 4-col |
| Visual layout matches sketch 004 (Topic placeholder) | RANKING-02, RANKING-03 | Same as above | Side-by-side screenshot of `localhost:4321/topics/<slug>` vs `.planning/sketches/004-topic-detail/index.html` (Phase 2 placeholder layout only — full layout B is Phase 3) |
| Mobile responsive collapse | All Phase 2 success criteria | Touch-event behavior + viewport-driven media queries | Manual viewport resize in browser devtools (375px / 768px / 1024px); confirm Recent contributions 3×2 → 1-col, carousel still scroll-snaps, Browse grid 4 → 2 → 1 col |
| Sparse-state hide on a real low-data scholar | RANKING-01, RANKING-03 | Real-data verification — pick a scholar with <3 first-or-senior recent papers in a topic and confirm section is hidden, not 5xx'd | Manual SQL identifies a low-data scholar/topic combo; visit page; confirm component absent + structured log line emitted |
| ETL completion → on-demand revalidation flow | RANKING-01 (cadence; ADR-005 / ADR-008) | Cross-process timing; Playwright doesn't observe ETL trigger naturally | Trigger a manual ETL run; confirm `/api/revalidate` is called for `/`, `/scholars/[changed-cwids]`, `/topics/[changed-slugs]`; reload home page and confirm new content within 30s |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (9 test/fixture files identified above)
- [ ] No watch-mode flags (CI-safe `vitest run` not `vitest`)
- [ ] Feedback latency < 30s per-task / < 120s phase gate
- [ ] `nyquist_compliant: true` set in frontmatter once planner finalizes per-task assignments

**Approval:** pending
