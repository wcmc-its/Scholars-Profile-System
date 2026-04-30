# Phase 1: Headshot Integration - Research

**Researched:** 2026-04-30
**Domain:** Next.js 15 image rendering, WCM directory API, Radix UI Avatar primitive, TypeScript API serializer
**Confidence:** HIGH — all major claims verified against the live codebase and/or official Radix UI documentation

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** 404 handled client-side via Radix `AvatarFallback` (not `onError`). Scholar API always populates `identityImageEndpoint` with the templated URL. Server never probes `directory.weill.cornell.edu`.
- **D-02:** URL computed in the API response serializer from `SCHOLARS_HEADSHOT_BASE` env var + row's CWID: `${SCHOLARS_HEADSHOT_BASE}/${cwid}.png?returnGenericOn404=false`.
- **D-03:** Existing `scholar.headshot_url` column stays dormant — not populated, not read. Out of scope.
- **D-04:** Fallback renders existing `AvatarFallback` initials-in-circle. No new asset shipped.
- **D-05:** Wire only surfaces that exist today: profile sidebar (`app/(public)/scholars/[slug]/page.tsx:83`) and search People-tab rows (`app/(public)/search/page.tsx:154`). Home page has no scholar surfaces yet (Phase 2 deliverable).
- **D-06:** Build single reusable `<HeadshotAvatar>` component at `components/scholar/headshot-avatar.tsx`. Props: `cwid: string`, `preferredName: string`, `identityImageEndpoint: string`, `size: "sm" | "md" | "lg"`.
- **D-07:** `next/image` with `remotePatterns` whitelist + per-image `unoptimized` prop. Add `directory.weill.cornell.edu` to `next.config.ts`.

### Claude's Discretion

- Alt text format (default: `preferredName`)
- Sidebar/search dimensions (default: `h-24 sm:h-28 w-24 sm:w-28` sidebar, `h-12 w-12` search)
- Env-var name (`SCHOLARS_HEADSHOT_BASE` recommended)
- Component-render-logging hook: minimum is `data-headshot-state` attribute on `Avatar` root
- Exact loader/error event handler shape (Radix handles fallback natively per official docs)

### Deferred Ideas (OUT OF SCOPE)

- `/api/headshot/:cwid` server-side proxy with cache headers
- Drop dormant `scholar.headshot_url` column
- Per-surface sizing tokens for Phase 2/3 surfaces
- Component-render logging body (Phase 6)
- Alt text accessibility audit
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| HEADSHOT-01 | Scholar API responses include `identityImageEndpoint` field populated from WCM directory syntax template; empty string when CWID resolves to 404 | API serializer change in `lib/api/scholars.ts` (add field) + `lib/api/profile.ts` (rename/add field); env var `SCHOLARS_HEADSHOT_BASE` governs base URL |
| HEADSHOT-02 | Client-side renderers across all six surfaces check `identityImageEndpoint.length > 0` before using; otherwise load local placeholder | Radix `AvatarFallback` handles 404 fallback natively; Phase 1 wires profile sidebar + search rows only (D-05); Phase 2/3 reuse `<HeadshotAvatar>` for remaining surfaces |
</phase_requirements>

---

## Summary

Phase 1 wires WCM Enterprise Directory headshot images into the two scholar-rendering surfaces that already exist in the Scholars Profile System prototype (profile sidebar, search People-tab rows). The approach mirrors the pattern in the sibling ReCiter-Publication-Manager project: the scholar API computes a templated URL from a single env-var base + CWID and returns it as `identityImageEndpoint`; the browser loads the image directly against `directory.weill.cornell.edu`; if the image returns 404, Radix UI's `AvatarFallback` automatically renders the existing initials-in-circle fallback without any manual `onError` wiring.

The entire change is additive: one new component (`<HeadshotAvatar>`), two modified call sites (profile sidebar, search row), two updated API serializers (`lib/api/scholars.ts`, `lib/api/profile.ts`), and one config change (`next.config.ts` `images.remotePatterns`). The `scholar.headshot_url` column and the ED ETL are untouched. No new assets are shipped.

The "six surfaces" mentioned in HEADSHOT-02 span Phase 1 (profile sidebar, search rows), Phase 2 (Recent contributions cards, Top scholars chips), and Phase 3 (topic Recent highlights, department faculty grid). Phase 1 ships only the two existing surfaces plus the reusable `<HeadshotAvatar>` component that later phases import.

**Primary recommendation:** Implement as described. The Radix primitive's native fallback behavior eliminates the need for manual `onError` state — simplest correct implementation.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| URL template computation | API / Backend | — | Computed at serialization time in `lib/api/*`; single source of truth |
| Image fetch + 404 detection | Browser / Client | — | ADR-009 explicitly forbids server-side probing; browser hits directory directly |
| Fallback rendering | Browser / Client | — | Radix `AvatarFallback` is a client component; handles natively |
| `next/image` optimization bypass | Frontend Server (Next.js) | — | `unoptimized` prop disables the Next.js image optimizer cache; browser gets raw URL |
| Component-render logging hook | Browser / Client | — | `data-headshot-state` attribute emitted at render; Phase 6 attaches observer |

---

## Standard Stack

### Core

| Library | Version in Project | Purpose | Why Standard |
|---------|--------------------|---------|--------------|
| `next` (includes `next/image`) | 15.5.15 [VERIFIED: package.json] | `<Image>` component with CLS prevention, lazy loading, automatic `width`/`height` | Already in project; `next/image` is the idiomatic image primitive for Next.js |
| `radix-ui` | ^1.4.3 [VERIFIED: package.json] | `Avatar.Root`, `Avatar.Image`, `Avatar.Fallback` — circular avatar with native 404 fallback | Already installed; shadcn `avatar.tsx` wraps it |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Tailwind CSS 4 | already in project | `h-24 sm:h-28 w-24 sm:w-28` sizing overrides on Avatar root | Sizing classes applied at wrapper level; existing `Avatar` primitive unchanged |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `next/image` + `unoptimized` | Plain `<img>` | Plain `<img>` skips CLS protection and lazy-loading; `next/image` + `unoptimized` keeps those without adding a server-side cache |
| Radix native fallback | Manual `onError` + state | Manual approach required in PubMan because it uses a custom `<Image>` not the Radix Avatar primitive; our codebase already has Radix wired — no manual handler needed |
| Initials fallback | Silhouette PNG asset | Initials are more identifying; require no asset pipeline; match shadcn idiom already in codebase |

**Installation:** No new packages. All dependencies already present.

---

## Reference Implementation Findings

### PubMan URL template (config/report.js:113)

```javascript
// Source: /Users/paulalbert/Dropbox/GitHub/ReCiter-Publication-Manager/config/report.js:113
headshotSyntax: "https://directory.weill.cornell.edu/api/v1/person/profile/{personID}.png?returnGenericOn404=false",
```

[VERIFIED: direct file read]

### PubMan identityImageEndpoint config (config/local.js:32-33)

```javascript
// Source: /Users/paulalbert/Dropbox/GitHub/ReCiter-Publication-Manager/config/local.js:32-33
identityImageEndpoint:
    "https://directory.weill.cornell.edu/api/v1/person/profile/${uid}.png?returnGenericOn404=true",
```

[VERIFIED: direct file read]

**Key difference from our implementation:** PubMan uses `returnGenericOn404=true` (directory returns a generic image, load always "succeeds"). ADR-009 specifies `returnGenericOn404=false` so the directory returns a real HTTP 404, which triggers Radix's fallback path. Intentional and correct.

### PubMan rendering pattern (Profile.tsx:345-358)

```tsx
// Source: /Users/paulalbert/Dropbox/GitHub/ReCiter-Publication-Manager/src/components/elements/Profile/Profile.tsx:345-358
{displayImage && identity.identityImageEndpoint && headShotLabelData?.length > 0 && headShotLabelData[0].isVisible ? (
  <Image
    className={styles.drawerPhotoImg}
    alt="Profile photo"
    width={64}
    height={64}
    src={headShotLabelData[0]?.syntax?.replace("{personIdentifier}", identity.uid)}
    onError={() => setDisplayImage(false)}
  />
) : (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" width="28" height="28">
    <circle cx="8" cy="5.5" r="3"/><path d="M2 14c0-3.31 2.69-6 6-6s6 2.69 6 6"/>
  </svg>
)}
```

[VERIFIED: direct file read]

**Differences in our implementation:** PubMan uses a custom `<Image>` + explicit `onError` state handler + SVG placeholder. Our codebase uses the Radix `Avatar` primitive which handles the fallback natively without `onError`; we use initials instead of a silhouette SVG.

### PubMan next.config.js:9-17 (remotePatterns)

```javascript
// Source: /Users/paulalbert/Dropbox/GitHub/ReCiter-Publication-Manager/next.config.js:9-17
images: {
  remotePatterns: [
    { 
      protocol: 'https',
      hostname: 'directory.weill.cornell.edu',
      pathname: '/**',
    },
  ],
}
```

[VERIFIED: direct file read]

---

## Codebase Landmarks

### Existing avatar call sites (Phase 1 insertion points)

**Profile sidebar — `app/(public)/scholars/[slug]/page.tsx:83-85`** [VERIFIED: direct file read]

```tsx
// CURRENT (lines 83-85):
<Avatar className="h-24 w-24 sm:h-28 sm:w-28">
  <AvatarFallback className="text-xl">{initials(profile.preferredName)}</AvatarFallback>
</Avatar>

// BECOMES:
<HeadshotAvatar
  size="lg"
  cwid={profile.cwid}
  preferredName={profile.preferredName}
  identityImageEndpoint={profile.identityImageEndpoint}
/>
```

**Search People-tab row — `app/(public)/search/page.tsx:154-156`** [VERIFIED: direct file read]

```tsx
// CURRENT (lines 154-156):
<Avatar className="h-12 w-12 shrink-0">
  <AvatarFallback>{initials(h.preferredName)}</AvatarFallback>
</Avatar>

// BECOMES:
<HeadshotAvatar
  size="md"
  cwid={h.cwid}
  preferredName={h.preferredName}
  identityImageEndpoint={h.identityImageEndpoint}
/>
```

### API serializer — two places to update

**`lib/api/scholars.ts` — `ScholarPayload` type + `getScholarByCwid` return** [VERIFIED: direct file read]

- `ScholarPayload` type (lines 10-27): add `identityImageEndpoint: string`
- `getScholarByCwid` return (lines 50-67): add `identityImageEndpoint: \`${base}/${cwid}.png?returnGenericOn404=false\``
- This is the API endpoint at `app/api/scholars/[cwid]/route.ts` — HEADSHOT-01 success criterion #4

**`lib/api/profile.ts` — `ProfilePayload` type + profile serializer** [VERIFIED: direct file read]

- `ProfilePayload` type (line 53): rename `headshotUrl: string | null` → add `identityImageEndpoint: string` (always populated, never null)
- Profile serializer return (line 213): replace `headshotUrl: scholar.headshotUrl` → `identityImageEndpoint: \`${base}/${cwid}.png?returnGenericOn404=false\``
- The existing `headshotUrl` in ProfilePayload can be removed or left as deprecated; D-03 says the DB column stays dormant

### `initials` utility — duplicated in both pages

Currently `initials()` is a private function defined at the bottom of both `app/(public)/scholars/[slug]/page.tsx:346` and `app/(public)/search/page.tsx:613`. Both implementations are identical. `<HeadshotAvatar>` will need to call `initials()` internally. Options:
1. Extract to `lib/utils.ts` (currently contains only `cn`) — **recommended**: avoids circular import and is the natural shared-utilities location
2. Inline the function in `components/scholar/headshot-avatar.tsx` — acceptable given it's 7 lines

`lib/utils.ts` currently exports only `cn` [VERIFIED: direct file read]. Adding `initials` there has no coupling risk.

### `next.config.ts` — no `images` block today

Current content [VERIFIED: direct file read]:
```typescript
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};
```

The `images.remotePatterns` block does not exist yet — purely additive change.

### OpenSearch index (`etl/search-index/index.ts`)

The people index document shape (lines 148-168) does NOT include `identityImageEndpoint`. This is correct — the field is computed at API-response time from CWID, not stored or indexed. The search API (`lib/api/search.ts`) maps `PeopleHit` from OpenSearch results; `identityImageEndpoint` will be computed in the search API hit mapper, not sourced from OpenSearch. [VERIFIED: direct file read]

**`PeopleHit` type (`lib/api/search.ts:46-55`) needs `identityImageEndpoint: string` added** and the mapper (lines 189-198) needs the field computed. This requires the search API to know the `SCHOLARS_HEADSHOT_BASE` value — same env var, same pattern.

### `components/scholar/` directory

Does not exist yet [VERIFIED: `ls` result]. Must be created as part of this phase.

---

## Configuration Changes

### `next.config.ts` — add `images.remotePatterns`

```typescript
// Source: mirrors /ReCiter-Publication-Manager/next.config.js:9-17 [VERIFIED]
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "directory.weill.cornell.edu",
        pathname: "/**",
      },
    ],
  },
};
```

### Environment variable

**`SCHOLARS_HEADSHOT_BASE`** — base URL prefix without trailing slash.

- Default value in code: `"https://directory.weill.cornell.edu/api/v1/person/profile"` [CITED: config/local.js:32-33 + config/report.js:113 from PubMan]
- Local dev: lives in `~/.zshenv` per project credential convention (CLAUDE.md)
- Production: AWS Secrets Manager / SSM Parameter Store override

Full computed URL per scholar: `${SCHOLARS_HEADSHOT_BASE}/${cwid}.png?returnGenericOn404=false`

**Implementation pattern** — one utility to centralize:

```typescript
// lib/headshot.ts (new file, ~5 lines)
const BASE = process.env.SCHOLARS_HEADSHOT_BASE
  ?? "https://directory.weill.cornell.edu/api/v1/person/profile";

export function identityImageEndpoint(cwid: string): string {
  return `${BASE}/${cwid}.png?returnGenericOn404=false`;
}
```

Both `lib/api/scholars.ts` and `lib/api/profile.ts` import from this one location. [ASSUMED — this is a recommended factoring; no single-file pattern is mandated by CONTEXT.md]

### No new asset

No `public/` directory exists yet [VERIFIED: `ls` result]. D-04 confirms no new asset ships — the `AvatarFallback` initials circle IS the placeholder.

---

## Architecture Patterns

### `<HeadshotAvatar>` component

**Location:** `components/scholar/headshot-avatar.tsx` (new file, new directory)

**Props contract (from UI-SPEC + CONTEXT.md D-06):**

```typescript
interface HeadshotAvatarProps {
  cwid: string;               // used only for data-cwid attribute / future logging
  preferredName: string;      // alt text + initials fallback
  identityImageEndpoint: string; // pre-computed URL from API; empty string = no image
  size: "sm" | "md" | "lg";  // sm=24px (reserved Phase 2), md=48px, lg=96/112px
  className?: string;
}
```

**Size → className mapping (from UI-SPEC):**

| size | className override on Avatar root | Surface |
|------|----------------------------------|---------|
| `sm` | `size-6` | Phase 2 chip rows (not used in Phase 1) |
| `md` | `h-12 w-12` | Search People-tab row |
| `lg` | `h-24 w-24 sm:h-28 sm:w-28` | Profile sidebar |

**Key implementation note:** The `Avatar` primitive's `data-size` values only go up to 40px (`data-size="lg"`). The profile sidebar needs 96–112px. `<HeadshotAvatar>` must pass `className` overrides on the `Avatar` root — do NOT modify `components/ui/avatar.tsx`.

**Radix fallback behavior (verified):** `AvatarFallback` renders automatically when `Avatar.Image` fails to load (404, network error, or still loading). No manual `onError` handler needed. [VERIFIED: Radix UI official docs — `AvatarFallback` "renders when the image hasn't loaded. This means whilst it's loading, or if there was an error."]

**`data-headshot-state` instrumentation (from UI-SPEC):**

The UI-SPEC locks four observable states: `loading`, `image`, `fallback`, `no-cwid`. The attribute is set on the outermost `Avatar` root element. Radix's `AvatarImage` exposes `onLoadingStatusChange` (values: `"idle" | "loading" | "loaded" | "error"`) which can drive this attribute. [VERIFIED: Radix UI official API docs]

```typescript
// Pattern using onLoadingStatusChange:
const [status, setStatus] = useState<"loading" | "image" | "fallback">("loading");
// Pass to Avatar root: data-headshot-state={cwid ? status : "fallback"}
// Use onLoadingStatusChange on AvatarImage to update status
```

**Since `HeadshotAvatar` uses `next/image` (not a plain `<img>`)**, the `AvatarImage` Radix primitive wraps the `next/image` component via `asChild`. This is the standard shadcn pattern for using `next/image` inside Radix Avatar. [ASSUMED — standard shadcn/radix pattern; verify against shadcn Avatar docs if needed]

### Recommended Project Structure (additions only)

```
components/
└── scholar/              # NEW directory — scholar-specific presentational components
    └── headshot-avatar.tsx  # NEW — HeadshotAvatar component

lib/
├── headshot.ts           # NEW — identityImageEndpoint(cwid) utility
└── utils.ts              # MODIFIED — add initials() export (or inline in headshot-avatar.tsx)

next.config.ts            # MODIFIED — add images.remotePatterns
lib/api/
├── scholars.ts           # MODIFIED — add identityImageEndpoint to ScholarPayload + mapper
├── profile.ts            # MODIFIED — add identityImageEndpoint to ProfilePayload + serializer
└── search.ts             # MODIFIED — add identityImageEndpoint to PeopleHit + mapper
app/(public)/
├── scholars/[slug]/page.tsx   # MODIFIED — replace bare Avatar with HeadshotAvatar at :83
└── search/page.tsx            # MODIFIED — replace bare Avatar with HeadshotAvatar at :154
```

### Anti-Patterns to Avoid

- **Modifying `components/ui/avatar.tsx`:** The primitive must remain unchanged. All sizing overrides go on the wrapper via `className`. Modifying the primitive cascades to `AvatarBadge` and `AvatarGroup` consumers.
- **Adding `identityImageEndpoint` to the OpenSearch index:** The field is derived from CWID at response time; indexing it adds maintenance burden with no query benefit.
- **Using manual `onError` state:** PubMan needed this because it uses a plain `<Image>` outside Radix Avatar. Our codebase uses Radix `AvatarImage` whose fallback fires automatically.
- **Hardcoding the directory URL:** Every call site must read `SCHOLARS_HEADSHOT_BASE` from env via the shared `lib/headshot.ts` utility (or equivalent); never repeat the string.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| 404 detection | Custom fetch + state machine | Radix `AvatarFallback` | Radix fires fallback on image error natively — already in the tree |
| Circular avatar mask | Custom CSS clip-path | `AvatarPrimitive.Root` with `rounded-full overflow-hidden` | Already done by primitive |
| Image sizing with aspect ratio | Manual aspect-ratio CSS | `aspect-square size-full` on `AvatarImage` (already in primitive) | Inherited; override only the root diameter |
| Lazy loading | IntersectionObserver | `next/image` default lazy loading | Built-in, free |

**Key insight:** The Radix Avatar primitive already handles the hardest part (fallback state machine). The only custom logic is computing the URL and tracking `data-headshot-state` for Phase 6.

---

## Common Pitfalls

### Pitfall 1: `next/image` + `unoptimized` + Radix `asChild` interaction

**What goes wrong:** Using `<AvatarImage asChild><Image .../></AvatarImage>` with `next/image` can result in `onLoadingStatusChange` not firing if Radix can't detect the native image load event through the forwarded ref.

**Why it happens:** `next/image` renders a wrapper `<span>` in some configurations; Radix `asChild` expects a raw `<img>`.

**How to avoid:** Use `next/image` with `fill` prop or verify with a known-good rendering. An alternative that avoids this entirely: render `next/image` as a direct child inside `AvatarImage` without `asChild`, or use a plain `<img>` with `unoptimized` semantics. Check whether the CLS protection goal requires `next/image` here — for small circular thumbnails (48–112px), a plain `<img>` with explicit `width`/`height` achieves the same CLS outcome. [ASSUMED — this is a known complexity area; verify during implementation]

**Warning signs:** Images render but `onLoadingStatusChange` never fires `"loaded"`; fallback flashes briefly then disappears.

### Pitfall 2: `returnGenericOn404=false` vs `=true`

**What goes wrong:** Using `returnGenericOn404=true` (PubMan's value) means the directory returns a generic PNG rather than a 404, so `AvatarFallback` never triggers — every scholar gets the same generic silhouette. The initials fallback never renders.

**Why it happens:** Copying PubMan's `identityImageEndpoint` string verbatim without reading the comment in CONTEXT.md.

**How to avoid:** Use `returnGenericOn404=false` as specified by ADR-009. The `lib/headshot.ts` utility should hard-code this parameter so no call site can get it wrong.

### Pitfall 3: Forgetting the search API hit mapper

**What goes wrong:** `identityImageEndpoint` is added to `ProfilePayload` and `ScholarPayload` but not to `PeopleHit`. Search results render without headshots.

**Why it happens:** Two separate API paths exist (`lib/api/profile.ts` for profile page, `lib/api/scholars.ts` for `/api/scholars/:cwid`, `lib/api/search.ts` for search). Only two are obvious from CONTEXT.md; the search API hit mapper is a third site.

**How to avoid:** The planner should create a task that explicitly covers all three serializer locations: profile, scholar API, and search API.

### Pitfall 4: `initials()` scope issue

**What goes wrong:** `HeadshotAvatar` calls `initials()` but the function is private to `app/(public)/scholars/[slug]/page.tsx` and `app/(public)/search/page.tsx`.

**Why it happens:** The function was never extracted to a shared module — it was duplicated in-place.

**How to avoid:** Extract `initials()` to `lib/utils.ts` as a named export before building `HeadshotAvatar`, or inline it in `headshot-avatar.tsx`. Either is fine; extraction is cleaner.

### Pitfall 5: `components/scholar/` directory doesn't exist

**What goes wrong:** Build fails because `components/scholar/headshot-avatar.tsx` is the first file in a new subdirectory.

**Why it happens:** `ls components/` shows `profile/`, `search/`, `site/`, `ui/` — no `scholar/` subdirectory.

**How to avoid:** Create the directory as part of Wave 0 setup, or just create the file (git/filesystem create parent dirs automatically).

---

## Component-Render Logging

### Contract (from UI-SPEC)

The `data-headshot-state` attribute is set on the outermost `Avatar` root element. Values: `loading | image | fallback`. Phase 1 emits the attribute only — no logging body.

### Implementation pattern

```tsx
// Inside HeadshotAvatar, using Radix onLoadingStatusChange:
const [imgStatus, setImgStatus] = useState<"loading" | "loaded" | "error">("loading");
const noImage = !identityImageEndpoint;

const dataState: "loading" | "image" | "fallback" =
  noImage ? "fallback"
  : imgStatus === "loaded" ? "image"
  : imgStatus === "error" ? "fallback"
  : "loading";

<Avatar data-headshot-state={dataState} ...>
  {!noImage && (
    <AvatarImage
      src={identityImageEndpoint}
      alt={preferredName}
      onLoadingStatusChange={(s) => setImgStatus(
        s === "loaded" ? "loaded" : s === "error" ? "error" : "loading"
      )}
    />
  )}
  <AvatarFallback ...>{initials(preferredName)}</AvatarFallback>
</Avatar>
```

`onLoadingStatusChange` type from Radix: `(status: "idle" | "loading" | "loaded" | "error") => void` [VERIFIED: Radix UI official API docs]

---

## Validation Architecture

> `workflow.nyquist_validation: true` — this section is required.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest + jsdom + @vitejs/plugin-react |
| Config file | `vitest.config.ts` (exists) |
| Quick run command | `npm test` (runs `vitest run`) |
| Full suite command | `npm test && npm run test:e2e` (Playwright e2e) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HEADSHOT-01 | `identityImageEndpoint` present in `/api/scholars/:cwid` response | unit | `npm test -- --reporter=verbose tests/unit/headshot.test.ts` | ❌ Wave 0 |
| HEADSHOT-01 | URL follows template `https://directory.weill.cornell.edu/api/v1/person/profile/{cwid}.png?returnGenericOn404=false` | unit | same | ❌ Wave 0 |
| HEADSHOT-01 | `PeopleHit.identityImageEndpoint` present in search results | unit | same | ❌ Wave 0 |
| HEADSHOT-02 | Profile sidebar renders `<img>` with `src` containing CWID | e2e (smoke) | `npm run test:e2e -- --grep "headshot"` | ❌ Wave 0 |
| HEADSHOT-02 | Search row renders headshot `<img>` | e2e (smoke) | same | ❌ Wave 0 |
| HEADSHOT-02 | `data-headshot-state` attribute present on Avatar root | unit (component) | `npm test -- tests/unit/headshot-avatar.test.tsx` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test` (unit suite, ~1 second)
- **Per wave merge:** `npm test` (full unit suite)
- **Phase gate:** `npm test && npm run typecheck` before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `tests/unit/headshot.test.ts` — unit tests for `identityImageEndpoint()` utility (REQ HEADSHOT-01); also covers all three API serializers (profile, scholar, search)
- [ ] `tests/unit/headshot-avatar.test.tsx` — component render tests for `<HeadshotAvatar>` (REQ HEADSHOT-02); test `data-headshot-state` values; test initials fallback renders when `identityImageEndpoint` is empty string
- [ ] E2e smoke: a `tests/e2e/headshot.spec.ts` is optional for Phase 1 if the unit tests cover the serializer contract; the profile page e2e requires a running server + real CWID with a known headshot result

---

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | n/a — Phase 1 is read-only public rendering |
| V3 Session Management | no | n/a |
| V4 Access Control | no | n/a |
| V5 Input Validation | yes (minimal) | CWID is sourced from DB (trusted); URL is computed, not user-input |
| V6 Cryptography | no | n/a |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Open redirect via manipulated `identityImageEndpoint` in API response | Spoofing / Tampering | Field is computed server-side from `SCHOLARS_HEADSHOT_BASE` env var + DB-sourced CWID; user cannot inject arbitrary URLs; `next/image` `remotePatterns` whitelist restricts rendering to `directory.weill.cornell.edu` |
| Exposed env var leakage | Information Disclosure | `SCHOLARS_HEADSHOT_BASE` is not sensitive (public URL); standard env var practices apply |

---

## Requirements Coverage

### HEADSHOT-01

**Requirement:** Server-side scholar API responses include `identityImageEndpoint` field populated from WCM directory syntax template `https://directory.weill.cornell.edu/api/v1/person/profile/{cwid}.png?returnGenericOn404=false`; if cwid resolves to 404, the field is set to empty string.

**How our approach addresses it:**

- The field is computed at response serialization time (D-02) — no server probe, no 404 detection at the server. The field is ALWAYS populated for active scholars (never null, never empty from the server's perspective).
- The REQUIREMENTS.md text says "empty string if 404" — this represents the ORIGINAL ADR-009 text. CONTEXT.md D-01 clarifies the resolution: since the server never probes upstream, the "empty string on 404" contract becomes a non-event. The API always returns the templated URL; the browser handles the 404 case.
- The `identityImageEndpoint` field must be added to three serializers: `lib/api/profile.ts` (profile page), `lib/api/scholars.ts` (`/api/scholars/:cwid` endpoint — the specific API contract target of HEADSHOT-01 success criterion #4), and `lib/api/search.ts` (search hit mapper, for HEADSHOT-02).

### HEADSHOT-02

**Requirement:** Client-side renderers across all six surfaces check `identityImageEndpoint.length > 0` before using; otherwise load local `/static/generic-headshot.png` asset.

**How our approach addresses it:**

- D-04 replaces the `/static/generic-headshot.png` asset with `AvatarFallback` initials — this is a locked decision that changes the acceptance criterion's implementation detail (fallback mechanism), not its intent (show a fallback when image is absent).
- D-05 scopes Phase 1 to two surfaces (profile sidebar, search row). The remaining four surfaces (Recent contributions, Top scholars chips, topic Recent highlights, department faculty grid) are Phase 2/3 deliverables that will import `<HeadshotAvatar>`.
- The `identityImageEndpoint.length > 0` check becomes: "if `identityImageEndpoint` is non-empty, render `AvatarImage` with that src; if empty (or CWID is blank), skip AvatarImage and let AvatarFallback render."

---

## Open Questions / Risks

1. **`next/image` + Radix `asChild` compatibility**
   - What we know: Radix `AvatarImage` is designed to swap the underlying `<img>`; `next/image` generates a wrapper element in some render modes.
   - What's unclear: Whether `asChild` forwarding works cleanly with `next/image` for `onLoadingStatusChange` propagation.
   - Recommendation: In implementation, test the `data-headshot-state` attribute with a real network call. If `asChild` causes issues, fall back to using a plain `<img>` inside `AvatarImage` without `asChild` (bypassing `next/image` for the avatar thumbnail specifically). The CLS benefit of `next/image` at 48–112px is marginal.

2. **Scope gap: HEADSHOT-02 says six surfaces; Phase 1 wires two**
   - What we know: D-05 explicitly limits Phase 1 to existing surfaces; Phase 2/3 handle the rest.
   - What's unclear: REQUIREMENTS.md HEADSHOT-02 will remain "Pending" after Phase 1 ships (not fully satisfied).
   - Recommendation: The planner should note HEADSHOT-02 as "partially satisfied by Phase 1" and fully closed in Phase 3. No action needed now.

3. **`initials()` extraction**
   - What we know: Function is duplicated in two page files; not in `lib/utils.ts`.
   - What's unclear: Whether to extract to `lib/utils.ts` or inline in `headshot-avatar.tsx`.
   - Recommendation: Extract to `lib/utils.ts` — it's a pure utility with no coupling risk and avoids a third copy.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 22+ | Next.js 15 | verify at execution | — | — |
| MySQL 8 (Docker) | Profile page rendering (reads DB) | ✓ (docker-compose.yml present) | 8.x | — |
| `directory.weill.cornell.edu` | Browser image loading (not server) | N/A — browser-direct, not server dependency | — | `AvatarFallback` initials |
| `next/image` | `HeadshotAvatar` component | ✓ — bundled with next@15.5.15 | 15.5.15 | — |
| `radix-ui` Avatar | `HeadshotAvatar` component | ✓ — ^1.4.3 installed | 1.4.3 | — |

**Missing dependencies with no fallback:** None.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `lib/headshot.ts` as a separate utility file is the recommended factoring for the URL computation | Configuration Changes | Low — the alternative (inline in each serializer) works equally well; just slightly less DRY |
| A2 | `next/image` with `asChild` on Radix `AvatarImage` works cleanly for `onLoadingStatusChange` in Next.js 15 | Architecture Patterns (Pitfall 1) | Medium — if it doesn't work, fall back to plain `<img>` with explicit dimensions; no blocker |
| A3 | Extracting `initials()` to `lib/utils.ts` is preferable to inlining in `headshot-avatar.tsx` | Codebase Landmarks | Low — either approach is correct |

---

## Sources

### Primary (HIGH confidence)

- Direct file reads of `ReCiter-Publication-Manager/config/report.js:113`, `config/local.js:32-33`, `Profile.tsx:345-358`, `next.config.js:9-17` — URL template and rendering pattern
- Direct file reads of `Scholars-Profile-System/components/ui/avatar.tsx`, `lib/api/profile.ts`, `lib/api/scholars.ts`, `lib/api/search.ts`, `app/(public)/scholars/[slug]/page.tsx`, `app/(public)/search/page.tsx`, `next.config.ts`, `vitest.config.ts`, `package.json` — codebase state
- Radix UI official docs via Context7 (`/websites/radix-ui_primitives`) — `AvatarFallback` fallback behavior, `onLoadingStatusChange` API

### Secondary (MEDIUM confidence)

- `.planning/intel/ADDENDUM-new-scope.md` § ADR-009 — architecture decision text
- `.planning/phases/01-headshot-integration/01-CONTEXT.md` — locked decisions D-01 through D-07
- `.planning/phases/01-headshot-integration/01-UI-SPEC.md` — visual and interaction contract

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified in package.json
- Architecture: HIGH — verified against live codebase; Radix behavior verified against official docs
- Reference implementation: HIGH — verified via direct file reads of PubMan
- Pitfalls: MEDIUM — A2 (next/image + asChild) is ASSUMED; others are VERIFIED from code inspection

**Research date:** 2026-04-30
**Valid until:** 2026-06-01 (stable stack; Radix and Next.js APIs unlikely to change materially)
