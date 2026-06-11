/**
 * Cross-scholar Method page data assembly (standalone Method pages plan §3/§5).
 *
 * The Method taxonomy is two-level — Supercategory → Family → publication —
 * analogous to Topic → Subtopic → publication. UNLIKE Topics, there is NO
 * per-(pmid × family) join table carrying an `author_position`: the only
 * family-grain table is `ScholarFamily`, a per-`(cwid, family)` rollup keyed by
 * `@@unique([cwid, familyId])`, carrying `pmidCount`, `exemplarTools`, and the
 * `pmids[]` (#819, the distinct member PMIDs). So:
 *   - cross-scholar SCHOLAR rosters + family rails come from `scholar_family`
 *     groupBys (one row per `(cwid, family)` ⇒ the row set IS the distinct-scholar
 *     list), ranked by the per-scholar `pmidCount`;
 *   - representative PUBLICATIONS come from unioning `ScholarFamily.pmids` across
 *     the (overlay-gated) scholars in a family, then resolving `Publication` and
 *     reusing the topic feed's suppression / dark-pmid / author-chip helpers
 *     VERBATIM (imported from `lib/api/topics.ts`, never re-cloned).
 *
 * EVERY loader applies, in order:
 *   1. the master lens gate `isMethodsLensEnabled()` — off ⇒ the loader returns
 *      its empty value (`null` / `[]` / `0`), so no page, search hit, or rollup
 *      can leak even after the `scholar_family` rollup is populated; AND
 *   2. the §3.4 shared #800 suppression / #801 sensitivity overlay gate
 *      (`lib/api/methods-overlay.ts`) — suppressed/sensitive `(sc,label)` families
 *      are removed BEFORE counting, so neither a roster, a count, nor a candidate
 *      ever exposes a suppressed/sensitive family publicly; AND
 *   3. active-scholar / role eligibility — reused from `lib/eligibility.ts`
 *      (`TOP_SCHOLARS_ELIGIBLE_ROLES` for the PI chip row; an active-only join for
 *      enumerative surfaces) exactly as the Topic loaders do.
 *
 * `METHODS_LENS_PAGES` (the page/surface gate, `isMethodPagesEnabled()`) is
 * enforced at the ROUTE boundary, not here — these loaders are the data substrate
 * and only depend on the master lens.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { TOP_SCHOLARS_ELIGIBLE_ROLES, isPubliclyDisplayed } from "@/lib/eligibility";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";
import {
  isMethodsLensEnabled,
  isMethodsFamilyRosterFallbackOn,
  isMethodsLensMeshDefinitionsEnabled,
} from "@/lib/profile/methods-lens-flags";
import {
  loadFamilyOverlayGate,
  isFamilyPubliclyVisible,
  type FamilyOverlayGate,
} from "@/lib/api/methods-overlay";
import {
  loadPublicationSuppressions,
  resolveDarkPmids,
  loadHiddenAuthorshipCounts,
} from "@/lib/api/manual-layer";
import {
  fetchWcmAuthorsForPmids,
  type TopScholarChipData,
  type SubtopicScholarRowData,
  type WcmAuthorChip,
} from "@/lib/api/topics";
import {
  supercategoryLabel,
  supercategoryDescription,
  isKnownSupercategory,
} from "@/lib/methods/supercategory-labels";
import {
  supercategorySlug,
  extractFamilyIdFromSlug,
  familySlug,
  methodFamilyPath,
} from "@/lib/method-url";
import { deriveSlug } from "@/lib/slug";

// Re-export the chip/row data shapes so Method page components import them from
// here (one module surface) rather than reaching into `topics.ts`.
export type { TopScholarChipData, SubtopicScholarRowData, WcmAuthorChip };

// Sparse-state floors / targets — mirror the Topic chip row (7 chips, hide < 3).
const TOP_SCHOLARS_TARGET = 7;
const TOP_SCHOLARS_FLOOR = 3;
// Family scholar row (the SubtopicScholarRow analog): up to 10 inline, floor 1.
const FAMILY_SCHOLARS_TARGET = 10;
const FAMILY_SCHOLARS_FLOOR = 1;

const HARD_EXCLUDE_TYPES = [...FEED_EXCLUDED_TYPES];

// ---------------------------------------------------------------------------
// Resolved-page descriptors
// ---------------------------------------------------------------------------

/** A resolved supercategory page identity (label + description from the static
 *  map, with the humanize fallback). `id` is the snake_case A2 supercategory id;
 *  `slug` is the derived URL segment. */
export type ResolvedSupercategory = {
  id: string;
  slug: string;
  label: string;
  description: string;
};

/** A resolved family page identity. The STABLE identity is `(supercategory,
 *  familyLabel)`; `familyId` is the latest within-manifest id (for the URL suffix
 *  + label-collision disambiguation only). */
export type ResolvedFamily = {
  supercategory: string;
  supercategorySlug: string;
  familyId: string;
  familyLabel: string;
  /** URL segment (`${slug(label)}-${familyId}`) — the canonical family slug. */
  familySlug: string;
};

// ---------------------------------------------------------------------------
// Resolvers (§3.1 / §3.2 / §2 slug resolution)
// ---------------------------------------------------------------------------

/**
 * Resolve a supercategory URL segment back to its A2 id by re-deriving the slug
 * for every supercategory present in `scholar_family` (the closed ~14-set) and
 * matching. Returns null when the lens is off, the segment matches no live
 * supercategory, or its post-gate family roster is empty (an all-suppressed /
 * all-sensitive supercategory gets NO page — §3.4). Cheap: one `distinct`
 * groupBy over the supercategory column.
 */
export async function getSupercategory(slug: string): Promise<ResolvedSupercategory | null> {
  if (!isMethodsLensEnabled()) return null;

  const groups = await prisma.scholarFamily.groupBy({ by: ["supercategory"] });
  const match = groups.find((g) => supercategorySlug(g.supercategory) === slug);
  if (!match) return null;

  // Reject a supercategory with no publicly-visible families (post-gate roster
  // empty) — no page for an all-suppressed/all-sensitive supercategory.
  const gate = await loadFamilyOverlayGate();
  const families = await getFamiliesForSupercategory(match.supercategory, gate);
  if (families.length === 0) return null;

  return {
    id: match.supercategory,
    slug: supercategorySlug(match.supercategory),
    label: supercategoryLabel(match.supercategory),
    description: supercategoryDescription(match.supercategory),
  };
}

/**
 * Resolve a `[supercategory]/[family]` URL pair to a family identity. Resolution
 * is by the STABLE `(supercategory, familyLabel)` key — re-derive each live
 * family's slug under the supercategory and match the URL segment; the trailing
 * `fam_NNNN` only disambiguates a label-slug collision (§2). A family that is
 * #800-suppressed or (gate-on) #801-sensitive resolves to null — `notFound()`,
 * never a public page. A bare-`familyId` segment from a stale manifest that no
 * longer resolves → null.
 */
export async function getFamily(
  supercategorySlugSeg: string,
  familySegment: string,
): Promise<ResolvedFamily | null> {
  if (!isMethodsLensEnabled()) return null;

  // Resolve the supercategory id from its slug (re-derive over the live set).
  const scGroups = await prisma.scholarFamily.groupBy({ by: ["supercategory"] });
  const sc = scGroups.find((g) => supercategorySlug(g.supercategory) === supercategorySlugSeg);
  if (!sc) return null;
  const supercategory = sc.supercategory;

  // Distinct families under this supercategory (one row per family label; pick
  // the latest familyId for the URL suffix). `_max` makes the chosen id stable
  // within a load even if a label maps to multiple historical ids.
  const famGroups = await prisma.scholarFamily.groupBy({
    by: ["familyLabel"],
    where: { supercategory },
    _max: { familyId: true },
  });

  // Resolve by the STABLE (supercategory, familyLabel) identity, NOT the full
  // segment: `familyId` re-mints on every A2 rebuild, so a permalink minted with
  // an OLD id must still resolve. Match on the re-derived LABEL-slug prefix
  // (`deriveSlug(label)`); the trailing `fam_NNNN` in the URL is used ONLY to
  // break a tie when two labels in the supercategory share a label-slug prefix.
  // A bare-`familyId` segment from a stale manifest whose label no longer derives
  // to the same prefix → no candidate → notFound() (§E6).
  const urlFamilyId = extractFamilyIdFromSlug(familySegment);
  // The label-slug prefix carried by the URL = the segment with a trailing
  // `-fam_NNNN` (or bare `fam_NNNN`) stripped.
  const urlLabelPrefix = urlFamilyId
    ? familySegment.replace(new RegExp(`-?${urlFamilyId}$`), "")
    : familySegment;
  const candidates = famGroups.filter((g) => {
    const labelSlug = deriveSlug(g.familyLabel); // the label-slug prefix
    return labelSlug !== "" && labelSlug === urlLabelPrefix;
  });
  let chosen: { familyLabel: string; familyId: string } | null = null;
  if (candidates.length === 1) {
    chosen = {
      familyLabel: candidates[0].familyLabel,
      familyId: candidates[0]._max.familyId ?? "",
    };
  } else if (candidates.length > 1 && urlFamilyId) {
    // Same label-slug prefix on >1 family — disambiguate by the URL's id.
    const byId = candidates.find((g) => g._max.familyId === urlFamilyId);
    if (byId) chosen = { familyLabel: byId.familyLabel, familyId: byId._max.familyId ?? "" };
  }
  // A bare `fam_NNNN` segment carries NO label-slug prefix, so the prefix match
  // above yields no candidate. The `FamilyScholarsRow` client (and any bare-id
  // permalink) sends exactly this shape — `familyId={activeFamilyId}` — so resolve
  // it directly by the latest `familyId` across the supercategory's families. This
  // is the "bare family id resolves through the id tie-break path" the scholars
  // route documents; without it that row's endpoint never resolves and the row is
  // always empty. A stale id that is no longer any family's latest still → null.
  if (!chosen && urlFamilyId) {
    const byId = famGroups.find((g) => g._max.familyId === urlFamilyId);
    if (byId) chosen = { familyLabel: byId.familyLabel, familyId: byId._max.familyId ?? "" };
  }
  if (!chosen) return null;

  // §3.4 overlay gate — suppressed/sensitive families have no public page.
  const gate = await loadFamilyOverlayGate();
  if (!isFamilyPubliclyVisible(supercategory, chosen.familyLabel, gate)) return null;

  return {
    supercategory,
    supercategorySlug: supercategorySlug(supercategory),
    familyId: chosen.familyId,
    familyLabel: chosen.familyLabel,
    familySlug: familySlug(chosen.familyLabel, chosen.familyId),
  };
}

/** #879 — the NLM MeSH definition surfaced on a family page: the descriptor's
 *  canonical name + non-null scope note + UI (for the meshb attribution link). */
export type FamilyMeshDefinition = {
  descriptorUi: string;
  name: string;
  scopeNote: string;
};

/**
 * #879 — resolve a family's curated MeSH definition, or null. Returns a
 * definition ONLY when (a) `METHODS_LENS_MESH_DEFINITIONS` is on, (b) a
 * `confidence='curated'` `mesh_curated_family_anchor` row exists for the stable
 * `(supercategory, familyLabel)` identity, (c) that descriptor still exists in
 * `mesh_descriptor`, and (d) its scope note is non-null. `derived` seed rows are
 * NEVER surfaced (only a human-promoted `curated` row), and a stale descriptor
 * UI (post-MeSH-full-replace, the no-FK design) or a null scope note degrade to
 * null — no definition shown, never a throw.
 *
 * Two indexed point-reads (anchor PK prefix + descriptor PK); the flag gate runs
 * first so the feature is zero-DB-cost when off. Deterministic pick (lowest
 * descriptorUi) when a family curated-anchors to more than one descriptor.
 */
export async function getFamilyMeshDefinition(
  supercategory: string,
  familyLabel: string,
): Promise<FamilyMeshDefinition | null> {
  if (!isMethodsLensMeshDefinitionsEnabled()) return null;

  const anchor = await prisma.meshCuratedFamilyAnchor.findFirst({
    where: { supercategory, familyLabel, confidence: "curated" },
    orderBy: { descriptorUi: "asc" },
    select: { descriptorUi: true },
  });
  if (!anchor) return null;

  const descriptor = await prisma.meshDescriptor.findUnique({
    where: { descriptorUi: anchor.descriptorUi },
    select: { descriptorUi: true, name: true, scopeNote: true },
  });
  if (!descriptor || !descriptor.scopeNote) return null;

  return {
    descriptorUi: descriptor.descriptorUi,
    name: descriptor.name,
    scopeNote: descriptor.scopeNote,
  };
}

// ---------------------------------------------------------------------------
// Family rosters + rollups (§3.1 / §3.2)
// ---------------------------------------------------------------------------

/** One family row in a supercategory's rail (§3.2). `scholarCount` is the
 *  distinct-scholar count (additive, accurate); `pmidCountSum` is the per-scholar
 *  `pmidCount` SUM — NON-additive across co-authors, so it is labeled, never shown
 *  as a true distinct pub count. `pubCount` is the DISTINCT (#356-dark filtered)
 *  publication count — the value the rail displays — and is `null` unless the
 *  caller opted into the (more expensive) pmid-union pass (`getSupercategoryRollup`). */
export type FamilyRosterEntry = {
  familyId: string;
  familyLabel: string;
  familySlug: string;
  supercategory: string;
  scholarCount: number;
  pmidCountSum: number;
  /** Distinct, dark-filtered publication count; null when not computed. */
  pubCount: number | null;
  /** Up to ~3 representative member-tool display names. With `getSupercategory-
   *  Rollup` this is the deduped UNION across the family's scholars (cap 3); the
   *  bare `getFamiliesForSupercategory` keeps the single representative row's set. */
  exemplarTools: string[];
};

/**
 * Families within a supercategory, post-overlay-gate, ordered by distinct-scholar
 * count desc (the additive, accurate signal). Suppressed/sensitive families are
 * dropped BEFORE counting. Pass a preloaded `gate` to avoid re-querying the
 * overlays (the resolvers do this); omit it to load one. `pubCount` is left null
 * here (cheap path — the hub + page-rail enrichment compute it via the rollup).
 * Pass `opts.skipExemplars` when the caller will supply its own exemplar union
 * (avoids a redundant single-row read).
 */
export async function getFamiliesForSupercategory(
  supercategory: string,
  gate?: FamilyOverlayGate,
  opts?: { skipExemplars?: boolean },
): Promise<FamilyRosterEntry[]> {
  if (!isMethodsLensEnabled()) return [];
  const overlayGate = gate ?? (await loadFamilyOverlayGate());

  const groups = await prisma.scholarFamily.groupBy({
    by: ["familyLabel"],
    where: { supercategory },
    _sum: { pmidCount: true },
    _count: { cwid: true },
    _max: { familyId: true },
  });

  // Resolve the latest exemplarTools per family label (one extra read, bounded by
  // the family count). Use the row carrying the chosen familyId.
  const visible = groups.filter((g) =>
    isFamilyPubliclyVisible(supercategory, g.familyLabel, overlayGate),
  );
  if (visible.length === 0) return [];

  const exemplarById = new Map<string, string[]>();
  if (!opts?.skipExemplars) {
    const chosenIds = visible
      .map((g) => g._max.familyId)
      .filter((id): id is string => id !== null);
    const exemplarRows = await prisma.scholarFamily.findMany({
      where: { supercategory, familyId: { in: chosenIds } },
      select: { familyId: true, exemplarTools: true },
      distinct: ["familyId"],
    });
    for (const r of exemplarRows) {
      exemplarById.set(
        r.familyId,
        Array.isArray(r.exemplarTools) ? (r.exemplarTools as string[]) : [],
      );
    }
  }

  return visible
    .map((g) => {
      const familyId = g._max.familyId ?? "";
      return {
        familyId,
        familyLabel: g.familyLabel,
        familySlug: familySlug(g.familyLabel, familyId),
        supercategory,
        scholarCount: g._count.cwid,
        pmidCountSum: g._sum.pmidCount ?? 0,
        pubCount: null,
        exemplarTools: exemplarById.get(familyId) ?? [],
      };
    })
    .sort(
      (a, b) =>
        b.scholarCount - a.scholarCount ||
        b.pmidCountSum - a.pmidCountSum ||
        a.familyLabel.localeCompare(b.familyLabel),
    );
}

/** Cap on the deduped exemplar-tool union shown per family row. */
const EXEMPLAR_UNION_CAP = 3;

/**
 * Distinct member pmids PER FAMILY across an entire supercategory's publicly-
 * visible, active-scholar rows, plus the supercategory-wide union — both #356-dark
 * filtered, in ONE findMany + ONE batched suppression pass (vs. N×
 * `collectFamilyPmids`). The per-family sets back the rail's distinct paper count;
 * the union backs the "All work" representative feed. Suppressed/sensitive families
 * never contribute (gated per row before their pmids enter any accumulator).
 */
async function collectSupercategoryFamilyPmids(
  supercategory: string,
  gate: FamilyOverlayGate,
): Promise<{ pmidsByFamilyLabel: Map<string, string[]>; unionPmids: string[] }> {
  const rows = await prisma.scholarFamily.findMany({
    where: { supercategory, scholar: { deletedAt: null, status: "active" } },
    select: { familyLabel: true, pmids: true },
  });

  const rawByLabel = new Map<string, Set<string>>();
  const unionSet = new Set<string>();
  for (const r of rows) {
    if (!isFamilyPubliclyVisible(supercategory, r.familyLabel, gate)) continue;
    if (!Array.isArray(r.pmids)) continue;
    let set = rawByLabel.get(r.familyLabel);
    if (!set) {
      set = new Set<string>();
      rawByLabel.set(r.familyLabel, set);
    }
    for (const p of r.pmids as unknown[]) {
      const s = String(p);
      set.add(s);
      unionSet.add(s);
    }
  }

  const allPmids = [...unionSet];
  const pmidsByFamilyLabel = new Map<string, string[]>();
  if (allPmids.length === 0) return { pmidsByFamilyLabel, unionPmids: [] };

  // #356 — one batched whole-pub takedown / derived-dark pass across the union.
  const suppressions = await loadPublicationSuppressions(allPmids, prisma);
  const dark = await resolveDarkPmids(allPmids, suppressions, prisma);

  const unionPmids: string[] = [];
  for (const p of allPmids) if (!dark.has(p)) unionPmids.push(p);
  for (const [label, set] of rawByLabel) {
    pmidsByFamilyLabel.set(
      label,
      [...set].filter((p) => !dark.has(p)),
    );
  }
  return { pmidsByFamilyLabel, unionPmids };
}

/**
 * Deduped UNION of `exemplarTools` across each family's scholar rows (cap 3),
 * preferring the most prolific scholars' tools (rows ordered by `pmidCount` desc).
 * Replaces the single-row exemplar so the rail's tool line is FAMILY-representative
 * rather than one arbitrary scholar's lone tool (UX feedback A3). One findMany,
 * bounded by the supercategory's row count.
 */
async function loadUnionExemplars(
  supercategory: string,
  familyLabels: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (familyLabels.length === 0) return out;

  const rows = await prisma.scholarFamily.findMany({
    where: {
      supercategory,
      familyLabel: { in: familyLabels },
      scholar: { deletedAt: null, status: "active" },
    },
    orderBy: [{ pmidCount: "desc" }],
    select: { familyLabel: true, exemplarTools: true },
  });

  const seenByLabel = new Map<string, Set<string>>();
  for (const r of rows) {
    let names = out.get(r.familyLabel);
    let seen = seenByLabel.get(r.familyLabel);
    if (!names) {
      names = [];
      out.set(r.familyLabel, names);
      seen = new Set<string>();
      seenByLabel.set(r.familyLabel, seen);
    }
    if (names.length >= EXEMPLAR_UNION_CAP) continue;
    if (!Array.isArray(r.exemplarTools)) continue;
    for (const t of r.exemplarTools as unknown[]) {
      if (names.length >= EXEMPLAR_UNION_CAP) break;
      const name = typeof t === "string" ? t.trim() : "";
      if (!name || seen!.has(name)) continue;
      seen!.add(name);
      names.push(name);
    }
  }
  return out;
}

/** The supercategory-page rollup: the family rail (with DISTINCT paper counts +
 *  union exemplars) plus the default "All work" representative publication list —
 *  all derived from a SINGLE supercategory-wide pmid collection. */
export type SupercategoryRollup = {
  families: FamilyRosterEntry[];
  /** Representative recent publications across ALL visible families (§A2). */
  allWorkPubs: MethodPublicationHit[];
};

/**
 * Assemble the supercategory page's family rail and default "All work" feed in one
 * pass. Reuses `getFamiliesForSupercategory` for the base roster (sorted, gated),
 * then enriches each family with its DISTINCT paper count (`pubCount`) and the
 * deduped exemplar UNION (cap 3), and resolves the representative recent
 * publications across the supercategory-wide pmid union. Lens-off / empty ⇒ both
 * empty. `allWorkLimit` caps the representative list (default 12).
 */
export async function getSupercategoryRollup(
  supercategory: string,
  opts?: { allWorkLimit?: number },
): Promise<SupercategoryRollup> {
  if (!isMethodsLensEnabled()) return { families: [], allWorkPubs: [] };
  const gate = await loadFamilyOverlayGate();

  // Base roster (skip the single-row exemplar read; we supply the union below).
  const base = await getFamiliesForSupercategory(supercategory, gate, {
    skipExemplars: true,
  });
  if (base.length === 0) return { families: [], allWorkPubs: [] };

  const { pmidsByFamilyLabel, unionPmids } = await collectSupercategoryFamilyPmids(
    supercategory,
    gate,
  );
  const exemplarsByLabel = await loadUnionExemplars(
    supercategory,
    base.map((f) => f.familyLabel),
  );

  const families: FamilyRosterEntry[] = base.map((f) => ({
    ...f,
    pubCount: pmidsByFamilyLabel.get(f.familyLabel)?.length ?? 0,
    exemplarTools: exemplarsByLabel.get(f.familyLabel) ?? [],
  }));

  let allWorkPubs: MethodPublicationHit[] = [];
  if (unionPmids.length > 0) {
    const pubs = await prisma.publication.findMany({
      where: { pmid: { in: unionPmids }, publicationType: { notIn: HARD_EXCLUDE_TYPES } },
      select: PUB_SELECT,
      orderBy: [{ year: "desc" }, { dateAddedToEntrez: "desc" }],
      take: opts?.allWorkLimit ?? 12,
    });
    const authorsByPmid = await fetchWcmAuthorsForPmids(pubs.map((p) => p.pmid));
    allWorkPubs = pubs.map((p) => mapPublicationHit(p, authorsByPmid.get(p.pmid)));
  }

  return { families, allWorkPubs };
}

/**
 * Distinct ACTIVE-scholar count for a family (`(supercategory, familyLabel)`).
 * All-roles (no eligibility carve) — powers the "View all N scholars" affordance.
 * Returns 0 when the lens is off. `@@unique([cwid, familyId])` makes one row per
 * `(cwid, family)`, so the distinct-cwid groupBy length IS the scholar count.
 */
export async function getDistinctScholarCountForFamily(
  supercategory: string,
  familyLabel: string,
): Promise<number> {
  if (!isMethodsLensEnabled()) return 0;
  const rows = await prisma.scholarFamily.groupBy({
    by: ["cwid"],
    where: {
      supercategory,
      familyLabel,
      scholar: { deletedAt: null, status: "active" },
    },
  });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Top-scholar chip rows (§3.1 / §5) — ranked by per-scholar pmidCount within
// the FT-faculty PI carve. There is NO author_position grain at family level, so
// the chip-row ranking key is the per-scholar family pub count (pmidCount).
// ---------------------------------------------------------------------------

/**
 * Top scholars (PI chip row) for a single family, ranked by the per-scholar
 * `pmidCount` within `TOP_SCHOLARS_ELIGIBLE_ROLES` (FT faculty). Active-only.
 * Sparse-state hide (`null`) when fewer than the floor qualify. Lens-off ⇒ null.
 */
export async function getFamilyScholars(
  supercategory: string,
  familyLabel: string,
): Promise<TopScholarChipData[] | null> {
  if (!isMethodsLensEnabled()) return null;

  const gate = await loadFamilyOverlayGate();
  if (!isFamilyPubliclyVisible(supercategory, familyLabel, gate)) return null;

  const rows = await prisma.scholarFamily.findMany({
    where: {
      supercategory,
      familyLabel,
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] },
      },
    },
    orderBy: [{ pmidCount: "desc" }, { familyId: "asc" }],
    select: {
      pmidCount: true,
      scholar: {
        select: { cwid: true, slug: true, preferredName: true, primaryTitle: true },
      },
    },
  });
  if (rows.length < TOP_SCHOLARS_FLOOR) return null;

  return rows.slice(0, TOP_SCHOLARS_TARGET).map((r, i) => ({
    cwid: r.scholar!.cwid,
    slug: r.scholar!.slug,
    preferredName: r.scholar!.preferredName,
    primaryTitle: r.scholar!.primaryTitle,
    identityImageEndpoint: identityImageEndpoint(r.scholar!.cwid),
    rank: i + 1,
  }));
}

/**
 * Rolled-up top scholars across a supercategory (§5.B) — aggregate each scholar's
 * `pmidCount` over the supercategory's PUBLICLY-VISIBLE families (suppressed /
 * sensitive families never contribute), within the FT-faculty PI carve, then rank
 * desc. Active-only. Sparse-state hide (`null`) below the floor. Lens-off ⇒ null.
 */
export async function getTopScholarsForSupercategory(
  supercategory: string,
): Promise<TopScholarChipData[] | null> {
  if (!isMethodsLensEnabled()) return null;

  const gate = await loadFamilyOverlayGate();

  const rows = await prisma.scholarFamily.findMany({
    where: {
      supercategory,
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] },
      },
    },
    select: {
      familyLabel: true,
      pmidCount: true,
      scholar: {
        select: { cwid: true, slug: true, preferredName: true, primaryTitle: true },
      },
    },
  });

  type Agg = {
    scholar: { cwid: string; slug: string; preferredName: string; primaryTitle: string | null };
    total: number;
  };
  const byCwid = new Map<string, Agg>();
  for (const r of rows) {
    if (!r.scholar) continue;
    // Drop contributions from suppressed/sensitive families BEFORE aggregating.
    if (!isFamilyPubliclyVisible(supercategory, r.familyLabel, gate)) continue;
    const entry = byCwid.get(r.scholar.cwid) ?? { scholar: r.scholar, total: 0 };
    entry.total += r.pmidCount;
    byCwid.set(r.scholar.cwid, entry);
  }

  const sorted = Array.from(byCwid.values()).sort((a, b) => b.total - a.total);
  if (sorted.length < TOP_SCHOLARS_FLOOR) return null;

  return sorted.slice(0, TOP_SCHOLARS_TARGET).map((e, i) => ({
    cwid: e.scholar.cwid,
    slug: e.scholar.slug,
    preferredName: e.scholar.preferredName,
    primaryTitle: e.scholar.primaryTitle,
    identityImageEndpoint: identityImageEndpoint(e.scholar.cwid),
    rank: i + 1,
  }));
}

/**
 * Family researcher rows for the supercategory page's right panel (the
 * SubtopicScholarRow analog, #172). Up to 10, ranked by per-scholar `pmidCount`,
 * active-only; floor 1 (narrow scope). Carries `primaryDepartment`, the in-family
 * pub count (`pubCountInSubtopic` reused as the family count), and the scholar's
 * total confirmed pub count (#356-adjusted). Lens-off / gated ⇒ null.
 *
 * Roster eligibility is gated by `isMethodsFamilyRosterFallbackOn()`
 * (`METHODS_LENS_FAMILY_ROSTER_FALLBACK`, default OFF). When OFF the row is
 * FT-faculty-only (the `TOP_SCHOLARS_ELIGIBLE_ROLES` carve), byte-identical to the
 * pre-#862 row. When ON, method/tool attribution is heavily trainee/core-driven —
 * a faculty-only filter empties the row for any family whose attributed active
 * scholars are all postdocs/fellows/core staff (#862) — so we backfill attributed
 * non-faculty after the faculty. Either way we fetch all active attributed
 * scholars, drop hidden identity classes (`isPubliclyDisplayed` — keeps
 * doctoral_student/affiliate_alumni out per #536, independent of the flag, in
 * lockstep with every other profile-link site), then stable-partition faculty-first
 * so PIs always rank above any backfilled non-faculty before the target slice.
 */
export async function getFamilyScholarRows(
  supercategory: string,
  familyLabel: string,
): Promise<SubtopicScholarRowData[] | null> {
  if (!isMethodsLensEnabled()) return null;

  const gate = await loadFamilyOverlayGate();
  if (!isFamilyPubliclyVisible(supercategory, familyLabel, gate)) return null;

  const rows = await prisma.scholarFamily.findMany({
    where: {
      supercategory,
      familyLabel,
      scholar: {
        deletedAt: null,
        status: "active",
      },
    },
    orderBy: [{ pmidCount: "desc" }, { familyId: "asc" }],
    select: {
      pmidCount: true,
      scholar: {
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          primaryTitle: true,
          primaryDepartment: true,
          roleCategory: true,
        },
      },
    },
  });

  // Drop hidden identity classes (doctoral_student / affiliate_alumni) — they are
  // soft-deleted in ETL and excluded by deletedAt above, but keep the gate so a
  // public profile link is never minted for them if one ever survives the join.
  const visible = rows.filter((r) => isPubliclyDisplayed(r.scholar!.roleCategory));

  // Stable-partition faculty-first: PIs (TOP_SCHOLARS_ELIGIBLE_ROLES) keep their
  // pmidCount order, then — only when METHODS_LENS_FAMILY_ROSTER_FALLBACK is on —
  // attributed non-faculty backfill (also pmidCount order) so a trainee/core-only
  // family renders a row instead of an empty one (#862). Flag off ⇒ FT-faculty-only
  // (byte-identical to the pre-#862 row), matching the FT-faculty framing sign-off.
  const facultyRoles = new Set<string>(TOP_SCHOLARS_ELIGIBLE_ROLES);
  const faculty = visible.filter((r) => facultyRoles.has(r.scholar!.roleCategory ?? ""));
  const nonFaculty = visible.filter((r) => !facultyRoles.has(r.scholar!.roleCategory ?? ""));
  const ranked = isMethodsFamilyRosterFallbackOn() ? [...faculty, ...nonFaculty] : faculty;
  if (ranked.length < FAMILY_SCHOLARS_FLOOR) return null;

  const top = ranked.slice(0, FAMILY_SCHOLARS_TARGET);
  const cwids = top.map((r) => r.scholar!.cwid);

  // Total confirmed pub count per scholar (#356 — subtract per-author hides).
  const [totalCounts, hiddenCounts] = await Promise.all([
    prisma.publicationAuthor.groupBy({
      by: ["cwid"],
      where: { cwid: { in: cwids }, isConfirmed: true },
      _count: { pmid: true },
    }),
    loadHiddenAuthorshipCounts(cwids, prisma),
  ]);
  const totalByCwid = new Map<string, number>();
  for (const r of totalCounts) {
    if (r.cwid) {
      totalByCwid.set(r.cwid, Math.max(0, r._count.pmid - (hiddenCounts.get(r.cwid) ?? 0)));
    }
  }

  return top.map((r, i) => ({
    cwid: r.scholar!.cwid,
    slug: r.scholar!.slug,
    preferredName: r.scholar!.preferredName,
    primaryTitle: r.scholar!.primaryTitle,
    primaryDepartment: r.scholar!.primaryDepartment,
    identityImageEndpoint: identityImageEndpoint(r.scholar!.cwid),
    pubCountInSubtopic: r.pmidCount,
    pubCountTotal: totalByCwid.get(r.scholar!.cwid) ?? 0,
    rank: i + 1,
  }));
}

// ---------------------------------------------------------------------------
// #853 — a single scholar's prominent method families (popover section)
// ---------------------------------------------------------------------------

/** One of a scholar's prominent method families for the #853 popover section.
 *  `href` is the canonical `/methods` family page path. */
export type ScholarMethodFamily = {
  supercategory: string;
  familyLabel: string;
  familyId: string;
  pmidCount: number;
  href: string;
};

/** Cap on the families surfaced in the #853 popover section. */
const POPOVER_METHOD_FAMILIES_CAP = 5;

/**
 * A single scholar's most-prominent method families for the #853 popover
 * section — their `ScholarFamily` rows ranked by `pmidCount` desc, restricted to
 * overlay-VISIBLE families (suppressed/sensitive dropped BEFORE ranking via the
 * SAME #800/#801 gate every Method page uses), capped at 5. Lens-off ⇒ `[]`. No
 * families, or all suppressed ⇒ `[]`.
 *
 * Unlike the PI chip row, this loader does NOT apply the `TOP_SCHOLARS_ELIGIBLE_ROLES`
 * carve — the popover target is already a vetted top scholar; this just enumerates
 * THAT scholar's own families (matching the "anyone with a row" semantics of the
 * other enumerative surfaces), filtered active/non-deleted.
 */
export async function getScholarMethodFamilies(
  cwid: string,
): Promise<ScholarMethodFamily[]> {
  if (!isMethodsLensEnabled()) return [];
  if (!cwid) return [];

  const gate = await loadFamilyOverlayGate();

  const rows = await prisma.scholarFamily.findMany({
    where: { cwid, scholar: { deletedAt: null, status: "active" } },
    orderBy: [{ pmidCount: "desc" }, { familyId: "asc" }],
    select: { supercategory: true, familyLabel: true, familyId: true, pmidCount: true },
  });

  const out: ScholarMethodFamily[] = [];
  for (const r of rows) {
    if (!isFamilyPubliclyVisible(r.supercategory, r.familyLabel, gate)) continue; // SAME gate
    out.push({
      supercategory: r.supercategory,
      familyLabel: r.familyLabel,
      familyId: r.familyId,
      pmidCount: r.pmidCount,
      href: methodFamilyPath(r.supercategory, r.familyId, r.familyLabel),
    });
    if (out.length >= POPOVER_METHOD_FAMILIES_CAP) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Representative + paged publications (§3.3 / §5)
// ---------------------------------------------------------------------------

/** Public publication hit for a family feed — same shape the topic feed renders,
 *  minus the topic-only `impactJustification` / `topTopic` fields (the family
 *  feed is single-leaf). Authors are confirmed WCM chips. */
export type MethodPublicationHit = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number;
  publicationType: string | null;
  citationCount: number | null;
  pubmedUrl: string | null;
  doi: string | null;
  pmcid: string | null;
  impactScore: number | null;
  abstract: string | null;
  /** Confirmed WCM author chips (headshot + first/last flags), citation order.
   *  Same shape the topic feed renders (`fetchWcmAuthorsForPmids`). `[]` when the
   *  publication has no confirmed WCM authors — the feed UI suppresses the row. */
  authors: WcmAuthorChip[];
};

const PUB_SELECT = {
  pmid: true,
  title: true,
  journal: true,
  year: true,
  publicationType: true,
  citationCount: true,
  pubmedUrl: true,
  doi: true,
  pmcid: true,
  impactScore: true,
  abstract: true,
  dateAddedToEntrez: true,
} as const;

/**
 * Union the distinct member `pmids` across the family's PUBLICLY-VISIBLE,
 * ACTIVE-scholar rows for `(supercategory, familyLabel)` (#356-dark publications
 * removed). Returns the deduped pmid set the feed/counts derive from. Empty when
 * the lens is off, the family is gated, or `ScholarFamily.pmids` is unpopulated
 * (pre-#175 rollup — the page then renders scholar-list-only, no crash; §3.3 E9).
 */
async function collectFamilyPmids(
  supercategory: string,
  familyLabel: string,
  gate: FamilyOverlayGate,
): Promise<string[]> {
  if (!isFamilyPubliclyVisible(supercategory, familyLabel, gate)) return [];

  const rows = await prisma.scholarFamily.findMany({
    where: {
      supercategory,
      familyLabel,
      scholar: { deletedAt: null, status: "active" },
    },
    select: { pmids: true },
  });

  const set = new Set<string>();
  for (const r of rows) {
    if (Array.isArray(r.pmids)) {
      for (const p of r.pmids as unknown[]) set.add(String(p));
    }
  }
  const pmids = [...set];
  if (pmids.length === 0) return [];

  // #356 — drop whole-pub takedowns / derived-dark before they reach a feed.
  const suppressions = await loadPublicationSuppressions(pmids, prisma);
  const dark = await resolveDarkPmids(pmids, suppressions, prisma);
  return pmids.filter((p) => !dark.has(p));
}

/**
 * Representative publications for a family — the union of `ScholarFamily.pmids`
 * across the gated, active scholars, resolved to `Publication`, suppression/dark
 * filtered, with confirmed WCM author chips. Ordered newest-first. `limit` caps
 * the representative set (default 12). Lens-off / gated / no-pmids ⇒ `[]`.
 */
export async function getRepresentativePubsForFamily(
  supercategory: string,
  familyLabel: string,
  limit = 12,
): Promise<MethodPublicationHit[]> {
  if (!isMethodsLensEnabled()) return [];
  const gate = await loadFamilyOverlayGate();
  const pmids = await collectFamilyPmids(supercategory, familyLabel, gate);
  if (pmids.length === 0) return [];

  const pubs = await prisma.publication.findMany({
    where: { pmid: { in: pmids }, publicationType: { notIn: HARD_EXCLUDE_TYPES } },
    select: PUB_SELECT,
    orderBy: [{ year: "desc" }, { dateAddedToEntrez: "desc" }],
    take: limit,
  });
  const authorsByPmid = await fetchWcmAuthorsForPmids(pubs.map((p) => p.pmid));
  return pubs.map((p) => mapPublicationHit(p, authorsByPmid.get(p.pmid)));
}

export type MethodPublicationSort = "newest" | "most_cited" | "by_impact";
export type MethodPublicationFilter = "research_articles_only" | "all";

export type MethodPublicationsResult = {
  hits: MethodPublicationHit[];
  total: number;
  totalAllTypes: number;
  totalResearchOnly: number;
  page: number;
  pageSize: number;
};

const METHOD_PUBLICATIONS_PAGE_SIZE = 20;

/**
 * Paged publication feed for a family page (§5.A) — the union of the family's
 * member pmids resolved to `Publication`, with sort + publication-type filter +
 * pagination, mirroring `getTopicPublications` minus the topic-only tier split
 * (no `displayThreshold` analog at family grain — single untiered list, §OQ-3b).
 *
 * Security: the route handler allow-lists sort/filter/slug + clamps page BEFORE
 * calling. This function trusts validated inputs. Lens-off / gated ⇒ null.
 */
export async function getFamilyPublications(
  supercategory: string,
  familyLabel: string,
  opts: { sort: MethodPublicationSort; page?: number; filter?: MethodPublicationFilter },
): Promise<MethodPublicationsResult | null> {
  if (!isMethodsLensEnabled()) return null;
  const gate = await loadFamilyOverlayGate();
  if (!isFamilyPubliclyVisible(supercategory, familyLabel, gate)) return null;

  const allPmids = await collectFamilyPmids(supercategory, familyLabel, gate);
  const includeImpact = (process.env.SEARCH_PUB_TAB_IMPACT ?? "off") === "on";
  const page = Math.max(0, opts.page ?? 0);
  const filter = opts.filter ?? "research_articles_only";

  if (allPmids.length === 0) {
    return {
      hits: [],
      total: 0,
      totalAllTypes: 0,
      totalResearchOnly: 0,
      page,
      pageSize: METHOD_PUBLICATIONS_PAGE_SIZE,
    };
  }

  const typeWhere =
    filter === "research_articles_only"
      ? { publicationType: { notIn: HARD_EXCLUDE_TYPES } }
      : {};

  const orderBy =
    opts.sort === "newest"
      ? [{ year: "desc" as const }, { dateAddedToEntrez: "desc" as const }]
      : opts.sort === "most_cited"
        ? [{ citationCount: "desc" as const }]
        : [{ impactScore: "desc" as const }, { year: "desc" as const }];

  const skip = page * METHOD_PUBLICATIONS_PAGE_SIZE;
  const [rows, total, totalAllTypes, totalResearchOnly] = await prisma.$transaction([
    prisma.publication.findMany({
      where: { pmid: { in: allPmids }, ...typeWhere },
      select: PUB_SELECT,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      orderBy: orderBy as any,
      skip,
      take: METHOD_PUBLICATIONS_PAGE_SIZE,
    }),
    prisma.publication.count({ where: { pmid: { in: allPmids }, ...typeWhere } }),
    prisma.publication.count({ where: { pmid: { in: allPmids } } }),
    prisma.publication.count({
      where: { pmid: { in: allPmids }, publicationType: { notIn: HARD_EXCLUDE_TYPES } },
    }),
  ]);

  const authorsByPmid = await fetchWcmAuthorsForPmids(rows.map((r) => r.pmid));
  void includeImpact;
  return {
    hits: rows.map((r) => mapPublicationHit(r, authorsByPmid.get(r.pmid), includeImpact)),
    total,
    totalAllTypes,
    totalResearchOnly,
    page,
    pageSize: METHOD_PUBLICATIONS_PAGE_SIZE,
  };
}

function mapPublicationHit(
  p: {
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    publicationType: string | null;
    citationCount: number | null;
    pubmedUrl: string | null;
    doi: string | null;
    pmcid: string | null;
    impactScore: unknown;
  },
  authors: MethodPublicationHit["authors"] | undefined,
  includeImpact = (process.env.SEARCH_PUB_TAB_IMPACT ?? "off") === "on",
): MethodPublicationHit {
  let impactScore: number | null = null;
  if (includeImpact && p.impactScore !== null && p.impactScore !== undefined) {
    const n = Number(p.impactScore);
    impactScore = Number.isFinite(n) ? n : null;
  }
  return {
    pmid: p.pmid,
    title: p.title ?? "",
    journal: p.journal ?? null,
    year: p.year ?? 0,
    publicationType: p.publicationType ?? null,
    citationCount: p.citationCount ?? null,
    pubmedUrl: p.pubmedUrl ?? null,
    doi: p.doi ?? null,
    pmcid: p.pmcid ?? null,
    impactScore,
    abstract: null,
    authors: authors ?? ([] as MethodPublicationHit["authors"]),
  };
}

// ---------------------------------------------------------------------------
// Enumerative "all scholars in this family" (§5 /scholars page)
// ---------------------------------------------------------------------------

export type MethodScholarRole = "all" | "faculty" | "postdocs" | "doctoral_students";
export const METHOD_ALL_SCHOLARS_PAGE_SIZE = 22;

export type MethodScholarRow = {
  cwid: string;
  slug: string;
  preferredName: string;
  postnominal: string | null;
  primaryTitle: string | null;
  identityImageEndpoint: string;
  roleCategory: string | null;
  /** Per-scholar pub count within this family (the `scholar_family.pmidCount`). */
  pubCountInFamily: number;
};

export type MethodScholarsResult = {
  total: number;
  roleCounts: { all: number; faculty: number; postdocs: number; doctoralStudents: number };
  hits: MethodScholarRow[];
  page: number;
  pageSize: number;
};

const ROLE_FILTER_CATEGORIES: Record<Exclude<MethodScholarRole, "all">, string[]> = {
  faculty: ["full_time_faculty"],
  postdocs: ["postdoc"],
  doctoral_students: ["doctoral_student"],
};

/**
 * Comprehensive enumerative scholar list for a family — alphabetical by surname,
 * role-filterable, name-searchable, paginated. NO eligibility carve (anyone with a
 * `scholar_family` row in this family), active-only. Mirrors `getTopicScholars`.
 * Lens-off / gated ⇒ null.
 */
export async function getMethodScholars(
  supercategory: string,
  familyLabel: string,
  opts: { page?: number; role?: MethodScholarRole; q?: string },
): Promise<MethodScholarsResult | null> {
  if (!isMethodsLensEnabled()) return null;
  const gate = await loadFamilyOverlayGate();
  if (!isFamilyPubliclyVisible(supercategory, familyLabel, gate)) return null;

  const page = Math.max(0, opts.page ?? 0);
  const role: MethodScholarRole = opts.role ?? "all";
  const q = opts.q?.trim() ?? "";

  const scholarFilter: Record<string, unknown> = { deletedAt: null, status: "active" };
  if (q.length > 0) scholarFilter.preferredName = { contains: q };

  const rows = await prisma.scholarFamily.findMany({
    where: { supercategory, familyLabel, scholar: scholarFilter },
    select: {
      pmidCount: true,
      scholar: {
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          postnominal: true,
          primaryTitle: true,
          roleCategory: true,
        },
      },
    },
  });

  // Role counts within the name-filtered universe (does NOT apply the role filter
  // — each chip badge reflects its own bucket regardless of the active chip).
  let allCount = 0;
  let facultyCount = 0;
  let postdocsCount = 0;
  let doctoralCount = 0;
  for (const r of rows) {
    if (!r.scholar) continue;
    allCount += 1;
    if (r.scholar.roleCategory === "full_time_faculty") facultyCount += 1;
    else if (r.scholar.roleCategory === "postdoc") postdocsCount += 1;
    else if (r.scholar.roleCategory === "doctoral_student") doctoralCount += 1;
  }

  const filtered =
    role === "all"
      ? rows
      : rows.filter(
          (r) =>
            r.scholar &&
            ROLE_FILTER_CATEGORIES[role].includes(r.scholar.roleCategory ?? ""),
        );

  const enriched = filtered
    .filter((r) => r.scholar)
    .map((r) => ({
      ...r.scholar!,
      pubCountInFamily: r.pmidCount,
      lastName: extractLastName(r.scholar!.preferredName),
    }));
  enriched.sort(
    (a, b) =>
      a.lastName.localeCompare(b.lastName) ||
      a.preferredName.localeCompare(b.preferredName) ||
      a.cwid.localeCompare(b.cwid),
  );

  const total = enriched.length;
  const skip = page * METHOD_ALL_SCHOLARS_PAGE_SIZE;
  const slice = enriched.slice(skip, skip + METHOD_ALL_SCHOLARS_PAGE_SIZE);

  return {
    total,
    roleCounts: {
      all: allCount,
      faculty: facultyCount,
      postdocs: postdocsCount,
      doctoralStudents: doctoralCount,
    },
    hits: slice.map((s) => ({
      cwid: s.cwid,
      slug: s.slug,
      preferredName: s.preferredName,
      postnominal: s.postnominal,
      primaryTitle: s.primaryTitle,
      identityImageEndpoint: identityImageEndpoint(s.cwid),
      roleCategory: s.roleCategory,
      pubCountInFamily: s.pubCountInFamily,
    })),
    page,
    pageSize: METHOD_ALL_SCHOLARS_PAGE_SIZE,
  };
}

/** Surname extraction for sort + alpha dividers — preferredName is "Given Last". */
function extractLastName(preferredName: string): string {
  const tokens = preferredName.trim().split(/\s+/).filter(Boolean);
  return tokens.length === 0 ? "" : tokens[tokens.length - 1];
}

/** Last-name initial for the §13 alpha-divider grouping; non-A–Z → "#". */
export function methodScholarLastNameInitial(preferredName: string): string {
  const last = extractLastName(preferredName);
  const ch = last.charAt(0).toUpperCase();
  return ch >= "A" && ch <= "Z" ? ch : "#";
}

// ---------------------------------------------------------------------------
// Hub enumeration (§ /methods hub) — the ~14 supercategories with live families.
// ---------------------------------------------------------------------------

/** One publicly-visible family under a hub supercategory (B5/B6). `familyId` is the
 *  live `fam_NNNN` used to build the `/methods/{sc}?family={familyId}` deep-link;
 *  it is sourced from the same fresh roster the supercategory page renders, so it
 *  is never stale relative to the rail. Ordered by distinct-scholar count desc. */
export type HubFamily = {
  familyId: string;
  familyLabel: string;
  scholarCount: number;
};

/** One supercategory tile for the `/methods` hub: id, slug, label, description,
 *  the count of publicly-visible families, and the family list itself (B5). */
export type SupercategoryHubEntry = ResolvedSupercategory & {
  familyCount: number;
  families: HubFamily[];
};

/**
 * Enumerate the supercategories that have at least one publicly-visible family
 * (the `/methods` hub). Re-derives slug + label for each live supercategory,
 * post-overlay-gate; drops any whose entire roster is suppressed/sensitive.
 * Sorted by label. Each entry carries its visible families (B5) so the hub can
 * list + deep-link them. Lens-off ⇒ `[]`. Logs (warn-not-fail) a live
 * supercategory id missing from the static label map (open-set drift, §E8).
 */
export async function getSupercategoryHubEntries(): Promise<SupercategoryHubEntry[]> {
  if (!isMethodsLensEnabled()) return [];
  const gate = await loadFamilyOverlayGate();

  const groups = await prisma.scholarFamily.groupBy({ by: ["supercategory"] });
  const out: SupercategoryHubEntry[] = [];
  for (const g of groups) {
    if (!isKnownSupercategory(g.supercategory)) {
      console.warn(
        JSON.stringify({ event: "methods_unmapped_supercategory", supercategory: g.supercategory }),
      );
    }
    // Hub rows show only label + count, so skip the per-family exemplar read.
    const families = await getFamiliesForSupercategory(g.supercategory, gate, {
      skipExemplars: true,
    });
    if (families.length === 0) continue;
    out.push({
      id: g.supercategory,
      slug: supercategorySlug(g.supercategory),
      label: supercategoryLabel(g.supercategory),
      description: supercategoryDescription(g.supercategory),
      familyCount: families.length,
      families: families.map((f) => ({
        familyId: f.familyId,
        familyLabel: f.familyLabel,
        scholarCount: f.scholarCount,
      })),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
