/**
 * Taxonomy-match callout pipeline for /search.
 *
 * Given a query string, return curated taxonomy entities whose names
 * substring-match the query (case-insensitive, punctuation-stripped).
 * v1 scope is parent topics + subtopics only; departments / divisions /
 * centers are deferred per issue #14 descope.
 *
 * Match rules:
 *   1. Normalize: lowercase + strip non-alphanumeric. Handles
 *      "Cardio-oncology" / "cardio oncology" / "cardiooncology".
 *   2. Substring match: normalized query is a substring of normalized
 *      Topic.label or Subtopic.displayName ?? label. Subtopics match
 *      on the UI-stylized displayName (short, ~3-6 words) for
 *      precision; the autocomplete suggester uses Subtopic.label for
 *      recall, but the callout is a "curated page exists" affordance
 *      where false positives hurt more than misses.
 *   3. Suppress when normalized query is shorter than 3 chars, or when
 *      nothing matches.
 *
 * Ranking (primary + secondary order):
 *   1. Entity type: parentTopic before subtopic.
 *   2. scholarCount descending. Within a tier this favors the umbrella
 *      topic when several siblings substring-match a broad query — for
 *      "cancer" the user wants "Cancer Biology (General)" first, not
 *      the highest-similarity sibling like "Lung Cancer". (Issue #74.)
 *   3. String similarity descending (query length / label length) as
 *      a tiebreaker when scholar counts are equal.
 *   4. Name ascending (locale-aware) as final tiebreaker.
 *
 * The first ranked match is the "primary" — the row that always renders.
 * Subsequent matches are "secondary," surfaced behind the disclosure
 * affordance in the callout. Cap is 4 visible secondary rows + optional
 * overflow row when secondary.length > 4.
 *
 * Counts are computed on demand for matched entities only. To bound
 * cost on common substring queries (e.g. "cancer" → many hits), the
 * candidate set is capped at MATCH_HARD_CAP before count enrichment;
 * any extras roll into the overflow count.
 */
import { prisma } from "@/lib/db";

const MIN_QUERY_LEN = 3;
const SECONDARY_CAP = 4;
/** Cap candidates considered before enrichment. Anything beyond this rolls
 *  into the overflow count without being individually counted/ranked. */
const MATCH_HARD_CAP = 1 + SECONDARY_CAP + 20;

export type TaxonomyMatch = {
  entityType: "parentTopic" | "subtopic";
  id: string;
  name: string;
  parentTopicId: string | null;
  parentTopicLabel: string | null;
  href: string;
  scholarCount: number;
  publicationCount: number;
  /** Length-normalized substring overlap, in [0, 1]. */
  similarity: number;
};

/**
 * MeSH descriptor resolution (issue #259 §1.5). Returned alongside curated
 * taxonomy matches; consumers (§1.6, §1.11) can use this without touching
 * the curated-callout shape.
 */
export type MeshResolution = {
  descriptorUi: string;
  name: string;
  /** The exact surface form (verbatim) that drove the match. */
  matchedForm: string;
  confidence: "exact" | "entry-term";
  scopeNote: string | null;
  entryTerms: string[];
  /**
   * Populated from `mesh_curated_topic_anchor` (spec §1.4); empty when the
   * descriptor has no anchor row. §1.6 / §2.4 fall back to MeSH-only when
   * empty.
   */
  curatedTopicAnchors: string[];
  /**
   * Issue #259 / SPEC §5.4.2. UIs of descriptors whose tree numbers are
   * prefix-subsumed by any of this descriptor's tree numbers. Always non-empty
   * — the resolved descriptor itself is always the first element. Bounded by
   * DESCENDANT_HARD_CAP (200). Consumed by the §5 `concept_expanded` shape in
   * a follow-up PR as the `terms { meshDescriptorUi }` array; today logged on
   * the publications-branch `search_query` line for baseline analysis only.
   */
  descendantUis: string[];
};

export type TaxonomyMatchResult =
  | { state: "none"; meshResolution: MeshResolution | null }
  | {
      state: "matches";
      primary: TaxonomyMatch;
      secondary: TaxonomyMatch[];
      /** Count of secondary matches that didn't fit inline (secondary.length > SECONDARY_CAP). */
      overflowCount: number;
      /** Original query, used for the overflow link target. */
      query: string;
      meshResolution: MeshResolution | null;
    };

/**
 * Lowercase + strip non-alphanumeric. Handles "Cardio-oncology" ↔
 * "cardio oncology" ↔ "cardiooncology" without stemming.
 */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

type EntityCandidate = {
  entityType: "parentTopic" | "subtopic";
  id: string;
  /** Visible name. Topics use label; subtopics use displayName ?? label. */
  name: string;
  /** Match haystack — Topic.label or Subtopic.label, normalized. */
  matchKey: string;
  parentTopicId: string | null;
  parentTopicLabel: string | null;
};

async function loadEntityCandidates(): Promise<EntityCandidate[]> {
  const [topics, subtopics] = await Promise.all([
    prisma.topic.findMany({ select: { id: true, label: true } }),
    prisma.subtopic.findMany({
      select: {
        id: true,
        label: true,
        displayName: true,
        parentTopicId: true,
        parentTopic: { select: { label: true } },
      },
    }),
  ]);

  const out: EntityCandidate[] = [];
  for (const t of topics) {
    const key = normalizeForMatch(t.label);
    if (!key) continue;
    out.push({
      entityType: "parentTopic",
      id: t.id,
      name: t.label,
      matchKey: key,
      parentTopicId: null,
      parentTopicLabel: null,
    });
  }
  for (const s of subtopics) {
    const display = s.displayName?.trim() || s.label;
    const matchKey = normalizeForMatch(display);
    if (!matchKey) continue;
    out.push({
      entityType: "subtopic",
      id: s.id,
      name: display,
      matchKey,
      parentTopicId: s.parentTopicId,
      parentTopicLabel: s.parentTopic?.label ?? null,
    });
  }
  return out;
}

async function getCounts(
  candidate: EntityCandidate,
): Promise<{ scholarCount: number; publicationCount: number }> {
  if (candidate.entityType === "parentTopic") {
    const [scholars, pubs] = await Promise.all([
      prisma.publicationTopic.groupBy({
        by: ["cwid"],
        where: {
          parentTopicId: candidate.id,
          scholar: { deletedAt: null, status: "active" },
        },
      }),
      prisma.publicationTopic.groupBy({
        by: ["pmid"],
        where: { parentTopicId: candidate.id },
      }),
    ]);
    return { scholarCount: scholars.length, publicationCount: pubs.length };
  }
  const [scholars, pubs] = await Promise.all([
    prisma.publicationTopic.groupBy({
      by: ["cwid"],
      where: {
        primarySubtopicId: candidate.id,
        scholar: { deletedAt: null, status: "active" },
      },
    }),
    prisma.publicationTopic.groupBy({
      by: ["pmid"],
      where: { primarySubtopicId: candidate.id },
    }),
  ]);
  return { scholarCount: scholars.length, publicationCount: pubs.length };
}

function buildHref(candidate: EntityCandidate): string {
  if (candidate.entityType === "parentTopic") {
    return `/topics/${candidate.id}`;
  }
  const params = new URLSearchParams({ subtopic: candidate.id });
  return `/topics/${candidate.parentTopicId}?${params.toString()}`;
}

function rank(matches: TaxonomyMatch[]): TaxonomyMatch[] {
  const typePriority = (t: TaxonomyMatch["entityType"]) =>
    t === "parentTopic" ? 0 : 1;
  return matches.slice().sort((a, b) => {
    const t = typePriority(a.entityType) - typePriority(b.entityType);
    if (t !== 0) return t;
    // Issue #74 — within a tier, prefer the broader topic when several
    // sibling labels substring-match a broad query. scholarCount is the
    // best available proxy for "umbrella vs. specific subtype": for
    // "cancer", "Cancer Biology (General)" carries more scholars than
    // "Lung Cancer" or "Breast Cancer" and lands first. Narrow queries
    // ("lung cancer") only substring-match a single parent so the
    // tie-break never fires.
    const c = b.scholarCount - a.scholarCount;
    if (c !== 0) return c;
    const sim = b.similarity - a.similarity;
    if (sim !== 0) return sim;
    return a.name.localeCompare(b.name);
  });
}

export async function matchQueryToTaxonomy(
  query: string,
): Promise<TaxonomyMatchResult> {
  const trimmed = query.trim();
  const normalized = normalizeForMatch(trimmed);
  if (normalized.length < MIN_QUERY_LEN) {
    return { state: "none", meshResolution: null };
  }

  const [all, meshResolution] = await Promise.all([
    loadEntityCandidates(),
    resolveMeshDescriptor(trimmed),
  ]);
  const matched = all
    .filter((c) => c.matchKey.includes(normalized))
    .map((c) => ({
      ...c,
      similarity: normalized.length / c.matchKey.length,
    }));
  if (matched.length === 0) return { state: "none", meshResolution };

  // Pre-rank by [type priority, similarity desc] before the hard cap so the
  // best candidates make it through to count enrichment regardless of how
  // many low-similarity matches the query produced.
  const typePriority = (t: EntityCandidate["entityType"]) =>
    t === "parentTopic" ? 0 : 1;
  matched.sort((a, b) => {
    const t = typePriority(a.entityType) - typePriority(b.entityType);
    if (t !== 0) return t;
    return b.similarity - a.similarity;
  });

  // Cap candidates before count enrichment. Excess rolls into overflow so
  // we don't pay for N count queries on common substring matches.
  const considered = matched.slice(0, MATCH_HARD_CAP);
  const cappedExtra = matched.length - considered.length;

  const enriched = await Promise.all(
    considered.map(async (c) => {
      const counts = await getCounts(c);
      const match: TaxonomyMatch = {
        entityType: c.entityType,
        id: c.id,
        name: c.name,
        parentTopicId: c.parentTopicId,
        parentTopicLabel: c.parentTopicLabel,
        href: buildHref(c),
        scholarCount: counts.scholarCount,
        publicationCount: counts.publicationCount,
        similarity: c.similarity,
      };
      return match;
    }),
  );

  const ranked = rank(enriched);
  const [primary, ...rest] = ranked;
  const visibleSecondary = rest.slice(0, SECONDARY_CAP);
  const overflowCount =
    Math.max(0, rest.length - SECONDARY_CAP) + cappedExtra;

  return {
    state: "matches",
    primary,
    secondary: visibleSecondary,
    overflowCount,
    query: trimmed,
    meshResolution,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MeSH descriptor resolution (§1.5)
// ─────────────────────────────────────────────────────────────────────────────

type DescriptorRow = {
  descriptorUi: string;
  name: string;
  entryTerms: string[];
  scopeNote: string | null;
  dateRevised: Date | null;
  /** §1.7 — fraction of indexed pubs tagged with this descriptor.
   *  NULL when the coverage ETL hasn't populated yet (e.g., immediately
   *  after a MeSH-descriptor full-replace). Treated as lowest priority
   *  in the resolver tiebreaker so a fully-NULL column degrades to the
   *  pre-§1.7 ordering. */
  localPubCoverage: number | null;
  /** Issue #259 / §5.4.2. JSON string array from `mesh_descriptor.tree_numbers`
   *  (e.g. ["N03.219", "N03.706"]). Used by the eager descendant precompute
   *  below; never surfaced to callers directly. Empty array if the column was
   *  empty/null in the source — surfaced as a data-anomaly aggregate warn. */
  treeNumbers: string[];
};

type MeshMap = {
  /** normalized surface form → descriptorUi[] (array because of collisions across descriptors) */
  byForm: Map<string, string[]>;
  /** descriptorUi → row */
  byUi: Map<string, DescriptorRow>;
  /**
   * descriptorUi → parentTopicId[] (any confidence). Empty array entries
   * are not stored — `.get(ui)` returns undefined when no anchor exists.
   * Loaded from `mesh_curated_topic_anchor` (spec §1.4).
   */
  anchorsByUi: Map<string, string[]>;
  /**
   * Issue #259 / §5.4.2. descriptorUi → [self, ...descendants in tn-walk order],
   * bounded by DESCENDANT_HARD_CAP. Populated eagerly at map-load time for every
   * descriptor in `byUi`; `getOrComputeDescendants` is the single read-path
   * helper. Populated lazily as a defensive fallback if a miss is ever
   * observed (test-only transient under normal operation).
   */
  descendantsByUi: Map<string, string[]>;
  /**
   * Issue #259 / §5.4.2. Parallel-array sorted index over (treeNumber,
   * descriptorUi). Built once at map-load time; consulted by
   * `computeDescendants` for both the eager precompute pass and any
   * subsequent lazy miss. `tns[i]` and `uis[i]` describe the i-th tree-number
   * occurrence in sort order; `tns` is sorted lex ascending.
   *
   * Retained on the map (rather than scoped to the load IIFE) so the lazy
   * fallback in `getOrComputeDescendants` has it available without rebuilding.
   * Memory budget: ~5 MB for the current MeSH corpus.
   */
  treePrefixIndex: { tns: string[]; uis: string[] };
  /** EtlRun.manifestSha256 captured at load time, used for invalidation. */
  manifestSha256: string | null;
  loadedAt: number;
};

/** Soft refresh interval. The real invalidation signal is the EtlRun sha256
 *  diff below — this only bounds how often the freshness probe runs. */
const MESH_MAP_REFRESH_MS = 60 * 60 * 1000; // 1h

/** Issue #259 / SPEC §5.6. Cap on the number of UIs returned in
 *  `MeshResolution.descendantUis`. Bounds the future `terms { meshDescriptorUi }`
 *  array in the `concept_expanded` shape; ranking saturates well before
 *  this size, so the cap costs little recall. Inline literal, not externalized. */
const DESCENDANT_HARD_CAP = 200;

let meshMapCache: MeshMap | null = null;
let meshMapInFlight: Promise<MeshMap> | null = null;

/** Latest successful MeSH ETL manifest sha — single indexed lookup. */
async function latestMeshManifest(): Promise<string | null> {
  const row = await prisma.etlRun.findFirst({
    where: { source: "MeSH", status: "success" },
    orderBy: { completedAt: "desc" },
    select: { manifestSha256: true },
  });
  return row?.manifestSha256 ?? null;
}

/**
 * Issue #259 / §5.4.2. Return the descendant UI array for `ui`, computing
 * it on miss and caching the result on the map.
 *
 * Steady-state (post-eager-precompute): `map.descendantsByUi.get(ui)` is a
 * hit on every call. Cost: one Map lookup.
 *
 * Cold-load / test transient (descendantsByUi not yet fully populated for
 * `ui`): compute synchronously by binary-searching the parallel-array tree
 * prefix index and walking contiguous prefix-matching entries up to
 * DESCENDANT_HARD_CAP. Worst-case ~5ms for a broad descriptor against the
 * 30k-row MeSH corpus.
 *
 * Thunder-herd note: if N concurrent reads on a fresh map all miss for the
 * same `ui`, each computes independently and the last `Map.set` wins.
 * Output is deterministic for a fixed input snapshot (same `byUi`, same
 * `treePrefixIndex`), so the duplicate-write race is benign — every writer
 * stores the same array contents.
 */
function getOrComputeDescendants(
  map: Pick<MeshMap, "byUi" | "descendantsByUi" | "treePrefixIndex">,
  ui: string,
): string[] {
  const cached = map.descendantsByUi.get(ui);
  if (cached) return cached;
  const computed = computeDescendants(ui, map);
  map.descendantsByUi.set(ui, computed);
  return computed;
}

/**
 * Issue #259 / §5.4.2. Synchronously compute `[self, ...descendants]` from
 * the prefix index. Result invariants:
 *   - First element is always `ui`.
 *   - Subsequent elements are descendant UIs in tree-number-walk order,
 *     deduped (a descendant reachable via two of `ui`'s tree numbers
 *     appears once).
 *   - Length ≤ DESCENDANT_HARD_CAP.
 *   - If `byUi.get(ui)` returns undefined (caller bug) or has empty
 *     `treeNumbers`, returns `[ui]`.
 */
function computeDescendants(
  ui: string,
  map: Pick<MeshMap, "byUi" | "treePrefixIndex">,
): string[] {
  const row = map.byUi.get(ui);
  if (!row) return [ui];
  const result: string[] = [ui];
  const seen = new Set<string>([ui]);
  const { tns, uis } = map.treePrefixIndex;
  for (const tn of row.treeNumbers) {
    if (typeof tn !== "string" || tn.length === 0) continue;
    const tnDot = `${tn}.`;
    // Lower-bound binary search: first index i where tns[i] >= tn.
    let lo = 0;
    let hi = tns.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tns[mid] < tn) lo = mid + 1;
      else hi = mid;
    }
    // Walk contiguous entries while the prefix holds:
    //   entry === tn (self, or another descriptor sharing this tn — rare)
    //   entry.startsWith(`${tn}.`) (proper descendant)
    for (let i = lo; i < tns.length; i++) {
      const cand = tns[i];
      if (cand !== tn && !cand.startsWith(tnDot)) break;
      const candUi = uis[i];
      if (seen.has(candUi)) continue;
      seen.add(candUi);
      result.push(candUi);
      if (result.length >= DESCENDANT_HARD_CAP) return result;
    }
    if (result.length >= DESCENDANT_HARD_CAP) return result;
  }
  return result;
}

async function getMeshMap(): Promise<MeshMap> {
  if (meshMapCache) {
    const age = Date.now() - meshMapCache.loadedAt;
    if (age < MESH_MAP_REFRESH_MS) return meshMapCache;
    // Past the refresh interval: see whether the ETL has shipped a new
    // manifest. Sha match → reuse and bump loadedAt. Sha differs → reload.
    try {
      const latest = await latestMeshManifest();
      if (latest === meshMapCache.manifestSha256) {
        meshMapCache.loadedAt = Date.now();
        return meshMapCache;
      }
    } catch {
      // Freshness probe failed — serve stale instead of thrashing.
      meshMapCache.loadedAt = Date.now();
      return meshMapCache;
    }
  }
  if (meshMapInFlight) return meshMapInFlight;
  meshMapInFlight = (async () => {
    const [rows, manifestSha256, anchors] = await Promise.all([
      prisma.meshDescriptor.findMany({
        select: {
          descriptorUi: true,
          name: true,
          entryTerms: true,
          scopeNote: true,
          dateRevised: true,
          localPubCoverage: true,
          // §5.4.2 — JSON array of tree numbers. Already populated by the
          // existing MeSH ETL; widening the select is the only DB-side change.
          treeNumbers: true,
        },
      }),
      latestMeshManifest().catch(() => null),
      // §1.4 — anchor rows. Loaded alongside descriptors so the resolver
      // can populate `curatedTopicAnchors` and apply the anchor-exists
      // tiebreaker without a second round-trip. Invalidation piggybacks
      // on the existing MeSH-manifest sha refresh tick; up to 1h staleness
      // for anchor edits is acceptable while §1.6 has no consumer.
      prisma.meshCuratedTopicAnchor.findMany({
        select: { descriptorUi: true, parentTopicId: true },
      }),
    ]);
    const anchorsByUi = new Map<string, string[]>();
    for (const a of anchors) {
      const arr = anchorsByUi.get(a.descriptorUi);
      if (arr) arr.push(a.parentTopicId);
      else anchorsByUi.set(a.descriptorUi, [a.parentTopicId]);
    }
    const byForm = new Map<string, string[]>();
    const byUi = new Map<string, DescriptorRow>();
    let droppedEntries = 0;
    for (const r of rows) {
      let entryTerms: string[] = [];
      if (Array.isArray(r.entryTerms)) {
        const raw = r.entryTerms as unknown[];
        entryTerms = raw.filter((x): x is string => typeof x === "string");
        droppedEntries += raw.length - entryTerms.length;
      }
      // §5.4.2 — defensive parse for tree numbers, mirroring entryTerms. JSON
      // column contract is `string[]`; non-string members would surface as a
      // data anomaly. Empty array (column absent / [] in source) is captured
      // separately by `emptyTreeNumberCount` below.
      let treeNumbers: string[] = [];
      if (Array.isArray(r.treeNumbers)) {
        const raw = r.treeNumbers as unknown[];
        treeNumbers = raw.filter((x): x is string => typeof x === "string" && x.length > 0);
      }
      byUi.set(r.descriptorUi, {
        descriptorUi: r.descriptorUi,
        name: r.name,
        entryTerms,
        scopeNote: r.scopeNote,
        dateRevised: r.dateRevised,
        localPubCoverage: r.localPubCoverage,
        treeNumbers,
      });
      const forms = [r.name, ...entryTerms];
      for (const f of forms) {
        const key = normalizeForMatch(f);
        if (!key) continue;
        const arr = byForm.get(key);
        if (arr) {
          if (!arr.includes(r.descriptorUi)) arr.push(r.descriptorUi);
        } else {
          byForm.set(key, [r.descriptorUi]);
        }
      }
    }
    if (droppedEntries > 0) {
      // ETL contract violation: entry_terms JSON contained non-string members.
      // Surface loudly so silent data loss is observable.
      console.warn(
        JSON.stringify({
          event: "mesh_map_load_warning",
          reason: "non_string_entry_terms",
          droppedEntries,
        }),
      );
    }

    // ── §5.4.2 prefix-index build ─────────────────────────────────────────
    // Flatten (tn, ui) pairs across every descriptor, sort lex ascending by tn.
    // Parallel arrays (not array-of-objects) to keep the index compact.
    const flat: Array<{ tn: string; ui: string }> = [];
    let emptyTreeNumberCount = 0;
    for (const r of byUi.values()) {
      if (r.treeNumbers.length === 0) {
        emptyTreeNumberCount += 1;
        continue;
      }
      for (const tn of r.treeNumbers) {
        flat.push({ tn, ui: r.descriptorUi });
      }
    }
    flat.sort((a, b) => {
      if (a.tn < b.tn) return -1;
      if (a.tn > b.tn) return 1;
      // Secondary tiebreak by ui for deterministic order across reloads,
      // independent of any sort-stability assumption.
      return a.ui.localeCompare(b.ui);
    });
    const tns: string[] = new Array(flat.length);
    const uis: string[] = new Array(flat.length);
    for (let i = 0; i < flat.length; i++) {
      tns[i] = flat[i].tn;
      uis[i] = flat[i].ui;
    }
    const treePrefixIndex = { tns, uis };

    // ── §5.4.2 descendant precompute pass ────────────────────────────────
    // One pass over every descriptor; populates descendantsByUi by calling
    // the unified read-path helper (which inserts on miss). Same code path
    // the lazy fallback uses.
    const descendantsByUi = new Map<string, string[]>();
    const mapInProgress: Pick<
      MeshMap,
      "byUi" | "descendantsByUi" | "treePrefixIndex"
    > = { byUi, descendantsByUi, treePrefixIndex };
    for (const ui of byUi.keys()) {
      getOrComputeDescendants(mapInProgress, ui);
    }

    if (emptyTreeNumberCount > 0) {
      // Data anomaly — every descriptor SHOULD have ≥ 1 tree number per the
      // NLM contract. One aggregate line per cache load, not per-descriptor,
      // to keep log volume bounded; mirrors the `droppedEntries` warn pattern.
      console.warn(
        JSON.stringify({
          event: "mesh_map_load_warning",
          reason: "empty_tree_numbers",
          descriptorsAffected: emptyTreeNumberCount,
        }),
      );
    }

    const map: MeshMap = {
      byForm,
      byUi,
      anchorsByUi,
      descendantsByUi,
      treePrefixIndex,
      manifestSha256,
      loadedAt: Date.now(),
    };
    meshMapCache = map;
    meshMapInFlight = null;
    return map;
  })();
  return meshMapInFlight;
}

/**
 * Resolve a free-text query to a single MeSH descriptor, or null.
 *
 * Algorithm (§1.5):
 *   1. Normalize query (lowercase, strip non-alphanumeric) — same as
 *      curated-callout matching above so "Cardio-Oncology" ↔ "cardio oncology"
 *      ↔ "cardiooncology" all collapse.
 *   2. Lookup against an in-memory map of (normalized name | normalized
 *      entry-term) → descriptorUi[].
 *   3. Per candidate: exact-name confidence iff query == normalized(name);
 *      otherwise entry-term.
 *   4. Tiebreak: exact > entry-term, then anchor-exists > no-anchor (§1.4),
 *      then higher localPubCoverage (§1.7; NULL sorts last), then
 *      dateRevised desc, then descriptorUi asc.
 *
 * Fails closed: any prisma error from the cache load is logged and `null` is
 * returned, so the curated-callout path keeps working.
 */
export async function resolveMeshDescriptor(
  query: string,
): Promise<MeshResolution | null> {
  const normalized = normalizeForMatch(query);
  if (normalized.length < MIN_QUERY_LEN) return null;
  let map: MeshMap;
  try {
    map = await getMeshMap();
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "mesh_map_load_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
  const hits = map.byForm.get(normalized);
  if (!hits || hits.length === 0) return null;

  // matchedForm note: when multiple entry terms on the same descriptor
  // normalize to the same key, array order wins. Intentional — both forms
  // point to the same descriptor; only the display string differs.
  // The `?? r.name` fallback is unreachable under the ETL contract.
  const candidates = hits
    .map((ui) => map.byUi.get(ui))
    .filter((r): r is DescriptorRow => r !== undefined)
    .map((r) => {
      const isExactName = normalizeForMatch(r.name) === normalized;
      return {
        row: r,
        confidence: isExactName ? ("exact" as const) : ("entry-term" as const),
        matchedForm: isExactName
          ? r.name
          : r.entryTerms.find((t) => normalizeForMatch(t) === normalized) ?? r.name,
      };
    });

  candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return a.confidence === "exact" ? -1 : 1;
    }
    // §1.4 — anchor exists wins over no anchor. When both sides agree on
    // the boolean (both have, or both don't), this returns 0 and we fall
    // through to the dateRevised tiebreaker.
    const aHasAnchor = (map.anchorsByUi.get(a.row.descriptorUi)?.length ?? 0) > 0;
    const bHasAnchor = (map.anchorsByUi.get(b.row.descriptorUi)?.length ?? 0) > 0;
    if (aHasAnchor !== bHasAnchor) return aHasAnchor ? -1 : 1;
    // §1.7 — higher localPubCoverage wins. Coverage is in [0, 1]; NULL is
    // mapped to -1 so any populated value beats a not-yet-computed row.
    // Fully-NULL column (post-MeSH-refresh, pre-coverage-ETL) falls through
    // to dateRevised, preserving pre-§1.7 ordering.
    const aCov = a.row.localPubCoverage ?? -1;
    const bCov = b.row.localPubCoverage ?? -1;
    if (aCov !== bCov) return bCov - aCov;
    const ad = a.row.dateRevised?.getTime() ?? 0;
    const bd = b.row.dateRevised?.getTime() ?? 0;
    if (ad !== bd) return bd - ad;
    return a.row.descriptorUi.localeCompare(b.row.descriptorUi);
  });

  const winner = candidates[0];
  return {
    descriptorUi: winner.row.descriptorUi,
    name: winner.row.name,
    matchedForm: winner.matchedForm,
    confidence: winner.confidence,
    scopeNote: winner.row.scopeNote,
    entryTerms: winner.row.entryTerms,
    curatedTopicAnchors: map.anchorsByUi.get(winner.row.descriptorUi) ?? [],
    // §5.4.2 — populated via the unified read-path helper so the steady-state
    // (post-eager-precompute) and the defensive lazy-fallback path go through
    // a single implementation. Invariant: descendantUis[0] === descriptorUi.
    descendantUis: getOrComputeDescendants(map, winner.row.descriptorUi),
  };
}

/** @internal — test-only hook. Resets the module-level MeSH cache. */
export function _resetMeshMapForTests(): void {
  meshMapCache = null;
  meshMapInFlight = null;
}

/** @internal — test-only hook for the §5.4.2 lazy-compute path. Removes
 *  either a single descriptor's descendant entry, or all entries when called
 *  without an argument. Not used in production code paths. */
export function _clearDescendantsForTests(ui?: string): void {
  if (!meshMapCache) return;
  if (ui) meshMapCache.descendantsByUi.delete(ui);
  else meshMapCache.descendantsByUi.clear();
}
