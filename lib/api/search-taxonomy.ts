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
   * Issue #259 / SPEC §5.4.2 — UIs of descriptors whose tree numbers
   * descend from this descriptor's tree numbers (NLM tree-walk:
   * `child_tn LIKE parent_tn || '.%'`, per SPEC §A2). Bounded by
   * `DESCENDANT_HARD_CAP` = 200. `descriptorUi` itself is included at
   * index 0 so callers can treat the array as the canonical
   * "concept-and-its-narrower-terms" set without a self-prepend.
   *
   * Dead code in the default config until a later PR in the MeSH
   * defaults rebalance series (issue #287) wires it into the
   * `concept_expanded` ES body's `terms` clause.
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
  /**
   * Issue #259 / SPEC §5.4.2 — NLM MeSH tree numbers (e.g.
   * "E05.318.308.250"). Parsed defensively from the JSON column;
   * non-string members and null are dropped, mirroring `entryTerms`.
   * Empty array for descriptors with no tree numbers (data anomaly
   * per SPEC §8.3 case #7).
   */
  treeNumbers: string[];
  scopeNote: string | null;
  dateRevised: Date | null;
  /** §1.7 — fraction of indexed pubs tagged with this descriptor.
   *  NULL when the coverage ETL hasn't populated yet (e.g., immediately
   *  after a MeSH-descriptor full-replace). Treated as lowest priority
   *  in the resolver tiebreaker so a fully-NULL column degrades to the
   *  pre-§1.7 ordering. */
  localPubCoverage: number | null;
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
   * Issue #259 / SPEC §5.4.2 — descriptorUi → descendant-UI array
   * (self at index 0), bounded by `DESCENDANT_HARD_CAP`. Populated
   * eagerly at cache load for every descriptor in `byUi`. The resolver
   * treats a miss as a load-bearing invariant violation (see
   * `resolveMeshDescriptor`) — not a lazy-compute trigger. PR 2 ships
   * eager-only; a future split-load PR would re-add lazy fallback
   * with its own coverage.
   */
  descendantsByUi: Map<string, string[]>;
  /** EtlRun.manifestSha256 captured at load time, used for invalidation. */
  manifestSha256: string | null;
  loadedAt: number;
};

/** Soft refresh interval. The real invalidation signal is the EtlRun sha256
 *  diff below — this only bounds how often the freshness probe runs. */
const MESH_MAP_REFRESH_MS = 60 * 60 * 1000; // 1h

/**
 * Issue #259 / SPEC §5.4.2 / §5.6 — upper bound on the size of any one
 * descriptor's `descendantUis` array. Beyond this size, broad descriptors
 * (Neoplasms, Aging) would otherwise produce thousands of UIs in the
 * `concept_expanded` `terms` clause; the boost path saturates well before
 * then. Inline literal, not externalized — re-tunable only by SPEC change.
 */
const DESCENDANT_HARD_CAP = 200;

/** Sorted (treeNumber → descriptorUi) entry used by the prefix index. */
type TreeNumberEntry = { treeNumber: string; descriptorUi: string };

/**
 * Build a sorted list of (treeNumber, descriptorUi) pairs across every
 * descriptor row. Sort key is `treeNumber.localeCompare` so binary search
 * locates the start of any prefix range in O(log n).
 *
 * NLM convention is that a tree number identifies exactly one descriptor;
 * we don't assume that, but if the source data ever violates the rule the
 * stable-sort guarantee (V8 / ES2019) means ties fall in `byUi` insertion
 * order — deterministic across cache reloads with the same input.
 *
 * Exported for unit tests.
 */
export function buildPrefixIndex(
  rows: Iterable<DescriptorRow>,
): TreeNumberEntry[] {
  const entries: TreeNumberEntry[] = [];
  for (const r of rows) {
    for (const tn of r.treeNumbers) {
      entries.push({ treeNumber: tn, descriptorUi: r.descriptorUi });
    }
  }
  entries.sort((a, b) => a.treeNumber.localeCompare(b.treeNumber));
  return entries;
}

/**
 * Return descriptor UIs whose tree numbers strictly descend from
 * `parentTn` — i.e., start with `parentTn + "."`. Self is NOT included;
 * the caller (`computeDescendantUis`) prepends it.
 *
 * The dot-boundary on `needle` matters: a bare `startsWith(parentTn)`
 * would treat "C14" as a parent of "C140.x", which is wrong. NLM tree
 * numbers are dot-segmented; a child of "C14" has tn = "C14.<rest>".
 *
 * Exported for unit tests.
 */
export function prefixLookup(
  index: readonly TreeNumberEntry[],
  parentTn: string,
): string[] {
  if (parentTn.length === 0) return [];
  const needle = parentTn + ".";
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (index[mid].treeNumber < needle) lo = mid + 1;
    else hi = mid;
  }
  const out: string[] = [];
  for (let i = lo; i < index.length; i++) {
    if (!index[i].treeNumber.startsWith(needle)) break;
    out.push(index[i].descriptorUi);
  }
  return out;
}

/**
 * Compute the descendant-UI set for one descriptor row against the
 * shared prefix index. The returned array is `[self, ...descendants]`
 * — self is constructed at index 0 explicitly by the final `return`,
 * not relying on Set-iteration order. Descendants follow in
 * sorted-tree-number order from the prefix index. The 200-element cap
 * counts self toward the limit (broadest descriptors return self plus
 * 199 descendants).
 *
 * Exported for unit tests.
 */
export function computeDescendantUis(
  row: DescriptorRow,
  prefixIndex: readonly TreeNumberEntry[],
): string[] {
  const descendants: string[] = [];
  const seen = new Set<string>([row.descriptorUi]);
  for (const tn of row.treeNumbers) {
    for (const ui of prefixLookup(prefixIndex, tn)) {
      if (seen.size >= DESCENDANT_HARD_CAP) {
        return [row.descriptorUi, ...descendants];
      }
      if (seen.has(ui)) continue;
      seen.add(ui);
      descendants.push(ui);
    }
  }
  return [row.descriptorUi, ...descendants];
}

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
          treeNumbers: true,
          scopeNote: true,
          dateRevised: true,
          localPubCoverage: true,
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
    let droppedTreeNumbers = 0;
    let descriptorsWithEmptyTreeNumbers = 0;
    for (const r of rows) {
      let entryTerms: string[] = [];
      if (Array.isArray(r.entryTerms)) {
        const raw = r.entryTerms as unknown[];
        entryTerms = raw.filter((x): x is string => typeof x === "string");
        droppedEntries += raw.length - entryTerms.length;
      }
      // Issue #259 §5.4.2 — defensive treeNumbers parse, mirroring entryTerms.
      let treeNumbers: string[] = [];
      if (Array.isArray(r.treeNumbers)) {
        const raw = r.treeNumbers as unknown[];
        treeNumbers = raw.filter((x): x is string => typeof x === "string");
        droppedTreeNumbers += raw.length - treeNumbers.length;
      }
      if (treeNumbers.length === 0) descriptorsWithEmptyTreeNumbers++;
      byUi.set(r.descriptorUi, {
        descriptorUi: r.descriptorUi,
        name: r.name,
        entryTerms,
        treeNumbers,
        scopeNote: r.scopeNote,
        dateRevised: r.dateRevised,
        localPubCoverage: r.localPubCoverage,
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
    if (droppedTreeNumbers > 0) {
      console.warn(
        JSON.stringify({
          event: "mesh_map_load_warning",
          reason: "non_string_tree_numbers",
          droppedTreeNumbers,
        }),
      );
    }
    // SPEC §8.3 case #7 — empty `treeNumbers` is a data anomaly in
    // production but the dominant shape in unit-test fixtures (which omit
    // the field). Gate the warn on a production-sized row count so
    // fixture-based tests don't emit spurious `console.warn` lines that
    // future devs have to investigate. 100 is well below the ~30k
    // production load and well above any plausible fixture size.
    if (descriptorsWithEmptyTreeNumbers > 0 && rows.length > 100) {
      console.warn(
        JSON.stringify({
          event: "mesh_map_load_warning",
          reason: "empty_tree_numbers",
          descriptorsWithEmptyTreeNumbers,
        }),
      );
    }
    // Issue #259 §5.4.2 — eager descendant precompute. Sorted prefix index
    // is the single source of truth; per-descriptor compute is a single
    // binary-search + bounded scan per tree number, capped at 200. Total
    // load-time work: ~30k descriptors × ~10 tree numbers each, dominated
    // by the sort. The prefix index is a closure-local; nothing reads it
    // after the precompute completes (MeshMap carries the precomputed map
    // only).
    const prefixIndex = buildPrefixIndex(byUi.values());
    const descendantsByUi = new Map<string, string[]>();
    for (const r of byUi.values()) {
      descendantsByUi.set(r.descriptorUi, computeDescendantUis(r, prefixIndex));
    }
    const map: MeshMap = {
      byForm,
      byUi,
      anchorsByUi,
      descendantsByUi,
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
  // Issue #259 §5.4.2 — descendantsByUi is populated eagerly at cache
  // load for every entry in byUi. winner.row comes from byUi, so a miss
  // here is a load-bearing invariant violation — throw loudly rather than
  // silently recomputing from a stale or missing prefix index. If a
  // future PR splits cache-load into descriptor-load-then-precompute,
  // that PR replaces this throw with the lazy-compute fallback sketched
  // in SPEC §5.4.2 and adds a test that exercises it.
  const descendantUis = map.descendantsByUi.get(winner.row.descriptorUi);
  if (!descendantUis) {
    throw new Error(
      `invariant violation: descendantsByUi missing entry for ${winner.row.descriptorUi} ` +
        `(eager precompute should populate every byUi descriptor; see SPEC §5.4.2)`,
    );
  }
  return {
    descriptorUi: winner.row.descriptorUi,
    name: winner.row.name,
    matchedForm: winner.matchedForm,
    confidence: winner.confidence,
    scopeNote: winner.row.scopeNote,
    entryTerms: winner.row.entryTerms,
    curatedTopicAnchors: map.anchorsByUi.get(winner.row.descriptorUi) ?? [],
    descendantUis,
  };
}

/** @internal — test-only hook. Resets the module-level MeSH cache. */
export function _resetMeshMapForTests(): void {
  meshMapCache = null;
  meshMapInFlight = null;
}

/**
 * @internal — test-only hook. Deletes one descriptor's `descendantsByUi`
 * entry on the currently-loaded map so the resolver's eager-precompute
 * invariant throw in `resolveMeshDescriptor` can be exercised. Use only
 * from the §5.4.2 invariant-assertion test; no production caller.
 */
export function _deleteDescendantsForTests(descriptorUi: string): void {
  meshMapCache?.descendantsByUi.delete(descriptorUi);
}
