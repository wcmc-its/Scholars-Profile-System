# Phase 1: Headshot integration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 1-Headshot integration
**Areas discussed:** 404 detection mechanism, Generic placeholder design, Phase 1 surface scope, next/image vs plain img

---

## Gray Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| 404 detection mechanism | ADR-009 internal tension: server-side detection vs client onError | ✓ |
| Generic placeholder design | Initials, silhouette SVG, or shipped PNG | ✓ |
| Phase 1 surface scope | Existing surfaces only vs all 6 surfaces vs minimal | ✓ |
| next/image vs plain img | Optimizer config and caching-layer interpretation | ✓ |

**User's choice:** All four areas selected for discussion.

---

## 404 Detection Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Client-side onError | Always populate `identityImageEndpoint`; browser handles 404 via `onError`. Mirrors PubMan exactly. Zero server perf hit. | ✓ |
| Server-side HEAD probe per request | Scholar API does HEAD to directory on every request; sets empty string on 404. Honors ADR literal text but contradicts "no proxy". | |
| Probe at ETL time, store result | ED ETL HEAD-probes per CWID, writes to `scholar.headshot_url`. ~9k probes/day; up to 24h staleness. | |

**User's choice:** Client-side onError (Recommended).
**Notes:** Mirrors PubMan `Profile.tsx:352` pattern exactly. The ADR-009 "empty string on 404" contract becomes a non-event since the server never probes upstream.

### Follow-up: Where to compute/store the URL

| Option | Description | Selected |
|--------|-------------|----------|
| Compute in API serializer | Format URL at response time from config base + CWID. `scholar.headshot_url` column stays dormant. | ✓ |
| Populate column in ETL | ED ETL writes templated URL into column; API reads column. Stores derived data. | |
| Frontend computes from CWID | API returns CWID only; React component formats URL. Spreads template across client code. | |

**User's choice:** Compute in API serializer (Recommended).
**Notes:** One source of truth (config), no migration burden, no ETL change, easy swap-out if `/api/headshot/:cwid` proxy ever lands.

---

## Generic Placeholder Design

| Option | Description | Selected |
|--------|-------------|----------|
| Initials in colored circle | Reuse existing `AvatarFallback`. Already wired with `initials(preferredName)`. No asset to ship. | ✓ |
| Generic silhouette SVG | Inline SVG of generic person (PubMan pattern). All missing-photo scholars look identical. | |
| Generic-headshot.png asset | Ship `public/static/generic-headshot.png`. Matches REQ literal but introduces asset pipeline. | |
| Initials primary, silhouette if no name | Belt-and-suspenders. Extra logic for an edge case (preferredName always present per schema). | |

**User's choice:** Initials in colored circle (Recommended).
**Notes:** More identifying than a generic silhouette; zero asset pipeline work; matches shadcn/ui idioms already in the codebase.

---

## Phase 1 Surface Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Existing surfaces only + reusable HeadshotAvatar | Wire profile sidebar, search rows, existing home surfaces. Build `<HeadshotAvatar>` for Phases 2/3 to import. | ✓ |
| Wire ALL six surfaces, building stubs | Pre-build Recent contributions, Top scholars chips, etc. Pulls Phase 2/3 scope forward. | |
| Profile sidebar + search rows only; defer reusable component | Two ad-hoc inline implementations. Refactor cost paid in Phase 2. | |

**User's choice:** Existing surfaces only + reusable HeadshotAvatar (Recommended).
**Notes:** Phase 2/3 will import the same `<HeadshotAvatar>` when they build their new surfaces. Eliminates drift risk; the headshot pattern becomes a one-line change site for any future enhancement (e.g., the deferred `/api/headshot/:cwid` proxy).

---

## next/image vs Plain img

| Option | Description | Selected |
|--------|-------------|----------|
| next/image with remotePatterns + unoptimized | `<Image>` with `directory.weill.cornell.edu` whitelisted; `unoptimized` per-image to skip optimizer cache. CLS benefits without caching. | ✓ |
| next/image with default optimizer | Standard `<Image>` + remotePatterns; Next caches optimized variants. Best LCP but introduces server-side image cache (literal conflict with ADR). | |
| Plain `<img>` | Bypass next/image entirely. No config change, no optimizer, simplest mirror of PubMan. No automatic CLS. | |

**User's choice:** next/image with remotePatterns + unoptimized (Recommended).
**Notes:** Honors ADR-009 "no caching layer" literally (browser hits directory directly) while keeping `next/image`'s automatic width/height generation and lazy-loading defaults. Mirrors PubMan's `next.config.js:13` remotePatterns config.

---

## Claude's Discretion

- Alt text format (default: `preferredName`)
- Sidebar/search/chip dimensions (default: keep current `h-24 sm:h-28` for sidebar, `h-12 w-12` for search row — no design-spec override identified for Phase 1 surfaces)
- Env-var name (recommendation: `SCHOLARS_HEADSHOT_BASE`)
- Component-render-logging hook ("headshot rendered" vs "fallback rendered") — minimum: emit `data-headshot-state` attribute so Phase 6 logging can attach without refactor
- Exact loader/error event handler shape (Radix UI's Avatar primitive may handle the fallback transition natively without manual `onError`)

## Deferred Ideas

- `/api/headshot/:cwid` server-side proxy with cache headers (already deferred in ADR-009)
- Drop the dormant `scholar.headshot_url` column in a later cleanup phase
- Per-surface headshot sizing tokens for Phase 2/3 surfaces (Recent contributions card, Top scholars chip, department faculty row)
- Component-render logging integration — Phase 6 (Polish, analytics, documentation)
- Alt text accessibility audit
