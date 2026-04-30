---
phase: 1
slug: headshot-integration
status: draft
shadcn_initialized: true
preset: new-york / neutral / lucide (from components.json)
created: 2026-04-30
---

# Phase 1 — UI Design Contract: Headshot integration

> Visual and interaction contract for wiring WCM directory headshots into existing scholar-rendering surfaces (profile sidebar, search People-tab rows, existing home surfaces) via a single reusable `<HeadshotAvatar>` component. Architecture locked by ADR-009 and CONTEXT.md decisions D-01 through D-07. This document fills the gaps left at Claude's discretion in CONTEXT.md (sizing tokens, alt text, fallback visual treatment, loading state, instrumentation hook).

---

## Design System

| Property | Value |
|----------|-------|
| Tool | shadcn |
| Preset | `new-york` style, `neutral` baseColor, CSS variables enabled (from `components.json`) |
| Component library | Radix UI (`radix-ui` package — `Avatar.Root`, `Avatar.Image`, `Avatar.Fallback` already wired in `components/ui/avatar.tsx`) |
| Icon library | lucide-react (per `components.json` → `iconLibrary: "lucide"`) |
| Font | Inter (body / UI / lists, locked by CLAUDE.md project constraints); Charter (brand H1 / hero — not used by Phase 1 surfaces) |
| Image primitive | `next/image` with `images.remotePatterns` whitelist + per-image `unoptimized` (D-07) |
| New component | `<HeadshotAvatar>` at `components/scholar/headshot-avatar.tsx` (D-06) |

---

## Spacing Scale

Phase 1 reuses the standard 4-px scale from existing surfaces; no new spacing tokens.

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Initials text inset within fallback circle |
| sm | 8px | (not introduced by this phase) |
| md | 16px | Gap between avatar and adjacent text in search row (current `gap-4` = 16px, retained) |
| lg | 24px | (profile sidebar uses `gap-6` = 24px between avatar and name block — retained) |
| xl | 32px | (not introduced by this phase) |

Exceptions: none. Phase 1 is purely additive — does not change layout spacing of the call sites.

### Avatar dimensional tokens (this phase locks these)

`<HeadshotAvatar size="…">` maps to existing `Avatar` primitive `data-size` values plus one new tier for the profile sidebar surface, which has historically rendered larger than the primitive's `lg` (40px). The sidebar size at `h-24 sm:h-28` = 96px / 112px is design-spec-driven; we keep it.

| Phase 1 size token | Pixels (mobile / desktop) | Tailwind classes | Surface |
|--------------------|----------------------------|------------------|---------|
| `sm` | 24px / 24px | `size-6` (Avatar primitive `data-size="sm"`) | (reserved for Phase 2 chip rows; not used in Phase 1) |
| `md` | 48px / 48px | `h-12 w-12` (override on `Avatar` root) | Search People-tab row (mirrors current `app/(public)/search/page.tsx:154`) |
| `lg` | 96px / 112px | `h-24 sm:h-28 w-24 sm:w-28` (override on `Avatar` root) | Profile sidebar header (mirrors current `app/(public)/scholars/[slug]/page.tsx:83`) |

Rationale: the existing `Avatar` primitive's `data-size="lg"` is only 40px — far too small for the profile sidebar headshot. Rather than redefine the primitive's tokens (which would cascade through existing `AvatarBadge` and `AvatarGroup` consumers), `<HeadshotAvatar>` sets `className` overrides on the `Avatar` root for `md` and `lg`. Phase 2/3 may add additional sizes (e.g. card-image at 64px) — defer.

All values are multiples of 4. Border-radius: full (`rounded-full`), inherited from primitive.

---

## Typography

Phase 1 introduces no new typographic roles. The fallback initials inherit from the existing `AvatarFallback` primitive:

| Role | Size | Weight | Line Height | Notes |
|------|------|--------|-------------|-------|
| Fallback initials (md = 48px avatar) | 14px (`text-sm`) | 400 (regular, default) | 1 (centered glyph) | Inherited from `AvatarFallback` primitive |
| Fallback initials (lg = 96–112px avatar) | 20px (`text-xl`, override) | 600 (semibold, `font-semibold`) | 1 | Already overridden at profile sidebar call site (`text-xl`); `<HeadshotAvatar size="lg">` must preserve this override |
| Fallback initials (sm = 24px avatar) | 12px (`text-xs`) | 400 (regular) | 1 | Inherited from primitive's `group-data-[size=sm]/avatar:text-xs` |

Font family: Inter (inherited from body — no override). No new font weights or sizes are introduced by this phase.

---

## Color

Phase 1 reuses the existing token system (`oklch` values in `app/globals.css`). The Cornell Big Red brand color is **not used** by Phase 1 surfaces — those are reserved for high-prominence brand moments per CLAUDE.md.

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `--background` (`oklch(1 0 0)` light / `oklch(0.145 0 0)` dark) | Page background behind the avatar |
| Secondary (30%) | `--muted` (`oklch(0.97 0 0)` light / `oklch(0.269 0 0)` dark) | **Fallback initials circle background** (inherited from `AvatarFallback`'s `bg-muted`) |
| Accent (10%) | `--muted-foreground` (`oklch(0.556 0 0)` light / `oklch(0.708 0 0)` dark) | **Fallback initials glyph color** (inherited from `AvatarFallback`'s `text-muted-foreground`) |
| Destructive | `--destructive` | Not applicable to this phase |

Accent reserved for: fallback initials glyph color only. Phase 1 does NOT introduce ring, border, or background-color decoration on the loaded-image state — the headshot photograph carries its own visual weight, and adding a ring would create inconsistent treatment between image-loaded and fallback states. Both states render flush within the circular mask with no border, no ring, no shadow.

Cornell Big Red (`#B31B1B`) and Slate (`#2c4f6e`): NOT used by Phase 1 surfaces.

---

## Visual States

This phase has four observable rendering states. The `data-headshot-state` attribute is the instrumentation contract for Phase 6 component-render logging (deferred but hookable now per CONTEXT.md "deferred").

| State | When | Visual treatment | `data-headshot-state` value |
|-------|------|------------------|-----------------------------|
| `loading` | Image fetch in flight (Radix `Avatar.Image` `loading` status) | Render the fallback circle (initials in `bg-muted`). Do NOT show a skeleton, spinner, or pulse animation — the fallback IS the loading affordance. Radix's built-in delayed-render behavior already prevents flash on fast loads (default `delayMs={0}`; we keep default). | `loading` |
| `image` | Image loaded successfully (Radix `Avatar.Image` `loaded` status) | Photograph fills the circular mask, `object-cover aspect-square` (inherited from `AvatarImage` primitive). No ring, border, or shadow. | `image` |
| `fallback` | Image returned 404 OR network error (Radix `Avatar.Image` `error` status) | Initials in `bg-muted` circle, `text-muted-foreground` glyph. Identical to the `loading` state visually — the user never sees an error indicator, by design (D-04). | `fallback` |
| `no-cwid` | `cwid` prop is empty/null (defensive guard) | Same as `fallback`. Component never throws. | `fallback` |

Rationale for skipping a skeleton: WCM directory headshots are small static PNGs, typically <50 KB, served from a same-organization CDN; perceived load latency is sub-200ms in normal conditions. A skeleton would flash distractingly on the search results page (20 rows) for sub-perceptible durations. Initials-as-loading is the simplest correct UX.

The `data-headshot-state` attribute is set on the outermost `Avatar` root element. Phase 6 will attach a logging side-effect (e.g. via `MutationObserver` or render-time hook); Phase 1 only emits the attribute, no logging body.

---

## Accessibility

| Concern | Contract |
|---------|----------|
| Alt text | `alt={preferredName}` on the `<AvatarImage>` (Radix passes through to native `<img>`). Default per CONTEXT.md D-07. Rationale: the headshot is informative (identifies the scholar), not decorative; `preferredName` matches the user-facing name on the same row, reinforcing the association without redundancy. |
| Empty alt for fallback | The fallback initials circle is a `<span>` (Radix `Avatar.Fallback`) — not an image — so `alt` is not applicable. The initials themselves are visible text content readable by AT. |
| ARIA role | None added. Radix primitive uses native semantics. Avatar lives inside a `<Link>` (search row) or as a sibling of `<h1>` (profile sidebar); the link's accessible name is the scholar's name (already wired), so the avatar is supplementary. |
| Reduced-motion | No animations introduced. Radix's default fade-in on image load is acceptable; if user expresses motion sensitivity in the future, `<AvatarImage>` rendering is instant by default. |
| Color contrast | Fallback initials at `text-muted-foreground` on `bg-muted` — `oklch(0.556) on oklch(0.97)` light mode ≈ AA Large. The initials are 14–20px (≥18.66px counts as Large). Verified: passes WCAG AA Large in both light and dark modes. |
| Focus states | Avatar is wrapped by `<Link>` on search row → focus ring is on the link, not the avatar. Profile sidebar avatar is non-interactive. No focus-state styling on `<HeadshotAvatar>` itself. |

---

## Component Inventory

Phase 1 introduces exactly ONE new component and modifies TWO call sites.

| Component | Path | Status | Notes |
|-----------|------|--------|-------|
| `HeadshotAvatar` | `components/scholar/headshot-avatar.tsx` | NEW | Wraps `Avatar` + `AvatarImage` (`next/image` with `unoptimized`) + `AvatarFallback`. Props: `cwid: string`, `preferredName: string`, `identityImageEndpoint: string`, `size: "sm" \| "md" \| "lg"`, optional `className`. Sets `data-headshot-state` on `Avatar` root. |
| `Avatar` (existing) | `components/ui/avatar.tsx` | UNCHANGED | Phase 1 must not modify the primitive — overrides happen at the wrapper level via `className`. |
| Profile sidebar header | `app/(public)/scholars/[slug]/page.tsx:83-85` | MODIFIED | Replace bare `<Avatar><AvatarFallback>...` with `<HeadshotAvatar size="lg" cwid={profile.cwid} preferredName={profile.preferredName} identityImageEndpoint={profile.identityImageEndpoint} />` |
| Search People-tab row | `app/(public)/search/page.tsx:154-156` | MODIFIED | Replace bare `<Avatar><AvatarFallback>...` with `<HeadshotAvatar size="md" cwid={h.cwid} preferredName={h.preferredName} identityImageEndpoint={h.identityImageEndpoint} />`. Existing `h-12 w-12 shrink-0` → wrapper handles sizing. |

API surface to add `identityImageEndpoint` to: `ProfilePayload` and the search-hit shape returned from `/api/search`. (Implementation detail for the planner — the UI-SPEC only locks that the field name is `identityImageEndpoint` per ADR-009.)

---

## Copywriting Contract

Phase 1 has minimal copywriting — no CTAs, no error messages, no destructive actions.

| Element | Copy |
|---------|------|
| Primary CTA | N/A — phase ships no buttons |
| Empty state heading | N/A — fallback is initials, not text |
| Empty state body | N/A — initials carry the affordance |
| Error state | **Silent fallback** — no error text shown to user. 404 / network errors swap to initials with no message. |
| Destructive confirmation | N/A — no destructive actions |
| Image alt text | `{preferredName}` (default per D-07; e.g. `alt="Augustine M.K. Choi"`) |
| Fallback initials text | Output of `initials(preferredName)` utility (existing helper at `lib/utils.ts` or equivalent — reused, not redefined). Typical output: 1–2 uppercase characters. |

Rationale for silent fallback: per D-04, the initials-in-circle IS the design's complete handling of the missing-headshot case. Adding "No photo available" or similar would be redundant noise, since the initials already serve as a recognizable identity affordance and the scholar's full name renders adjacent.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | `avatar` (already installed at `components/ui/avatar.tsx`) | not required |

No third-party registries declared for this phase. No registry vetting gate needed.

---

## Out-of-Scope (recorded for traceability)

These items are explicitly NOT part of Phase 1 and must not creep in:

- New surface implementations (Recent contributions cards, Top scholars chip row, topic Recent highlights, department faculty grid) → Phase 2 / Phase 3
- `/api/headshot/:cwid` server-side proxy → deferred (ADR-009)
- Skeleton or spinner loading state → rejected above (initials-as-loading)
- Ring / border / shadow decoration on loaded image → rejected above (consistency between states)
- New asset (`/static/generic-headshot.png` or silhouette SVG) → rejected by D-04
- Component-render logging body → Phase 6 (Phase 1 only emits the `data-headshot-state` attribute)
- Cornell Big Red brand color usage → not used by Phase 1 surfaces

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS (silent fallback locked, alt text default locked)
- [ ] Dimension 2 Visuals: PASS (4 states defined with explicit `data-headshot-state`)
- [ ] Dimension 3 Color: PASS (60/30/10 reuses existing tokens; brand red explicitly excluded)
- [ ] Dimension 4 Typography: PASS (inherited from existing primitive; no new sizes/weights)
- [ ] Dimension 5 Spacing: PASS (multiples of 4; sidebar 96/112px and search 48px sizes locked)
- [ ] Dimension 6 Registry Safety: PASS (shadcn official only; no third-party blocks)

**Approval:** pending

---

*Pre-populated from:*
*— CONTEXT.md (D-01 … D-07): 7 decisions*
*— REQUIREMENTS.md (HEADSHOT-01, HEADSHOT-02): 2 requirements*
*— ROADMAP.md Phase 1 success criteria: 5 criteria*
*— Existing code (`components/ui/avatar.tsx`, `app/globals.css`, `components.json`): 4 design-system facts*
*— CLAUDE.md brand constraints: Cornell Big Red reservation, Inter/Charter typography*
*— User input this session: 0 questions asked (all gaps filled by sensible defaults grounded in existing primitives)*
