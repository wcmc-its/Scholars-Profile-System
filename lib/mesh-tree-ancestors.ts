/**
 * Shared MeSH tree-number ANCESTOR resolution (issue: search reason-from-doc).
 *
 * The MeSH hierarchy is encoded in dot-segmented tree numbers: a descriptor with
 * tree number `C04.557.470.200.025` is a descendant of `C04.557.470.200`, which
 * is a descendant of `C04.557.470`, … up to the top-level category `C04`. So a
 * descriptor's ANCESTOR concepts are exactly the descriptors that own a tree
 * number which is a (dot-segment) PREFIX of one of this descriptor's tree
 * numbers — the REVERSE of the descendant walk in `lib/api/search-taxonomy.ts`'s
 * `computeDescendants` (which finds descriptors whose tree numbers are prefixed
 * BY the resolved concept's).
 *
 * `search-taxonomy.ts` already loads `mesh_descriptor.tree_numbers` to compute
 * the downward `descendantUis`. This module is the upward counterpart and is
 * dependency-free (no prisma / no search-runtime imports), so both the query-time
 * resolver and the ETL people-doc builder share ONE tree-number→descriptor
 * implementation and can't drift.
 *
 * Tree-number prefix semantics: split on ".". `tn` is an ancestor tree number of
 * `child` iff `child === tn` (self) or `child` starts with `${tn}.` — i.e. `tn`'s
 * segments are a leading run of `child`'s segments. String `startsWith` on the
 * dotted form is exact for this because segments are dot-delimited and the dot is
 * appended, so `C04.5` never matches `C04.55` (`"C04.55".startsWith("C04.5.")` is
 * false). This mirrors the descendant walk's `cand.startsWith(`${tn}.`)` check.
 */

export type MeshTreeRow = {
  /** NLM descriptor UI (e.g. `D000086382`). */
  ui: string;
  /** The descriptor's tree numbers (e.g. `["C04.557.470", "C16.131.077"]`). */
  treeNumbers: ReadonlyArray<string>;
};

/**
 * An index that maps each tree number to the descriptor UI(s) that own it,
 * built once from the full descriptor set and reused for every ancestor lookup.
 * (A tree number maps to exactly one descriptor under the NLM contract, but the
 * value is a set so a data anomaly with two owners degrades to a union, not a
 * dropped row.)
 */
export type MeshAncestorIndex = {
  /** treeNumber → owning descriptor UIs. */
  uiByTreeNumber: Map<string, Set<string>>;
};

/**
 * Build the tree-number→UI index. O(total tree numbers). Pass every descriptor's
 * `{ ui, treeNumbers }`; empty / missing tree numbers are skipped.
 */
export function buildMeshAncestorIndex(rows: Iterable<MeshTreeRow>): MeshAncestorIndex {
  const uiByTreeNumber = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.ui) continue;
    for (const tn of r.treeNumbers) {
      if (typeof tn !== "string" || tn.length === 0) continue;
      const owners = uiByTreeNumber.get(tn);
      if (owners) owners.add(r.ui);
      else uiByTreeNumber.set(tn, new Set([r.ui]));
    }
  }
  return { uiByTreeNumber };
}

/**
 * The dot-segment prefixes of a tree number, longest-to-shortest INCLUDING the
 * tree number itself. `C04.557.470` → `["C04.557.470", "C04.557", "C04"]`.
 * Pure string work — no index needed.
 */
export function treeNumberPrefixes(tn: string): string[] {
  const out: string[] = [];
  let i = tn.length;
  while (i > 0) {
    out.push(tn.slice(0, i));
    const dot = tn.lastIndexOf(".", i - 1);
    if (dot < 0) break;
    i = dot;
  }
  return out;
}

/**
 * Ancestor descriptor UIs (concepts whose subtree CONTAINS `ui`), INCLUDING `ui`
 * itself — symmetric with `computeDescendants`, whose result always leads with
 * the descriptor itself. A descriptor reachable via two of `ui`'s tree numbers
 * appears once (deduped).
 *
 * Returns `[ui]` (self only) when the descriptor has no tree numbers — the same
 * degenerate-row contract `computeDescendants` uses.
 */
export function ancestorUisFor(
  index: MeshAncestorIndex,
  ui: string,
  treeNumbers: ReadonlyArray<string>,
): string[] {
  const out: string[] = [ui];
  const seen = new Set<string>([ui]);
  for (const tn of treeNumbers) {
    if (typeof tn !== "string" || tn.length === 0) continue;
    for (const prefix of treeNumberPrefixes(tn)) {
      const owners = index.uiByTreeNumber.get(prefix);
      if (!owners) continue;
      for (const ownerUi of owners) {
        if (seen.has(ownerUi)) continue;
        seen.add(ownerUi);
        out.push(ownerUi);
      }
    }
  }
  return out;
}
