/**
 * THE choke point (SPEC §5.4.1) for turning a `Publication.meshTerms` JSON
 * value into a deduped NLM MeSH descriptor-UI list.
 *
 * Both indices route through this so they carry byte-identical UI sets for the
 * same publication:
 *   - publications index → `meshDescriptorUi`  (lib/search-index-docs.ts)
 *   - funding index      → `fundedPubMeshUi`   (lib/funding-projection.ts)
 * The funding concept gate filters `fundedPubMeshUi ∩ descendantUis`, so any
 * extraction drift between the two would silently break the gate. Keeping the
 * extractor in one dependency-free module lets the ETL funding projection reuse
 * it without dragging in any search-runtime imports.
 *
 * The JSON column shape verified 2026-05: 100% of rows with non-empty
 * `mesh_terms` are arrays of `{ ui, label }` objects. No bare-string rows
 * remain in production; we only emit UIs from the object shape.
 *
 * Returns deduped UIs in source order. Drops rows missing a valid string `ui`
 * (defensive — should be unreachable under the ETL contract per #278).
 */
export function extractMeshDescriptorUis(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || !("ui" in item)) continue;
    const ui = (item as { ui: unknown }).ui;
    if (typeof ui !== "string" || ui.length === 0) continue;
    if (seen.has(ui)) continue;
    seen.add(ui);
    out.push(ui);
  }
  return out;
}
