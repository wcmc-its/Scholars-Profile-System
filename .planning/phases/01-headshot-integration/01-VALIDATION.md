---
phase: 1
slug: headshot-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-30
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. See `01-RESEARCH.md` "Validation Architecture" for full Nyquist mapping.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (per Next.js 15 + TS strict standard) |
| **Config file** | `vitest.config.ts` (Wave 0 installs if absent) |
| **Quick run command** | `npx vitest run --reporter=basic` |
| **Full suite command** | `npx vitest run && npx tsc --noEmit && npx next build` |
| **Estimated runtime** | ~30s quick, ~2min full |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=basic`
- **After every plan wave:** Run full suite (`vitest run && tsc --noEmit && next build`)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30s for quick, 120s for full

---

## Per-Task Verification Map

> Final task IDs land in PLAN.md. The map below describes the verification contract per success criterion (SC) and is populated against task IDs by the planner.

| Concern | Requirement | Test Type | Automated Command |
|---------|-------------|-----------|-------------------|
| `<HeadshotAvatar>` renders directory `<img>` for valid CWID | HEADSHOT-01 | unit (vitest + @testing-library/react) | `npx vitest run components/scholar/headshot-avatar.test.tsx` |
| `<HeadshotAvatar>` renders fallback initials when image errors (Radix native fallback) | HEADSHOT-01 | unit | `npx vitest run components/scholar/headshot-avatar.test.tsx -t "fallback"` |
| `<HeadshotAvatar>` emits `data-headshot-state` attribute (`loaded`/`error`/`loading`) | render-log spec | unit | `npx vitest run components/scholar/headshot-avatar.test.tsx -t "data-headshot-state"` |
| `lib/headshot.ts` constructs URL `https://directory.weill.cornell.edu/api/v1/person/profile/{cwid}.png?returnGenericOn404=false` | HEADSHOT-01 | unit | `npx vitest run lib/headshot.test.ts` |
| `/api/scholars/:cwid` response includes `identityImageEndpoint` string field | HEADSHOT-02 (SC 4) | integration | `npx vitest run app/api/scholars/[cwid]/route.test.ts` |
| Search hit mapper (`lib/api/search.ts`) emits `identityImageEndpoint` on each `PeopleHit` | HEADSHOT-02 | integration | `npx vitest run lib/api/search.test.ts` |
| Profile serializer (`lib/api/profile.ts`) emits `identityImageEndpoint` for ISR pages | HEADSHOT-02 | integration | `npx vitest run lib/api/profile.test.ts` |
| `next.config.ts` whitelists `directory.weill.cornell.edu` in `images.remotePatterns` | infra | config | `node -e "const c=require('./next.config.ts'); /* assert remotePatterns contains directory host */"` (or grep-test) |
| Profile sidebar surface mounts `<HeadshotAvatar size="lg">` | SC 1 | RTL render | `npx vitest run app/(public)/scholars/[slug]/page.test.tsx` |
| Search result row mounts `<HeadshotAvatar size="sm">` | SC 2 | RTL render | `npx vitest run app/(public)/search/page.test.tsx` |
| Recent contributions card mounts `<HeadshotAvatar>` | SC 3 | RTL render | `npx vitest run app/(public)/page.test.tsx -t "recent contributions"` |
| Top scholars chip mounts `<HeadshotAvatar size="xs">` | SC 3 | RTL render | `npx vitest run app/(public)/topics/[slug]/page.test.tsx -t "top scholars"` |
| `initials()` extracted to `lib/utils.ts` (no duplicates remain) | refactor | unit | `npx vitest run lib/utils.test.ts && grep -RIn "function initials" app/ | grep -v lib/utils.ts` returns no app-layer hits |
| No server-side proxy or ETL pre-fetch added (browser-direct only) | SC 5 | static | `! grep -RIn "directory.weill.cornell.edu" app/api/ scripts/ etl/ 2>/dev/null \| grep -v identityImageEndpoint` |

*Status convention (planner fills): ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest.config.ts` + `vitest-setup.ts` — install vitest, @testing-library/react, jsdom if absent
- [ ] `components/scholar/headshot-avatar.test.tsx` — RED skeleton for HEADSHOT-01 (expects component not yet present; goes GREEN in Wave 1)
- [ ] `lib/headshot.test.ts` — RED skeleton asserting URL template
- [ ] `app/api/scholars/[cwid]/route.test.ts` — RED skeleton asserting `identityImageEndpoint` field
- [ ] `lib/utils.test.ts` — RED skeleton for shared `initials()` helper
- [ ] `tests/fixtures/scholar.ts` — shared scholar fixture (CWID + expected identityImageEndpoint)

If vitest is already installed in this repo (verify in Wave 0 task 0-01), drop the install line and keep only the test-skeleton tasks.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real WCM directory returns expected image for a known faculty CWID | HEADSHOT-01 | External live system; cannot mock in CI | Open profile page locally, confirm photo loads from directory; open DevTools Network panel, confirm 200 from `directory.weill.cornell.edu/api/v1/person/profile/<cwid>.png?returnGenericOn404=false` |
| Real 404 from directory triggers initials fallback | HEADSHOT-01 | Depends on a CWID known to lack a directory photo | Open profile for a CWID without a directory photo; confirm Radix `AvatarFallback` renders initials; confirm `data-headshot-state="error"` attribute is set |
| Mobile single-column collapse renders headshot at correct size on profile + search | SC 1, SC 2, mobile-responsive constraint | Visual regression best done by eye | Resize browser to 375px width; confirm headshot sizes from UI-SPEC are honored |
| `next/image` + Radix `AvatarImage asChild` interaction (open question A2 in research) | HEADSHOT-01 | Runtime behavior depends on Next.js 15 internals | Render component; if `onLoadingStatusChange` does not fire, fall back to plain `<img>` per research note |

---

## Validation Sign-Off

- [ ] All planner-emitted tasks have `<automated>` verify or Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING test infrastructure (vitest config, RED skeletons)
- [ ] No watch-mode flags in CI commands
- [ ] Feedback latency < 30s for quick run
- [ ] `nyquist_compliant: true` set in frontmatter once planner threads task IDs through the verification map

**Approval:** pending
