---
phase: 01-headshot-integration
plan: 04
type: execute
status: complete
wave: 3
requirements:
  - HEADSHOT-01
  - HEADSHOT-02
key-files:
  created:
    - .planning/phases/01-headshot-integration/01-04-SUMMARY.md
  modified:
    - components/scholar/headshot-avatar.tsx  # gap-closure: drop asChild + next/image, add object-top
---

# 01-04 — Phase verification gate

## Self-Check: PASSED

Phase 1 ships HEADSHOT-01 (CLOSED) and HEADSHOT-02 (PARTIAL — 2 of 6 surfaces by design per D-05).

## Task 1 — Full automated suite

| Step | Command | Result |
|------|---------|--------|
| Vitest | `npm test` | 63/63 passing across 10 files |
| Type check | `npx tsc --noEmit` | exit 0 (clean) |
| Build | `npm run build` | exit 0 — 8947 static profile pages generated, all routes parse |

Chain `npm test && npx tsc --noEmit && npm run build` exits 0.

## Task 2 — Security and scope grep gates

All six guards PASS:

| Gate | Check | Result |
|------|-------|--------|
| G1 | No server-side or ETL fetch of `directory.weill.cornell.edu` (`app/api/`, `scripts/`, `etl/`) | PASS — zero hits |
| G2 | No dormant `headshotUrl` references (`app/`, `lib/api/`, `components/`) | PASS — zero hits |
| G3 | `identityImageEndpoint` not present in OpenSearch indexer | PASS — file does not yet exist; field absent from any indexer code |
| G4 | No duplicate `function initials` in `app/` or `components/` (canonical lives in `lib/utils.ts`) | PASS — zero hits |
| G5 | `returnGenericOn404=false` polarity (never `=true`) | PASS — zero hits |
| G6 | `data-headshot-state` emitted on `HeadshotAvatar` root | PASS |

These greps are the standing mitigation evidence for STRIDE threats T-1-03 (no SSRF) and T-1-05 (no server-side directory proxy).

## Task 3 — Human visual verification

User-approved on real-browser walkthrough at `http://localhost:3000`. Two gap-closure fixes were required during this gate:

### Gap 1 — Pitfall 1 fired (component bug)

**Symptom:** On `/scholars/ronald-crystal`, the avatar circle rendered but the photograph never appeared. SSR HTML carried the correct directory URL (`rgcryst.png`) and `data-headshot-state="loading"`, but the state never transitioned client-side and DevTools Network showed zero requests to `directory.weill.cornell.edu`.

**Root cause:** Radix `AvatarImage` with `asChild` reads `src` from its own props for `useImageLoadingStatus`. With `asChild`, `src` lived only on the child `<Image>`, so the loading probe was fed `undefined` and never resolved to `"loaded"`. This was Pitfall 1 from `01-RESEARCH.md` — anticipated, but the unit-test coverage in jsdom couldn't surface it (no real network stack).

**Fix (commit `2de0547`):** Drop `asChild` + `next/image` from `HeadshotAvatar`; pass `src` directly to `AvatarImage` so Radix renders its native `<img>`. Cross-origin image was already `unoptimized`, so `next/image` was buying nothing here. `next.config.ts` `remotePatterns` left in place for forward-compat with Phase 2/3 surfaces that may use `next/image`.

**Verification after fix:** All 63 unit tests still GREEN; `tsc --noEmit` clean. User confirmed real headshots render on profile and search.

### Gap 2 — Vertical crop clipped foreheads

**Symptom:** WCM directory headshots are portrait crops with the subject's face in the upper third. Default `object-cover` centers vertically — on the 48px search-row circle and 96/112px profile sidebar circle, this clipped the top of the head on tall faces (visible on Crystal Kamilaris and Ronald Crystal in the search results).

**Fix (commit `40861a9`):** Add `object-top` to the `AvatarImage` className so the visible window anchors to the top of the source image — face stays whole; jacket bottom is what gets cropped instead.

**Verification after fix:** User reported "well done. Proceed."

### Six visual checks (final state)

| # | Check | Result |
|---|-------|--------|
| 1 | Profile — image-loaded path (`/scholars/ronald-crystal`): photo renders at ~96-112px, 200 from directory, `data-headshot-state="image"` | PASS |
| 2 | Profile — 404 fallback path: initials in muted circle, 404 from directory, `data-headshot-state="fallback"` | PASS |
| 3 | Search row — 48px circular headshot with `data-headshot-state="image"` | PASS |
| 4 | Mobile single-column collapse at 375px — sizes preserved, no layout overlap | PASS |
| 5 | Pitfall 1 sanity — state correctly transitions `loading → image`, no console warnings about asChild ref-forwarding | PASS (post-fix) |
| 6 | API contract — `curl /api/scholars/:cwid \| jq .identityImageEndpoint` returns the directory URL string | PASS (covered by GREEN scholars-api unit test) |

## HEADSHOT requirement disposition

| Req | Phase 1 disposition | Notes |
|-----|---------------------|-------|
| HEADSHOT-01 | CLOSED | `/api/scholars/:cwid` and the two server-side payload assemblers (`lib/api/profile.ts`, `lib/api/search.ts`) all populate `identityImageEndpoint` from the canonical builder in `lib/headshot.ts`. Field is computed deterministically from CWID; no runtime DB or directory hop. |
| HEADSHOT-02 | PARTIAL — 2 of 6 surfaces shipped | Profile sidebar (size `lg`) + search row (size `md`) are CLOSED. Remaining four surfaces (Recent contributions cards, Top scholars chips, topic Recent highlights, department faculty grid) close in Phases 2 and 3 per D-05 + ROADMAP. Those phases must import the existing `<HeadshotAvatar>` component. |

## Carry-forward notes for downstream phases

- `<HeadshotAvatar>` is the canonical surface — Phases 2/3 import from `@/components/scholar/headshot-avatar`. No additional size variants needed unless a design token specifies one not already in `SIZE_CLASS`.
- The `identityImageEndpoint` field is on `ScholarPayload`, `ProfilePayload`, `PeopleHit`. Future serializers/mappers must populate it from the same `lib/headshot.ts` builder — never inline the URL.
- `next.config.ts` `remotePatterns` whitelist (`directory.weill.cornell.edu`) remains in place for forward-compat. The current Phase 1 component does NOT use `next/image`, so the whitelist is dormant; future surfaces that opt into `next/image` will be ready.
- Anti-pattern guard: `identityImageEndpoint` MUST NOT be added to OpenSearch indexers (G3 grep). Image URL is computed on read, not indexed.
- `tsc --noEmit` is clean in the merged tree (a pre-existing 37-error baseline reported in `01-03-SUMMARY.md` was specific to the executor's worktree, where the generated Prisma client was missing — not a real codebase issue).
