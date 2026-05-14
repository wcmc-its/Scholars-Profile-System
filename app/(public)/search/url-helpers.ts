/**
 * URL helpers for the /search page.
 *
 * Lifted out of `page.tsx` so unit tests can import them without dragging
 * in Prisma + the full server-rendered page module. Pure functions only.
 */

/**
 * Issue #259 §1.11 — build the "Search broadly instead" link href.
 *
 * Preserves user-applied filters (year, journal, publicationType, etc.)
 * verbatim and sets `mesh` to the requested value (currently only `"off"`;
 * passed explicitly so a future "Re-enable concept resolution" affordance
 * can call the same helper with `"on"`).
 *
 * Three params are intentionally dropped:
 *
 *   - `mesh`: replaced by the explicit `meshValue` argument.
 *   - `page`: broadening grows the candidate set; resetting to page 0
 *     avoids landing the user on an empty paginated tail.
 *   - `sort`: the §1.8 sort options `impact` and `recency` are tightly
 *     coupled to a resolved concept (Impact orders by per-doc MAX impact
 *     score, which only carries the "Concept impact" badge when a
 *     descriptor resolved). Dropping `sort` lets the page fall back to
 *     its default — `recency` for empty queries on the pub tab, otherwise
 *     `relevance` — which is what users expect when they explicitly
 *     escape concept-aware mode.
 *
 * Array values (repeated query params like `journal=Nature&journal=Cell`)
 * are emitted in their original order so multi-select facets survive.
 */
const STRIPPED_ON_BROADEN = new Set(["mesh", "page", "sort"]);

export function buildBroadenHref(
  sp: Record<string, string | string[] | undefined>,
  meshValue: "off" | "on",
): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (STRIPPED_ON_BROADEN.has(k)) continue;
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.append(k, item);
    else out.append(k, v);
  }
  out.set("mesh", meshValue);
  const qs = out.toString();
  return qs.length > 0 ? `/search?${qs}` : "/search";
}
