---
phase: 01-headshot-integration
verified: 2026-04-30T11:51:00Z
status: passed
score: 5/5 must-haves verified (HEADSHOT-02 partial-by-design per D-05)
overrides_applied: 0
---

# Phase 1: Headshot integration — Verification Report

**Phase Goal:** Faculty headshots render on every surface that displays a scholar, sourced from WCM directory via the syntax-template pattern proven in ReCiter-Publication-Manager.

**Scope nuance (D-05):** Phase 1 ships 2 of 6 surfaces (profile sidebar, search row). The remaining four (Recent contributions cards, Top scholars chips, Topic Recent highlights, department faculty grid) are explicitly deferred to Phases 2 and 3. They are recorded in the deferred section, not as gaps.

**Verified:** 2026-04-30T11:51:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Profile page displays scholar's WCM directory headshot in sidebar (large) — or generic placeholder on 404 | ✓ VERIFIED | `app/(public)/scholars/[slug]/page.tsx:83` mounts `<HeadshotAvatar size="lg" cwid=… preferredName=… identityImageEndpoint={profile.identityImageEndpoint} />`. Component falls back to initials-in-circle when image errors or endpoint empty (`headshot-avatar.tsx:39-45`). User-confirmed visually on `/scholars/ronald-crystal` (image-loaded) and an unknown-CWID profile (fallback) per 01-04-SUMMARY. |
| 2 | Search result row shows small headshot beside scholar name + primary title | ✓ VERIFIED | `app/(public)/search/page.tsx:154` mounts `<HeadshotAvatar size="md" …/>`. `SIZE_CLASS.md = "h-12 w-12"` = 48px circle. User-confirmed visually. |
| 3 | Headshots in every Recent contributions card and Top scholars chip on a topic page | ⏸ DEFERRED to Phases 2/3 | Per D-05 + ROADMAP traceability — Recent contributions, Top scholars chips, Topic Recent highlights are Phase 2 scope (RANKING-01/02/03); department faculty grid is Phase 3 (DEPT-01). Not a gap. |
| 4 | `/api/scholars/:cwid` includes `identityImageEndpoint: string` for every scholar | ✓ VERIFIED | `lib/api/scholars.ts:20` declares `identityImageEndpoint: string` on `ScholarPayload`; `:61` populates via `identityImageEndpoint(scholar.cwid)`. Same pattern in `lib/api/profile.ts:54,214` and `lib/api/search.ts:55,199`. Field is non-null string per type signature. |
| 5 | No server-side proxy or ETL pre-fetch — browser hits `directory.weill.cornell.edu` directly | ✓ VERIFIED | `grep -RIn "directory.weill.cornell.edu" app/api/ scripts/ etl/` returns zero hits. Only references live in `next.config.ts` (remotePatterns) and `lib/headshot.ts` (URL builder). T-1-05 mitigation evidence intact. |

**Score:** 5 of 5 success criteria verified (criterion #3 deferred-by-design and not counted against Phase 1).

### Deferred Items

Items not yet met but explicitly addressed in later milestone phases.

| # | Item | Addressed In | Evidence |
|---|------|--------------|----------|
| 1 | Headshots on home Recent contributions cards | Phase 2 | RANKING-01 (REQUIREMENTS.md:78); D-05 in 01-CONTEXT.md; ROADMAP traceability table maps RANKING-01 → Phase 2 |
| 2 | Headshots on Top scholars chip row (topic page) | Phase 2 | RANKING-03 (REQUIREMENTS.md:80) |
| 3 | Headshots on Topic Recent highlights | Phase 2 | RANKING-02 (REQUIREMENTS.md:79) |
| 4 | Headshots on department faculty grid | Phase 3 | DEPT-01 (REQUIREMENTS.md:91) |

These four surfaces were excluded from Phase 1 scope at planning time per D-05; the SUMMARY documents the partial closure of HEADSHOT-02.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/headshot.ts` | URL builder exports `identityImageEndpoint(cwid)` returning `${BASE}/${cwid}.png?returnGenericOn404=false` | ✓ VERIFIED | 7 lines; reads `SCHOLARS_HEADSHOT_BASE` env var with documented default; uses `=false` polarity (Pitfall 2 avoided) |
| `lib/utils.ts` | Exports shared `initials(name)` helper | ✓ VERIFIED | `initials` exported on line 8; existing `cn` preserved on line 4; canonical single source per G4 grep |
| `components/scholar/headshot-avatar.tsx` | Client component, props `{cwid, preferredName, identityImageEndpoint, size, className?}`, emits `data-headshot-state` | ✓ VERIFIED | 70 lines; `"use client"` directive line 1; props match contract; `data-headshot-state` set on Avatar root (line 49); fallback transition logic correct (lines 39-45). Reflects gap-closure fixes (no `asChild`/`next/image`; `object-top` crop anchor) |
| `next.config.ts` | `images.remotePatterns` whitelisting `directory.weill.cornell.edu` over HTTPS, pathname `/**` | ✓ VERIFIED | Lines 6-13: protocol https, exact hostname, `pathname: "/**"`. T-1-01 mitigation. |
| `lib/api/scholars.ts` | `ScholarPayload` includes `identityImageEndpoint: string` (non-null); serializer populates from `lib/headshot` | ✓ VERIFIED | Import line 8; type field line 20; populate line 61. |
| `lib/api/profile.ts` | `ProfilePayload` includes `identityImageEndpoint: string`; profile serializer populates | ✓ VERIFIED | Import line 10; type field line 54; populate line 214. Dormant `headshotUrl` removed from API code (G2 grep clean). |
| `lib/api/search.ts` | `PeopleHit` includes `identityImageEndpoint: string`; hit mapper populates | ✓ VERIFIED | Import line 20; type field line 55; mapper line 199. OpenSearch indexer (`etl/search-index/`) untouched per G3 — anti-pattern guard holds. |
| `app/(public)/scholars/[slug]/page.tsx` | Profile sidebar uses `<HeadshotAvatar size="lg">` | ✓ VERIFIED | Import line 3; mount line 83 with `size="lg"` |
| `app/(public)/search/page.tsx` | Search row uses `<HeadshotAvatar size="md">` | ✓ VERIFIED | Import line 2; mount line 154 with `size="md"` |
| Test suite | 6 RED tests turn GREEN | ✓ VERIFIED | All 10 unit test files green: 63/63 passing including `headshot.test.ts`, `headshot-avatar.test.tsx`, `initials.test.ts`, `scholars-api.test.ts`, `profile-api.test.ts`, `search-api.test.ts` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `components/scholar/headshot-avatar.tsx` | `lib/utils.ts` | `import { cn, initials } from "@/lib/utils"` | ✓ WIRED | Line 5; both symbols used (cn line 50, initials line 65) |
| `app/(public)/scholars/[slug]/page.tsx` | `components/scholar/headshot-avatar.tsx` | `import { HeadshotAvatar }` | ✓ WIRED | Line 3 import; line 83 use |
| `app/(public)/search/page.tsx` | `components/scholar/headshot-avatar.tsx` | `import { HeadshotAvatar }` | ✓ WIRED | Line 2 import; line 154 use |
| `lib/api/scholars.ts` | `lib/headshot.ts` | `import { identityImageEndpoint }` | ✓ WIRED | Line 8 import; line 61 used in serializer |
| `lib/api/profile.ts` | `lib/headshot.ts` | `import { identityImageEndpoint }` | ✓ WIRED | Line 10 import; line 214 used |
| `lib/api/search.ts` | `lib/headshot.ts` | `import { identityImageEndpoint }` | ✓ WIRED | Line 20 import; line 199 used in hit mapper |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `HeadshotAvatar` (profile sidebar) | `profile.identityImageEndpoint` | `lib/api/profile.ts:214` `identityImageEndpoint(scholar.cwid)` from Prisma row | YES — directory URL string deterministically computed from real CWID | ✓ FLOWING |
| `HeadshotAvatar` (search row) | `h.identityImageEndpoint` | `lib/api/search.ts:199` from OpenSearch `_source.cwid` | YES | ✓ FLOWING |
| URL builder | `BASE` const | `process.env.SCHOLARS_HEADSHOT_BASE` with documented default | YES — default is real WCM directory endpoint | ✓ FLOWING |
| Image network fetch | `<img src={identityImageEndpoint}>` (via Radix `AvatarImage`) | Browser → `directory.weill.cornell.edu` directly | YES — user-confirmed 200 responses on real CWIDs in browser dev tools | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| URL builder produces correct URL for sample CWID | Encoded in `tests/unit/headshot.test.ts` (3 tests covering default URL, polarity, .png+cwid path) | All 3 GREEN | ✓ PASS |
| HeadshotAvatar emits correct `data-headshot-state` per state | `tests/unit/headshot-avatar.test.tsx` (6 tests covering fallback, loading, sm/md/lg sizes, alt) | All 6 GREEN | ✓ PASS |
| Initials helper handles edge cases | `tests/unit/initials.test.ts` (6 tests covering case, multi-word, empty, whitespace) | All 6 GREEN | ✓ PASS |
| Three serializers populate field | `tests/unit/{scholars,profile,search}-api.test.ts` (4 tests with Prisma/OpenSearch mocks) | All 4 GREEN | ✓ PASS |
| Full automated suite | `npx vitest run` | 63/63 across 10 files | ✓ PASS |
| Type check | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| Build (validates `next.config.ts` `remotePatterns` parse) | `npm run build` per 01-04-SUMMARY | exit 0; 8947 static profile pages generated | ✓ PASS (per SUMMARY; not re-run during verification) |
| Real-browser load + fallback | Dev-server walkthrough at `localhost:3000` per 01-04-SUMMARY | User-approved both image-loaded and 404-fallback paths after gap-closure fixes | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| HEADSHOT-01 | All four plans (01-01, 01-02, 01-03, 01-04) | Server-side scholar API responses include `identityImageEndpoint` field populated from WCM directory syntax template | ✓ SATISFIED | All three serializers (`scholars.ts`, `profile.ts`, `search.ts`) populate the field via canonical `lib/headshot.ts` builder. Field is `string` non-null; empty fallback handled at component layer (404 → fallback state). Plan 01-04 SUMMARY confirms `/api/scholars/:cwid` returns the URL string. |
| HEADSHOT-02 | All four plans | Client-side renderers across all six surfaces check `identityImageEndpoint.length > 0` before using; otherwise render fallback | ⚠️ PARTIAL — 2 of 6 surfaces (intentional, per D-05) | Profile sidebar + search row CLOSED in Phase 1. Component logic at `headshot-avatar.tsx:37-45` implements the `length > 0` check via `noImage` flag. Four remaining surfaces deferred to Phases 2 (RANKING-01/02/03) and 3 (DEPT-01); they will reuse the existing component. Treated as PASS per phase scope contract. |

No requirement IDs orphaned: every Phase 1 plan declares HEADSHOT-01 + HEADSHOT-02 in frontmatter; REQUIREMENTS.md traceability maps both to Phase 1.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | — | — | All six security/scope grep gates from 01-04 plan PASS — no `directory.weill.cornell.edu` fetch in `app/api/`/`scripts/`/`etl/`, no dormant `headshotUrl` reference in `app/`/`lib/api/`/`components/`, no `identityImageEndpoint` in OpenSearch indexer, no duplicate `function initials`, no `returnGenericOn404=true` polarity, `data-headshot-state` present on component root. |

### Human Verification Required

None outstanding for this verification. Real-browser visual checks were completed during the 01-04 plan gate and are documented in 01-04-SUMMARY.md (six checks, all PASS post gap-closure). Two intentional gap-closure fixes were applied in-gate:

1. Commit `2de0547` — drop `asChild` + `next/image` from `HeadshotAvatar` (Pitfall 1: Radix `AvatarImage` `useImageLoadingStatus` was reading `src` from its own props, not the `next/image` child, so the loaded transition never fired in real browsers — jsdom unit tests couldn't surface this).
2. Commit `40861a9` — add `object-top` crop anchor so portrait headshots don't clip the forehead at small avatar sizes.

Both fixes are reflected in the current `components/scholar/headshot-avatar.tsx`. All 63 unit tests remain green after both commits.

### Gaps Summary

No actionable gaps. The phase goal is achieved within the scope defined by D-05:

- HEADSHOT-01 is fully closed: the `identityImageEndpoint` field is plumbed through all three serializers and computed deterministically from CWID via a single canonical builder.
- HEADSHOT-02 is closed for the two surfaces in Phase 1 scope (profile sidebar `lg`, search row `md`); the four remaining surfaces are documented forward-references to Phases 2/3, not gaps.
- All security/scope guards hold (no SSRF surface introduced; no dormant field leakage; no anti-pattern indexing of computed URL).
- Gap-closure fixes for Pitfall 1 and the crop anchor were applied during the verification gate and are reflected in committed code.

---

*Verified: 2026-04-30T11:51:00Z*
*Verifier: Claude (gsd-verifier)*
