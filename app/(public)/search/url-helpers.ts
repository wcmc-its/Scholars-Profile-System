/**
 * URL helpers for the /search page.
 *
 * Lifted out of `page.tsx` so unit tests can import them without dragging
 * in Prisma + the full server-rendered page module. Pure functions only.
 */

/**
 * Issue #259 §1.11 / §6.2 — params dropped on every mesh-mode transition.
 *
 *   - `mesh`: replaced by the explicit `mode` argument.
 *   - `page`: every transition (broaden, narrow, expand) changes the
 *     candidate-set size; resetting to page 0 avoids landing the user on
 *     an empty paginated tail or stale offset.
 *   - `sort`: the §1.8 sort options `impact` and `recency` are tightly
 *     coupled to a resolved concept (Impact orders by per-doc MAX impact
 *     score, which only carries the "Concept impact" badge when a
 *     descriptor resolved). Dropping `sort` lets the page fall back to
 *     its default — `recency` for empty queries on the pub tab, otherwise
 *     `relevance` — which is what users expect after escaping concept mode.
 *
 * Array values (repeated query params like `journal=Nature&journal=Cell`)
 * are emitted in their original order so multi-select facets survive.
 */
const STRIPPED_ON_MESH_TRANSITION = new Set(["mesh", "page", "sort"]);

/**
 * Issue #259 §6.2 — build a URL that engages or clears a specific mesh
 * mode. Three values:
 *
 *   "off"    → "Don't use MeSH" / "Search broadly instead" (existing §1.11)
 *   "strict" → "Narrow to this concept only" (NEW chip affordance in §6.1)
 *   "clear"  → remove the mesh param entirely (re-engage default expanded mode)
 *
 * Chip-link generators MUST NOT emit a URL with both `mesh=strict` and
 * `mesh=off` simultaneously — this helper overwrites any existing `mesh`
 * param so a single output is guaranteed. The server-side precedence
 * (off-wins) in `parseMeshParam` is the second line of defense for
 * hand-crafted/pasted URLs.
 */
export function buildMeshHref(
  sp: Record<string, string | string[] | undefined>,
  mode: "off" | "strict" | "clear",
): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (STRIPPED_ON_MESH_TRANSITION.has(k)) continue;
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.append(k, item);
    else out.append(k, v);
  }
  if (mode !== "clear") out.set("mesh", mode);
  const qs = out.toString();
  return qs.length > 0 ? `/search?${qs}` : "/search";
}

/**
 * @deprecated Use `buildMeshHref(sp, "off" | "strict" | "clear")` instead.
 * Kept for callers not yet migrated. Behavior preserved verbatim: sets the
 * `mesh` param to the literal string value passed; `page` and `sort` are
 * stripped on every call. Removed in a follow-up cleanup once all callers
 * migrate.
 */
export function buildBroadenHref(
  sp: Record<string, string | string[] | undefined>,
  meshValue: "off" | "on",
): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (STRIPPED_ON_MESH_TRANSITION.has(k)) continue;
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.append(k, item);
    else out.append(k, v);
  }
  out.set("mesh", meshValue);
  const qs = out.toString();
  return qs.length > 0 ? `/search?${qs}` : "/search";
}
