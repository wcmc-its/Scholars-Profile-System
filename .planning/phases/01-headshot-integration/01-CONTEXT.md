# Phase 1: Headshot integration - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Foundation phase that wires WCM directory headshots into every existing scholar-rendering surface (profile sidebar, search People-tab rows, home page) and standardizes the rendering pattern as a reusable component (`<HeadshotAvatar>`) that Phases 2 and 3 will import when they build their new surfaces (Recent contributions cards, Top scholars chips, department faculty grid, topic recent highlights).

Architecture is locked by ADR-009: scholar API exposes `identityImageEndpoint`; browser hits `directory.weill.cornell.edu/api/v1/person/profile/{cwid}.png?returnGenericOn404=false` directly; no server proxy, no ETL pre-fetch, no caching layer in Phase 1; on 404 the browser falls back to a local placeholder.

Out of scope for this phase: building Phase 2/3 surfaces (Recent contributions, Top scholars row, etc.); a `/api/headshot/:cwid` proxy with cache headers (deferred future enhancement); any change to the `scholar.headshot_url` column or the ED ETL.

</domain>

<decisions>
## Implementation Decisions

### 404 Detection Mechanism
- **D-01:** **404 handled client-side via `onError`**, mirroring ReCiter-Publication-Manager exactly (`Profile.tsx:345-358`). The scholar API always populates `identityImageEndpoint` with the templated URL for every active scholar — server never probes `directory.weill.cornell.edu`. The browser attempts to load; on load error the rendering component swaps to the fallback placeholder. This honors ADR-009's "no server-side proxying / no ETL pre-fetch / no caching layer" constraint literally; the ADR's "empty string on 404" contract becomes a non-event since the server never makes the upstream call.
- **D-02:** **URL is computed in the API response serializer** at request time from a single config constant (e.g., `SCHOLARS_HEADSHOT_BASE` env var → `https://directory.weill.cornell.edu/api/v1/person/profile`) plus the row's CWID — `${SCHOLARS_HEADSHOT_BASE}/${cwid}.png?returnGenericOn404=false`. One source of truth (config), no migration burden, no ETL change.
- **D-03:** **The existing `scholar.headshot_url` column stays dormant** in this phase. Not populated, not read by the API. Removal can be considered in a later cleanup phase but is out of scope here.

### Generic Placeholder
- **D-04:** **Fallback renders the existing `AvatarFallback` initials-in-circle** from `components/ui/avatar.tsx`. No new asset is shipped. Profile and search pages already call `initials(profile.preferredName)` against this component — the change is purely additive (wrap with `<AvatarImage onError={...}>`). Generic-headshot.png and inline silhouette SVG were both rejected — initials are more identifying and require zero asset pipeline work.

### Phase 1 Surface Scope
- **D-05:** **Wire only the surfaces that exist today.** That is: profile sidebar (`app/(public)/scholars/[slug]/page.tsx:83`), search People-tab rows (`app/(public)/search/page.tsx:154`), and any home page surfaces that currently render scholars. Recent contributions cards, Top scholars chip row, topic Recent highlights, and department faculty grid are NOT built in this phase — those are Phase 2/3 deliverables.
- **D-06:** **Build a single reusable `<HeadshotAvatar>` component** that wraps `Avatar` + `AvatarImage` (with onError fallback handler) + `AvatarFallback`. Props: `cwid`, `preferredName`, `size` ("sm" | "md" | "lg"). All Phase 1 surfaces consume this component; Phases 2 and 3 import the same component when they build their new surfaces. This eliminates the risk of two ad-hoc implementations drifting and makes the headshot pattern a one-line change site for any future enhancement (e.g., the deferred `/api/headshot/:cwid` proxy).

### Image Rendering
- **D-07:** **`next/image` with `remotePatterns` whitelist + per-image `unoptimized` prop.** Add `directory.weill.cornell.edu` to `next.config.ts` `images.remotePatterns` (mirrors PubMan's `next.config.js:13`). Pass `unoptimized` on the `<Image>` so Next.js does NOT cache or transform the asset — browser hits `directory.weill.cornell.edu` directly, satisfying ADR-009's "no caching layer." Trade-off chosen: keep `next/image`'s automatic width/height attributes and CLS prevention without the optimizer's local cache.

### Claude's Discretion
- **Alt text format, sidebar/search/chip dimensions, env-var name (`SCHOLARS_HEADSHOT_BASE` is a recommendation), component-render-logging hook for "headshot present vs fallback rendered", and the exact loader/error event handler shape** are left to the planner/researcher to settle from existing patterns in `components/ui/avatar.tsx` and the design spec. Default to: alt text = `preferredName` (consistent with other accessible-name patterns in the codebase); sidebar size = whatever the current `h-24 sm:h-28` produces (no design-spec override identified for Phase 1 surfaces); search row size = current `h-12 w-12`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture (LOCKED)
- `.planning/intel/ADDENDUM-new-scope.md` § "ADR-009: Headshot integration" — endpoint syntax, `identityImageEndpoint` field, no proxy / no ETL pre-fetch / no cache, browser-direct hits, surfaces requiring headshots, deferred future enhancement
- `.planning/PROJECT.md` § "Key Decisions" → ADR-009 row — locked decision summary
- `.planning/ROADMAP.md` § "Phase 1: Headshot integration" — goal, dependencies, success criteria, requirements (HEADSHOT-01, HEADSHOT-02)
- `.planning/REQUIREMENTS.md` → HEADSHOT-01, HEADSHOT-02 — acceptance criteria

### Reference Implementation (PubMan — read both files end-to-end)
- `~/Dropbox/GitHub/ReCiter-Publication-Manager/src/components/elements/Profile/Profile.tsx:330-360` — exact rendering pattern with `next/image` + `onError` fallback. Mirror this.
- `~/Dropbox/GitHub/ReCiter-Publication-Manager/config/report.js:113` — `headshotSyntax` constant; reference for the URL template
- `~/Dropbox/GitHub/ReCiter-Publication-Manager/config/local.js:32-33` — `identityImageEndpoint` config field naming; note PubMan uses `returnGenericOn404=true` whereas ADR-009 specifies `=false` (the difference is intentional: we want the directory to return a 404 status so `onError` fires, rather than a generic image that loads successfully)
- `~/Dropbox/GitHub/ReCiter-Publication-Manager/next.config.js:13` — `remotePatterns` config for `directory.weill.cornell.edu`. Mirror this in `next.config.ts`.

### Existing Scholars-Profile-System Code Touched
- `components/ui/avatar.tsx` — `Avatar`, `AvatarImage`, `AvatarFallback`, `AvatarBadge`, `AvatarGroup` already exist with `size` prop ("sm" | "default" | "lg")
- `lib/api/profile.ts:53,213` — `ProfilePayload.headshotUrl` already plumbed; needs to become `identityImageEndpoint` per ADR-009 contract (rename / add)
- `app/api/scholars/[cwid]/route.ts` — scholar API route handler; the shape returned here defines the public API contract referenced by ADR-009 success criterion #4
- `app/(public)/scholars/[slug]/page.tsx:83-85` — profile sidebar Avatar call site (currently fallback-only)
- `app/(public)/search/page.tsx:154-156` — search People-tab row Avatar call site (currently fallback-only)
- `prisma/schema.prisma:25` — `headshotUrl` column (`VarChar(512)`, nullable); stays dormant in this phase per D-03

### Design / UX Context
- `.planning/source-docs/design-spec-v1.7.1.md` — surfaces requiring headshots (full list in ADR-009; only Phase 1 subset is wired here)
- `.planning/source-docs/HANDOFF-2026-04-30.md` — current-state inventory; profile pages render "header" but headshots are not yet wired

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`components/ui/avatar.tsx`** — `Avatar` (with `size` data attribute "sm" | "default" | "lg"), `AvatarImage`, `AvatarFallback`. Phase 1 wraps these into `<HeadshotAvatar>`. The component already supports the size variants Phase 1 needs (sidebar, search row).
- **`initials(name)` utility** — already imported and used at `app/(public)/scholars/[slug]/page.tsx:84` and `app/(public)/search/page.tsx:155`. Used by the new `<HeadshotAvatar>` for the fallback path.
- **Radix UI Avatar primitive** — already a dependency; the existing `AvatarImage` wraps `AvatarPrimitive.Image` which surfaces native `onError`. No extra library needed for the fallback handler.

### Established Patterns
- **Avatar fallback-only is the current pattern** at both call sites — Phase 1's change is purely additive: it adds the `<AvatarImage>` child whose load failure naturally falls through to `AvatarFallback` (Radix UI Avatar primitive's built-in behavior, no manual onError wiring needed in many cases).
- **`/api/scholars/[cwid]` route exists** — the API contract surface is in place; HEADSHOT-01 is just adding a field to the existing payload.
- **`next/image` is not yet used in the repo** — adding it requires the `images.remotePatterns` block in `next.config.ts` (greenfield config edit, not a modification).
- **No `public/` directory exists yet** — confirms the "no asset to ship" choice (D-04) avoids creating one for this phase.

### Integration Points
- **API serializer** (`lib/api/profile.ts` and `app/api/scholars/[cwid]/route.ts`) gains the `identityImageEndpoint` field computed from `${SCHOLARS_HEADSHOT_BASE}/${cwid}.png?returnGenericOn404=false`.
- **Profile sidebar** (`app/(public)/scholars/[slug]/page.tsx:83`) replaces the bare `<Avatar><AvatarFallback/></Avatar>` block with `<HeadshotAvatar size="lg" cwid={...} preferredName={...}/>`.
- **Search row** (`app/(public)/search/page.tsx:154`) same swap, `size="md"` (or "default"/"sm" depending on confirmed dimensions).
- **`next.config.ts`** gains `images.remotePatterns: [{ protocol: 'https', hostname: 'directory.weill.cornell.edu' }]`.
- **ProfilePayload** type renames or adds `identityImageEndpoint: string` (always populated, never null per D-01).

</code_context>

<specifics>
## Specific Ideas

- **Mirror PubMan literally on the rendering pattern** (`Profile.tsx:345-358`). Differences are explicit: `returnGenericOn404=false` (ours) vs `=true` (theirs); shadcn Avatar (ours) vs styled `<Image>` + custom CSS (theirs). The shape — `<Image src={endpoint} onError={() => setFallback(true)} />` falling through to a placeholder — is identical.
- **Single env var (`SCHOLARS_HEADSHOT_BASE`)** governs the directory base URL. Lives in `~/.zshenv` per project credentials convention; no `.env` file commit. Default in code can be the full URL prefix so production deploys can override via AWS Secrets Manager / SSM Parameter Store later.
- **`<HeadshotAvatar>` lives at `components/scholar/headshot-avatar.tsx`** (suggestion — planner may relocate). Three size variants matching the `Avatar` primitive's existing data-size values.

</specifics>

<deferred>
## Deferred Ideas

- **`/api/headshot/:cwid` server-side proxy with cache headers** — explicitly deferred in ADR-009. Revisit if browser-direct hits to `directory.weill.cornell.edu` become a perf or availability issue post-launch. Phase 1 deliberately leaves this hook un-implemented; the `<HeadshotAvatar>` component centralizes the URL so a swap is a one-file change.
- **Drop the `scholar.headshot_url` column** — left dormant in Phase 1; consider removing in a later cleanup phase to avoid stale-schema confusion.
- **Per-surface headshot sizing tokens for Phase 2/3 surfaces** (Recent contributions card, Top scholars chip, department faculty row) — those phases will add new size variants to `<HeadshotAvatar>` if the design spec dimensions don't map onto the existing "sm" | "default" | "lg" set.
- **Component-render logging integration** ("headshot rendered" vs "fallback rendered") — design spec v1.7.1 mandates component-render logs but the logging surface itself is operational-debugging-only and out of scope for this phase. Phase 6 (Polish, analytics, documentation) is the natural home; Phase 1 should at minimum emit a `data-headshot-state="image|fallback"` attribute on the rendered element so logging can be added without a refactor.
- **Alt text accessibility audit** — default to `preferredName` per Claude's discretion in D-07; revisit holistically if a future a11y review surfaces issues.

</deferred>

---

*Phase: 1-Headshot integration*
*Context gathered: 2026-04-30*
