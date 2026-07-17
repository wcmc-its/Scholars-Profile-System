/**
 * #1166 — the entity layer (family_entity + family_entity_usage) is a full-replace
 * projection driven by TWO paired manifest sidecars, `entities.json` (the entity
 * DIMENSION) and `entity_context.json` (the per-(pub × entity) FACTS).
 *
 * A manifest is "entity-complete" only when BOTH sidecars are declared. A pre-v4 or
 * partial manifest that omits either one must leave the entity tables UNTOUCHED — the
 * tools ETL previously ran the entity `deleteMany` unconditionally, so a manifest
 * missing one sidecar silently zeroed ~4k dimension rows + ~4k usage rows on a run
 * that still reported success (the `tools:scholar-tool` stub incident, in a different
 * table). Both the load-side guard and the write-side guard in `index.ts` decide from
 * this one predicate, and the regression test locks the `||` semantics (missing EITHER
 * ⇒ not complete).
 *
 * Kept in its own module (not `index.ts`) because `index.ts` self-runs `main()` on
 * import — a test importing from it would execute the ETL. Param is typed structurally
 * so this stays dependency-free.
 */
export function entityLayerComplete(manifest: {
  objects?: Record<string, { key?: string } | undefined>;
}): boolean {
  return Boolean(manifest.objects?.["entities.json"]?.key && manifest.objects?.["entity_context.json"]?.key);
}
