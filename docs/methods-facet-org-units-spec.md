# Methods & tools facet on department/division rosters — #974 Phase 2

Status: **Implemented** — Phase 1 (per-row chips) shipped in #976; Phase 2 (the multi-select facet) shipped in #983. Dark behind `ORG_UNIT_METHODS_FACET` (+`METHODS_LENS_ENABLED`). (Spec reconciled to shipped code 2026-06-14, #990.)

## Problem

Department/division rosters (`/departments/[slug]`, `/departments/[slug]/divisions/[div]`) are flat and **server-paginated (20/page)** via `getDepartmentFaculty` / `getDivisionFaculty`, with no facet sidebar (only a client-side Role chip row). The center's facet model is **client-side over all members on one page** — that cannot apply here: the largest dept (Medicine) has **2,713 active members / 542 families**, so we can neither full-load nor scroll. A facet must filter **server-side** over the whole unit.

## Why not URL-param server rendering

`/departments/*` is a CloudFront query-keyed-cache behavior with a **hardcoded query-string allow-list** (`mentees-sort, page, tab, sort, q, role` — `cdk/lib/edge-stack.ts`). A `?method=` param is **stripped at the edge** before the origin sees it. Driving the facet via the page URL would require adding `method` to that allow-list **plus an EdgeStack redeploy** (the high-risk deploy needing `env`/`edgeCustomDomain`/`edgeCertArn`/`edgeAllowedCidrs` context). Out of proportion for this feature.

## Design — client-fetch to an uncacheable API (keeps the page cacheable)

### A. Facet buckets (rendered with the page — cacheable)
- New `aggregatePublicFamiliesForUnit(memberCwids, { enabled })` in `lib/api/methods-roster.ts`: one `scholarFamily.groupBy([supercategory, familyLabel])` over the unit's **full active member CWIDs**, through the **same #800/#801 overlay gate** (public-only), returning `FacetOption[] { value: sc::label, label, count: distinct members }` sorted count-desc.
- `getDepartmentFaculty` / `getDivisionFaculty` gain a cheap `select cwid` of the unit's **full** active member set (separate from the paginated page) to feed the aggregation. Attached to the result as `methodFacet?: FacetOption[]` when the flag is on; viewer-independent → **page stays CloudFront-cacheable**, no allow-list change.

### B. Filtered members (interaction — uncacheable API)
- New route `app/api/units/[kind]/[code]/members/route.ts` (`kind` = `department|division`), `export const dynamic = "force-dynamic"` (mirrors `app/api/methods/[supercategory]/families/[familyId]/scholars/route.ts`; lands in CloudFront #634 Group A `CachingDisabled`/`AllViewer`).
  - **The route file only sanitizes input and delegates** — flag-gate (404 when off), validate `kind`/`code`/`method` keys/`page` (regex, no logging, like the existing methods route), then call `getUnitMembersByMethods` and JSON-return its result. No DB query or filtering lives inline in the route.
  - Input: validated `code`, repeatable `method` (sc::label keys), `page`.
  - Logic (in `lib/api/unit-members.ts` `getUnitMembersByMethods`, **not** the route): unit active members → members having ≥1 selected family (**OR** within facet) via `scholarFamily.findMany({ where: { supercategory/familyLabel OR-set, cwid: { in: members }, scholar: { deletedAt: null, status: "active" } } })` → paginate that filtered set → return the same `DepartmentFacultyHit[]` shape (incl. `topMethods` chips) + `total`.
- Public-only overlay gate applied to the selectable families AND the returned chips (never surface suppressed/sensitive).

### C. Client wiring
- Add a facet sidebar to `components/department/department-faculty-client.tsx` (aside + main, mirroring the center grouped layout), shown only when the flag is on AND `methodFacet` is non-empty.
- Reuse the #972 `RosterFacet` with `searchable` (the typeahead is needed — dept facets run 69–542 families).
- Selection is **client state**; on change, fetch `/api/units/[kind]/[code]/members?method=…&page=1` and replace the rendered member list + `total` + pagination. No selection → the server-rendered page-0 roster (unchanged).
- **Deselect / clear-all UX** (as shipped — confirm against the roster client `components/department/department-faculty-client.tsx`): a single chip toggles in/out of the selection — clicking a selected `RosterFacet` option removes just that method (the `onToggle`/`makeToggle` Set toggle); a separate **"Clear"** button (rendered only when ≥1 method is selected) empties the whole selection. Either action resets to the first filtered page; clearing all empties the selection so the SSR roster re-renders.
- **URL reflection (optional, deep-linkable):** reflect selection in `?method=` via `history.replaceState`; on mount read `window.location` and apply. The page HTML stays the cached unfiltered shell (the edge strips the param for the origin); the client reapplies the filter. So shared links work **without** a CDN change.

### D. Composition with the Role chip + sort
- The Role chip + sort stay client-side over the **currently rendered** member set (page-only, as today). Selecting a method replaces that set with the API's filtered page, then Role/sort apply on top. No cross-facet smart-counting between Role and Methods in v1 (single new facet; Methods counts are unit-wide, stable).

## Flag / gate
- New `ORG_UNIT_METHODS_FACET` (+ `METHODS_LENS_ENABLED`), helper in `lib/profile/methods-lens-flags.ts`. Off → no aggregation, no sidebar, no API data, no payload (byte-identical to today). cdk `app-stack.ts` staging-`on`/prod-`off` + snapshot. The API route itself is also flag-gated (404/empty when off).

## Tests
- Aggregation: public-only (suppressed + sensitive #801 excluded), counts = distinct members, count-desc.
- API route: OR-within-facet filtering; pagination of the filtered set; flag-off → gated; bad input → 400; suppressed/sensitive family never selectable nor in chips.
- Loader: full-member-cwid fetch + `methodFacet` attached only when flag on; off → nothing.
- Client: sidebar renders only when flag on + families present; selecting a method fetches + replaces; Role chip still filters the result.

## Out of scope (Phase 2)
- Cross-facet smart counts (Role × Methods). Center-style all-client faceting (infeasible at dept scale). Generic-method demotion (tracked on #972 follow-up). Server-side Role filtering (pre-existing client-only limitation, unchanged).

## Rollout
Ships dark on prod. Staging activation = `cdk deploy --exclusively Sps-App-staging` (new flag env). Refs #962, #972, #974, #976.
