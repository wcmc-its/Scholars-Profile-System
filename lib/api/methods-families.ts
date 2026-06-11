/**
 * Comms-steward Method-Family roster (server-side builder) —
 * `docs/comms-steward-methods-visibility-spec.md` §7.
 *
 * One join across the four family surfaces — distinct `(supercategory,
 * family_label)` in `scholar_family`, the #800 suppression overlay, the #801
 * sensitivity overlay, and the `family_review_flag` surfacing ledger — projected
 * into a flat roster the steward UI table (and the CSV export) render. Keyed
 * everywhere on the STABLE `(supercategory, family_label)` identity via
 * {@link familyOverlayKey}; the re-mintable `family_id` never appears.
 *
 * The `tier` is derived from overlay membership, NOT a stored column: a family in
 * the suppression overlay is "suppressed"; one in the sensitivity overlay is
 * "sensitive"; one in neither is "public" (the default — no overlay row). This is
 * the same precedence the audit SQL (§14) and the query-time resolver use:
 * suppression wins over sensitivity if a family were ever (incorrectly) in both,
 * matching the `loadFamilyOverlayGate` "suppressed first" check.
 *
 * Server-only (queries Prisma); the route handlers gate auth + the
 * `COMMS_STEWARD_ENABLED` flag before calling this builder, which trusts its
 * inputs and only assembles data.
 */
import { prisma } from "@/lib/db";
import { familyOverlayKey } from "@/lib/api/methods-overlay";

/** The three visibility tiers (§2), derived from overlay membership. */
export type FamilyTier = "public" | "suppressed" | "sensitive";

export const FAMILY_TIERS: ReadonlySet<FamilyTier> = new Set<FamilyTier>([
  "public",
  "suppressed",
  "sensitive",
]);

/** A roster filter (§7) — the steward UI's filter bar + the export query param. */
export type FamilyRosterFilter =
  | "all"
  | "flagged"
  | "new"
  | "public"
  | "suppressed"
  | "sensitive";

export const ROSTER_FILTERS: ReadonlySet<FamilyRosterFilter> =
  new Set<FamilyRosterFilter>(["all", "flagged", "new", "public", "suppressed", "sensitive"]);

/** One roster row — a distinct family with its derived tier + surfacing signal. */
export interface FamilyRosterRow {
  supercategory: string;
  familyLabel: string;
  tier: FamilyTier;
  /** The surfacing-pass reason (`supercategory:…` / `term:…`), or null if unflagged. */
  reason: string | null;
  /** Surfaced this run and not yet reviewed — the top of the review queue (§6). */
  isNew: boolean;
  /** ISO timestamp a steward cleared the nag, or null (tier may still be public). */
  reviewedAt: string | null;
  /** Distinct scholars in this family. */
  scholarCount: number;
  /** Sum of per-scholar `pmidCount` across the family's scholars. */
  pmidCount: number;
}

/** A read-capable Prisma client (the live client by default; injectable for tests). */
type PrismaRead = typeof prisma;

/**
 * Derive `isNew`'s reference instant: the start of the most-recent surfacing
 * pass. The ledger has no dedicated "run start" column, so we use the maximum
 * `lastSeenAt` across all `family_review_flag` rows — the surfacing pass bumps
 * `lastSeenAt` on EVERY row it touches to that run's timestamp, so the max is the
 * latest run's mark. A row is "new" when its `firstSeenAt >= that instant`: the
 * pass sets `firstSeenAt === lastSeenAt` on first insert, so a family that first
 * appeared (or was relabeled into a new key) in the latest pass has a
 * `firstSeenAt` at the run mark, while an older family's `firstSeenAt` predates
 * it. `null` when the ledger is empty (no pass has run) — nothing is new then.
 *
 * HEURISTIC (documented): "latest run start ≈ max(lastSeenAt)". Exact, given the
 * surfacing pass writes a single run-wide timestamp; degrades gracefully if a
 * future pass were to write per-row clock reads (a sub-second skew could mis-mark
 * a boundary row, never a wholesale error).
 */
async function latestRunMark(db: PrismaRead): Promise<Date | null> {
  const agg = await db.familyReviewFlag.aggregate({ _max: { lastSeenAt: true } });
  return agg._max.lastSeenAt ?? null;
}

/**
 * Build the full roster (pre-filter). Loads the four surfaces, folds them on the
 * stable key, derives the tier + `isNew`, and returns rows ordered by the §6
 * review-queue priority: new∧flagged, then flagged∧unreviewed, then
 * flagged∧reviewed, then unflagged — each band alphabetized by family label so
 * the order is stable.
 */
export async function buildFamilyRoster(
  db: PrismaRead = prisma,
): Promise<FamilyRosterRow[]> {
  const [families, suppression, sensitivity, flags, runMark] = await Promise.all([
    // Distinct (supercategory, family_label) with aggregate counts. groupBy gives
    // the distinct keys + a per-key scholar count and pmid sum in one query.
    db.scholarFamily.groupBy({
      by: ["supercategory", "familyLabel"],
      _count: { cwid: true },
      _sum: { pmidCount: true },
    }),
    db.familySuppressionOverlay.findMany({
      select: { supercategory: true, familyLabel: true },
    }),
    db.familySensitivityOverlay.findMany({
      select: { supercategory: true, familyLabel: true },
    }),
    db.familyReviewFlag.findMany({
      select: {
        supercategory: true,
        familyLabel: true,
        reason: true,
        firstSeenAt: true,
        reviewedAt: true,
      },
    }),
    latestRunMark(db),
  ]);

  const suppressed = new Set(
    suppression.map((o) => familyOverlayKey(o.supercategory, o.familyLabel)),
  );
  const sensitive = new Set(
    sensitivity.map((o) => familyOverlayKey(o.supercategory, o.familyLabel)),
  );
  const flagByKey = new Map(
    flags.map((f) => [familyOverlayKey(f.supercategory, f.familyLabel), f]),
  );

  const rows: FamilyRosterRow[] = families.map((f) => {
    const key = familyOverlayKey(f.supercategory, f.familyLabel);
    // Suppression precedence mirrors `loadFamilyOverlayGate` (suppressed first).
    const tier: FamilyTier = suppressed.has(key)
      ? "suppressed"
      : sensitive.has(key)
        ? "sensitive"
        : "public";
    const flag = flagByKey.get(key);
    const isNew =
      flag !== undefined &&
      runMark !== null &&
      flag.reviewedAt === null &&
      flag.firstSeenAt.getTime() >= runMark.getTime();
    return {
      supercategory: f.supercategory,
      familyLabel: f.familyLabel,
      tier,
      reason: flag?.reason ?? null,
      isNew,
      reviewedAt: flag?.reviewedAt ? flag.reviewedAt.toISOString() : null,
      scholarCount: f._count.cwid,
      pmidCount: f._sum.pmidCount ?? 0,
    };
  });

  return rows.sort(comparePriority);
}

/**
 * The §6 review-queue ordering: new∧flagged (4) > flagged∧¬reviewed (3) >
 * flagged∧reviewed (2) > unflagged (1). Higher band first; within a band,
 * alphabetical by family label (then supercategory) for a stable order.
 */
function priorityBand(r: FamilyRosterRow): number {
  const flagged = r.reason !== null;
  if (flagged && r.isNew) return 4;
  if (flagged && r.reviewedAt === null) return 3;
  if (flagged) return 2;
  return 1;
}

function comparePriority(a: FamilyRosterRow, b: FamilyRosterRow): number {
  const band = priorityBand(b) - priorityBand(a);
  if (band !== 0) return band;
  const label = a.familyLabel.localeCompare(b.familyLabel);
  if (label !== 0) return label;
  return a.supercategory.localeCompare(b.supercategory);
}

/** Apply a roster filter (§7). `all` is the identity; the rest narrow by signal
 *  (`flagged`/`new`) or by derived tier. */
export function applyRosterFilter(
  rows: FamilyRosterRow[],
  filter: FamilyRosterFilter,
): FamilyRosterRow[] {
  switch (filter) {
    case "all":
      return rows;
    case "flagged":
      return rows.filter((r) => r.reason !== null);
    case "new":
      return rows.filter((r) => r.isNew);
    case "public":
    case "suppressed":
    case "sensitive":
      return rows.filter((r) => r.tier === filter);
  }
}

/** Parse an untrusted `?filter=` value; defaults to `all` for unknown/absent. */
export function parseRosterFilter(raw: string | null): FamilyRosterFilter {
  return raw && ROSTER_FILTERS.has(raw as FamilyRosterFilter)
    ? (raw as FamilyRosterFilter)
    : "all";
}

/** Parse an untrusted `?supercategory=` value — a comma-separated list — into a
 *  deduped, trimmed, non-empty array. Absent/blank ⇒ `[]` (no narrowing). */
export function parseSupercategoriesParam(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** Narrow a roster to the given supercategories. An empty list is the identity
 *  (no supercategory selected ⇒ show all). Composes AFTER `applyRosterFilter`. */
export function applySupercategoryFilter(
  rows: FamilyRosterRow[],
  supercategories: readonly string[],
): FamilyRosterRow[] {
  if (supercategories.length === 0) return rows;
  const allow = new Set(supercategories);
  return rows.filter((r) => allow.has(r.supercategory));
}
