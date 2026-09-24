/**
 * Unit Page v2 — per-member top MeSH terms for the roster TOPICS chips.
 *
 * Source: the OpenSearch people index's `topMeshTerms` (built by
 * `topMeshTermsFromCounts` in lib/search-index-docs.ts over the
 * suppression-filtered authorship set; doc `_id` = cwid). No MySQL table holds
 * a per-scholar top-MeSH list, and rebuilding it from `Publication.meshTerms`
 * per roster page would be far heavier than one `ids` query.
 *
 * One OpenSearch round trip per roster page (chunked at 1000 ids for grouped
 * centers), never one per row. Server-only: imports the search client — never
 * import this from a client component (use lib/roster-row-tags.ts for types).
 *
 * Failure semantics: the inner load THROWS on an OpenSearch error, so
 * swr-cache (which only stores resolved values) never caches a failure; the
 * public loader catches and degrades to an empty Map (chipless rows). Callers
 * attach the result OUTSIDE their own cached roster reads so a degraded empty
 * is never baked into the roster's swr entry either.
 */
import { createHash } from "node:crypto";
import { PEOPLE_INDEX, searchClient } from "@/lib/search";
import { cachedRead } from "@/lib/api/swr-cache";
import type { RosterMeshChip } from "@/lib/roster-row-tags";

/** The mock shows 2–3 TOPICS chips per row; no "+N more". */
export const ROSTER_ROW_MESH_CAP = 3;

const IDS_CHUNK = 1000;
// The roster SSR runs outside `runWithOsRoundTripCounter`, so the fail-fast
// wrapper in lib/search.ts does not apply and the client default is 30s — which
// would hang an ISR render / build prerender on an unreachable cluster.
const TRANSPORT_OPTS = { requestTimeout: 1500, maxRetries: 0 } as const;

type RawMeshTerm = string | { ui?: string | null; label?: string | null };

function toChips(raw: unknown): RosterMeshChip[] {
  if (!Array.isArray(raw)) return [];
  const chips: RosterMeshChip[] = [];
  for (const t of raw as RawMeshTerm[]) {
    const chip =
      typeof t === "string"
        ? { ui: null, label: t }
        : t && typeof t === "object"
          ? { ui: t.ui ?? null, label: t.label ?? "" }
          : null;
    if (!chip || chip.label.trim().length === 0) continue;
    chips.push(chip);
    if (chips.length >= ROSTER_ROW_MESH_CAP) break;
  }
  return chips;
}

async function loadTopMeshUncached(sorted: string[]): Promise<Array<[string, RosterMeshChip[]]>> {
  const out: Array<[string, RosterMeshChip[]]> = [];
  for (let i = 0; i < sorted.length; i += IDS_CHUNK) {
    const chunk = sorted.slice(i, i + IDS_CHUNK);
    const res = await searchClient().search(
      {
        index: PEOPLE_INDEX,
        body: {
          query: { ids: { values: chunk } },
          _source: ["topMeshTerms"],
          size: chunk.length,
          track_total_hits: false,
        },
      },
      TRANSPORT_OPTS,
    );
    type MeshHit = { _id: string; _source?: { topMeshTerms?: unknown } };
    const hits = (res.body as unknown as { hits?: { hits?: MeshHit[] } }).hits?.hits ?? [];
    for (const h of hits) {
      const chips = toChips(h._source?.topMeshTerms);
      if (chips.length > 0) out.push([h._id, chips]);
    }
  }
  return out;
}

/**
 * cwid → top ≤3 MeSH chips for the given members. A member with no terms (or
 * absent from the people index) is absent from the map. Never throws: an
 * OpenSearch failure resolves to an empty map and logs one warning.
 */
export async function loadTopMeshForMembers(
  cwids: string[],
): Promise<Map<string, RosterMeshChip[]>> {
  const sorted = [...new Set(cwids)].sort();
  if (sorted.length === 0) return new Map();
  try {
    const key = `roster:mesh:${createHash("sha256").update(sorted.join(","), "utf8").digest("hex")}`;
    const entries = await cachedRead(key, () => loadTopMeshUncached(sorted));
    return new Map(entries);
  } catch (err) {
    console.warn(
      `[roster-mesh] topMeshTerms lookup failed for ${sorted.length} members; rendering without TOPICS chips:`,
      err instanceof Error ? err.message : err,
    );
    return new Map();
  }
}

/** Set `topMesh` on each hit that has terms; a hit without terms is returned
 *  unchanged (same payload shape as before). */
export function withTopMesh<T extends { cwid: string }>(
  hits: T[],
  mesh: Map<string, RosterMeshChip[]>,
): T[] {
  return hits.map((h) => {
    const chips = mesh.get(h.cwid);
    return chips && chips.length > 0 ? { ...h, topMesh: chips } : h;
  });
}

/** Load + attach in one step, for a single page of hits. */
export async function attachTopMesh<T extends { cwid: string; isExternal?: true }>(
  hits: T[],
): Promise<T[]> {
  const cwids = hits.filter((h) => !h.isExternal).map((h) => h.cwid);
  if (cwids.length === 0) return hits;
  return withTopMesh(hits, await loadTopMeshForMembers(cwids));
}
