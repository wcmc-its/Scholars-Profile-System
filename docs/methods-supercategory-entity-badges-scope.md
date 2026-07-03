# Scope — per-paper usage badges on the supercategory page (#1168 follow-up)

**Created:** 2026-06-22 · **Owner:** Paul Albert · **Status:** SCOPE (no code)
**Context:** #1168 shipped the per-paper usage snippet + "How it was used" / "Where it appears" badge on **method family** pages (live on staging). The ask: surface those badges on the **supercategory** page (`/methods/animal-cell-models`) too.

---

## 1. Where the badge lives today vs. the supercategory page

The badge is a **family-page, entity-selected** feature: on a family page you pick a cell line from the rail (`?cellLine=`), and the publication feed reveals that entity's per-paper sentence + badge (`FamilyPublicationFeed` → `SnippetUsageBadge`).

The **supercategory page** (`app/(public)/methods/[supercategory]/page.tsx` → `SupercategoryFamilyLayout`) is a different master-detail:
- left: a **`FamilyRail`** ("FAMILIES (47)") — you select a *family*, not an entity, via `?family=`;
- right: when a family is selected it renders **the same `FamilyPublicationFeed`** (`family-publication-layout.tsx:217`) + a **"View full {family} method page →"** drill-down link (`:207`).

**The badge mechanism is therefore already present** (the supercategory panel reuses `FamilyPublicationFeed`), but it is **inert there** for two reasons:
1. **No entity rail** in the supercategory panel — nothing sets `?cellLine=`.
2. **`cellLineLabels` is not passed** to that `FamilyPublicationFeed` (`:217-221` omits the prop), so even a hand-crafted `?cellLine=` is ignored (the feed gates on `cellLineLabels?.[id]`).

So this is **not a data gap** (the entity data is the same `family_entity*` tables) — it's a **UI-wiring + IA decision**.

## 2. Two options

### Option A — drill-down affordance (recommended; small; IA-aligned)
Keep the supercategory page as a **family directory**; per-paper entity badges stay one level down on the family page (where you've drilled into a specific entity). The panel **already** links "View full {family} method page →".

Change: enrich that affordance when the selected family has entities — e.g. *"View N specific cell lines + per-paper usage →"* — so the path to the badges is discoverable from the supercategory page without nesting a third rail.

- **Files:** `family-publication-layout.tsx` (`SupercategoryFamilyLayoutInner`, the link at `:207`); a count comes from `getFamilyCellLineEntities(supercategory, activeLabel)` (already exists) threaded into the layout props (server side, in `page.tsx`).
- **Effort:** ~½ day. No new surface, no nesting, no new flag (or reuse `METHODS_LENS_ENTITY_USAGE`).
- **Trade-off:** badges still don't *render* on the supercategory page itself — but arguably that's correct: a directory points you in, the detail lives in the family page.

### Option B — embed the entity rail + badges in the supercategory panel (full; larger)
When a family with entities is selected on the supercategory page, render its **`CellLineRail`** inside the panel and pass `cellLineLabels` to the panel's `FamilyPublicationFeed`, so selecting a cell line reveals the snippet + badge **without leaving the supercategory page**.

- **Files:** `page.tsx` (fetch the selected family's entities + labels — but `?family=` is client-state, so this needs either a client fetch of `getFamilyCellLineEntities` on family-select, or pre-fetching entities for all rail families server-side — the latter is 47× the per-family query, the former adds a request on each family click); `family-publication-layout.tsx` `SupercategoryFamilyLayoutInner` (mount `CellLineRail`, thread `cellLineLabels`, share the `?cellLine=` param alongside `?family=`); `CellLineRail` already generic.
- **Effort:** ~2–3 days + design review.
- **Trade-offs / risks:**
  - **Rail-in-rail-in-panel** nesting (`FamilyRail` → family panel → `CellLineRail` → feed) — real UX-density risk; needs a mockup.
  - **Data fetch shape:** server-prefetching entities for all 47 families is wasteful (only ~7 have any); client-fetching on family-select is cleaner but adds latency + a loading state.
  - **URL state:** two coupled params (`?family=` + `?cellLine=`) on one page — clearing/resetting semantics need care.
  - Only **7 of 47** families (all cell-line) have entities today, so for 40/47 families the embedded rail would be empty — reinforcing that Option A (drill-down) is the better default until the entity layer is broader (see the ReciterAI handoff, #252).

## 3. Recommendation
**Ship Option A now** (cheap, correct IA, discoverable). Revisit Option B only if, after the entity layer is generalized to more families (ReciterAI #252) **and** usage shows people want entity-level detail without leaving the supercategory page. Gate either behind `METHODS_LENS_ENTITY_USAGE` (already staging-on).

## 4. Out of scope / dependencies
- Broadening *which* families have entities is **producer-side** (ReciterAI #252 / the entity-layer-extension handoff) — neither option here changes the data coverage.
- The `?cellLine=`→`?entity=` cosmetic rename (deferred from #1210) would land naturally if Option B is built.
