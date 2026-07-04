# Handoff — supercategory "specific entities" drill-down affordance (#1168 follow-up, Option A)

**Created:** 2026-06-22 · **Owner:** Paul Albert · **Status:** ✅ SHIPPED 2026-06-22 — PR #1228 (squash `8b77860a`), CI green, **staging render-verified** (Immortalized=29, Pluripotent=24 → "— N specific cell lines + per-paper usage →"; non-entity family → plain link). Prod remains gated (entity-layer flags off; lights up automatically when enabled). Remaining/optional: prod rollout; the `?cellLine=`→`?entity=` rename (§7). Implementation diverged from §3.3 in one place — the count noun is rendered via a new `entityKindNounForCount` (lib/methods/entity-kind-noun.ts) for correct singular ("1 specific cell line").
**Decision (user, 2026-06-22):** ship **Option A** from `docs/methods-supercategory-entity-badges-scope.md` — keep the supercategory page a family directory; make the existing drill-down link advertise the per-paper entity badges instead of embedding a rail. Option B (embed the entity rail in the supercategory panel) is **out of scope**.

---

## 1. Goal

On a supercategory page (e.g. `/methods/animal-cell-models`), when you select a family that has a specific-entity layer, the panel's existing **"View full {family} method page →"** link should advertise it — e.g.:

> **View Immortalized cell lines — 29 specific cell lines + per-paper usage →**

so the path to the #1168 badges (which live on the family page, on entity selection) is discoverable from the supercategory page. No badges render on the supercategory page itself (that's Option B, declined).

## 2. Current state (verified 2026-06-22, on `origin/master`)

- Supercategory page: `app/(public)/methods/[supercategory]/page.tsx` → builds `railItems: FamilyRailItem[]` (`:70`) from `getSupercategoryRollup(sc.id)` (`:60`) → renders `SupercategoryFamilyLayout` (`:170`).
- Layout: `components/method/family-publication-layout.tsx`, client component `SupercategoryFamilyLayoutInner` (`:104`). When `?family=` is set it renders the active family's `FamilyPublicationFeed` (`:217`) plus the **"View full {activeLabel} method page →"** anchor (`:207`) — **this is the line to enrich.**
- The entity data lives in `family_entity` / `family_entity_usage`, keyed on `(supercategory, family_label)`. Live coverage today = **131 entities across 7 cell-line families, all in `animal_cell_models`** (cancer/immortalized/pluripotent-stem/genetically-engineered/neuronal/hematopoietic/stably-transfected-reporter). All other families have zero entities, so the affordance must render **only when count > 0**.
- Flag: entity reads are gated by `isMethodsLensEntityLayerOn()` (`lib/profile/methods-lens-flags.ts`) = `METHODS_LENS_CELL_LINE_ENTITIES || METHODS_LENS_ENTITY_USAGE`, both ON on staging.

## 3. The build

### 3.1 Data — one grouped reader (NOT 47 per-family queries)
Add to `lib/api/methods.ts`:

```ts
export type FamilyEntitySummary = { count: number; dominantKind: string | null };

/** Per-family count of CLICKABLE specific entities (evidenced + non-generic) for a
 *  supercategory, keyed by familyLabel — drives the supercategory drill-down copy.
 *  One groupBy; {} when the entity layer is off. */
export async function getSupercategoryFamilyEntitySummaries(
  supercategory: string,
): Promise<Record<string, FamilyEntitySummary>> {
  if (!isMethodsLensEntityLayerOn()) return {};
  const rows = await prisma.familyEntity.groupBy({
    by: ["familyLabel", "dominantKind"],
    where: { supercategory, evidenced: true, isGeneric: false },
    _count: { _all: true },
  });
  const out: Record<string, FamilyEntitySummary> = {};
  for (const r of rows) {
    const prev = out[r.familyLabel];
    out[r.familyLabel] = {
      count: (prev?.count ?? 0) + r._count._all,
      dominantKind: prev?.dominantKind ?? r.dominantKind,
    };
  }
  return out;
}
```
(Count **evidenced && !isGeneric** = the rows that actually yield a clickable rail row + snippet. `dominantKind` feeds the noun.)

### 3.2 Thread the count to the panel
- `page.tsx`: call `getSupercategoryFamilyEntitySummaries(sc.slug-or-supercategory-key)` alongside the rollup, and attach `entityCount` (+ optional `entityKind`) to each `FamilyRailItem` (extend the type in `components/method/family-rail.tsx`, **optional** field so other `FamilyRail` callers are unaffected). Match on `family_label`.
- `SupercategoryFamilyLayoutInner`: the active family object already resolves from the rail items; read its `entityCount`/`entityKind`.

### 3.3 The copy (`family-publication-layout.tsx:207`)
When `activeFamily.entityCount > 0`, augment the link. Use the kind noun from `lib/methods/entity-kind-noun.ts` (`entityKindNoun(entityKind).toLowerCase()` → "cell lines"):

```tsx
View full {activeLabel} method page
{entityCount > 0 ? ` — ${entityCount} specific ${entityKindNoun(entityKind).toLowerCase()} + per-paper usage` : ""} →
```
(Exact wording is a design call — confirm with the user; keep it one line.)

## 4. Flag / gating
No new flag. The affordance is naturally gated: the reader returns `{}` (→ `entityCount` undefined → no enrichment) unless `isMethodsLensEntityLayerOn()`. So on prod (entity flags off) the link is unchanged. Optionally also require `isMethodPagesEnabled()` (already gating the page).

## 5. Tests
- Unit: `getSupercategoryFamilyEntitySummaries` — grouping, evidenced/!generic filter, `{}` when flag off (mock the flag + `prisma.familyEntity.groupBy`).
- Render: extend the existing **`tests/unit/supercategory-family-layout-link.test.tsx`** — assert the enriched copy when `entityCount > 0` and the plain copy when 0/undefined.

## 6. Verify (staging)
After merge + CD image-roll, on `/methods/animal-cell-models`:
- select **Pluripotent stem cell lines** (24 entities) or **Immortalized cell lines** (29) → link reads "… — N specific cell lines + per-paper usage →";
- select a non-entity family (e.g. *Primary cell culture models*) → link is the plain "View full … method page →".
- No backfill needed (data already loaded); no flag flip needed (staging entity flags on). Prod stays gated.

## 7. Effort / risk
~½ day. Low risk: additive optional field, one extra grouped query per supercategory render, copy-only UI change, existing flag gate. No new surface, no nesting. Pairs with the deferred `?cellLine=`→`?entity=` rename only if convenient (not required).

## 8. Pointers
- Scope + the rejected Option B: `docs/methods-supercategory-entity-badges-scope.md`.
- #1168 consumer (merged): PR #1210; the badge/rail/flag mechanics.
- Broadening which families have entities (separate, producer-side): `docs/reciterai-extend-entity-layer-handoff.md` (ReciterAI #252) — when that lands and a re-backfill runs, this affordance lights up for the newly-covered families automatically (kind noun adapts via `dominant_kind`).
