/**
 * ED ETL — `field_override` precedence consult for dept/div (#540 Phase 4;
 * ADR-005 Amendment 1 § A1.1; SPEC § "The etl/ed precedence consult").
 *
 * Before the ETL writes `Department.slug` / `Division.slug` and assigns the
 * chair / chief column, it consults `field_override`. Curated values win over
 * the derivation pipeline and the auto-detection paths:
 *
 *   - `slug` override → wins outright; the ETL writes it verbatim and the
 *     collision-suffix derivation does NOT touch it (curator intent is the
 *     final word). Multiple overrides that collide would fail at write time
 *     against `Department.slug @unique` / `@@unique([deptCode, slug])`.
 *
 *   - `leaderCwid` override → wins over ADR-002 Path A (the chair regex) and
 *     Path B (the manager-graph chief detection). A non-empty value writes
 *     that CWID; the empty string is the curator's explicit "no leader" and
 *     writes `null` (and crucially does NOT re-engage auto-detection — that
 *     is the whole point of the override). Path C (`data/division-chiefs.txt`)
 *     stays as a fallback for divisions until the Phase 9 backfill copies
 *     its entries into `field_override` rows.
 *
 *   - `leaderInterim` has no ETL column to consult — it is a synthesized
 *     read-merge property at `lib/api/manual-layer.ts:mergeUnitFields`. The
 *     ETL is silent on it.
 *
 * The loader issues two `findMany`s, scoped to the field names this consult
 * cares about, and returns four maps. The resolver helpers below take the
 * code + the override map and emit a small variant the ETL can act on. The
 * pattern matches `loadUnitFieldOverrides` (`lib/api/manual-layer.ts`) — same
 * field set, different shape (bulk by entity vs. per-entity), so the ETL is
 * not paying a per-row round-trip.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The Prisma surface the loader needs — base client or interactive tx. */
type OverrideReadClient = Pick<PrismaClient, "fieldOverride">;

/**
 * Bulk-loaded override maps for one ETL run. Keyed on the unit `code`;
 * `string` values are the raw `field_override.value` — `""` is meaningful
 * (explicit clear), not absence.
 */
export type ETLUnitOverrides = {
  /** `field_override(department, code, 'slug')` — entityId is the dept code. */
  readonly deptSlugs: ReadonlyMap<string, string>;
  /** `field_override(division, code, 'slug')` — entityId is the div code. */
  readonly divSlugs: ReadonlyMap<string, string>;
  /** `field_override(department, code, 'leaderCwid')` — `""` = explicit vacancy. */
  readonly deptLeaders: ReadonlyMap<string, string>;
  /** `field_override(division, code, 'leaderCwid')` — `""` = explicit vacancy. */
  readonly divLeaders: ReadonlyMap<string, string>;
};

const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

/** Shared empty result — a run with no overrides allocates nothing. */
const NO_OVERRIDES: ETLUnitOverrides = {
  deptSlugs: EMPTY_MAP,
  divSlugs: EMPTY_MAP,
  deptLeaders: EMPTY_MAP,
  divLeaders: EMPTY_MAP,
};

/**
 * Load every active `field_override` row for dept/div slug + leaderCwid in
 * two queries (one per entityType). Centers are excluded — the write path
 * rejects `field_override` writes on a center (centers edit in-row), and the
 * ETL never writes the center table either way.
 *
 * The result is per-run, never cached across runs — an ETL run is itself the
 * "refresh"; subsequent runs reload. (Per-request immediacy applies to the
 * API read path, not to a batch ETL.)
 */
export async function loadUnitOverridesForETL(
  client: OverrideReadClient,
): Promise<ETLUnitOverrides> {
  const [deptRows, divRows] = await Promise.all([
    client.fieldOverride.findMany({
      where: {
        entityType: "department",
        fieldName: { in: ["slug", "leaderCwid"] },
      },
      select: { entityId: true, fieldName: true, value: true },
    }),
    client.fieldOverride.findMany({
      where: {
        entityType: "division",
        fieldName: { in: ["slug", "leaderCwid"] },
      },
      select: { entityId: true, fieldName: true, value: true },
    }),
  ]);
  if (deptRows.length === 0 && divRows.length === 0) return NO_OVERRIDES;

  const deptSlugs = new Map<string, string>();
  const deptLeaders = new Map<string, string>();
  for (const row of deptRows) {
    if (row.fieldName === "slug") deptSlugs.set(row.entityId, row.value);
    else if (row.fieldName === "leaderCwid") deptLeaders.set(row.entityId, row.value);
  }
  const divSlugs = new Map<string, string>();
  const divLeaders = new Map<string, string>();
  for (const row of divRows) {
    if (row.fieldName === "slug") divSlugs.set(row.entityId, row.value);
    else if (row.fieldName === "leaderCwid") divLeaders.set(row.entityId, row.value);
  }
  return { deptSlugs, divSlugs, deptLeaders, divLeaders };
}

/**
 * Pick the slug to write for a unit `code`.
 *
 * Override wins outright — the derived candidate and the collision-suffix
 * pipeline are skipped entirely. The caller is still responsible for adding
 * the chosen value to its `taken`/`used` set so a later unit's *derived* slug
 * does not collide with this override.
 *
 * Returns `{ slug, fromOverride }` so the caller can log the override count.
 */
export function resolveUnitSlugForETL(
  code: string,
  derivedSlug: string,
  overrides: ReadonlyMap<string, string>,
): { slug: string; fromOverride: boolean } {
  const override = overrides.get(code);
  if (override !== undefined) return { slug: override, fromOverride: true };
  return { slug: derivedSlug, fromOverride: false };
}

/** The three states the leader-override consult can return. */
export type ETLLeaderVerdict =
  | { applied: true; cwid: string | null; reason: "override" }
  | { applied: false; reason: "no_override" };

/**
 * Consult the `leaderCwid` override for a unit `code`.
 *
 * - Override with a non-empty value -> `{ applied: true, cwid: <value> }`.
 *   The ETL writes that CWID and SKIPS the regex / manager-graph detection.
 *
 * - Override with the empty string -> `{ applied: true, cwid: null }`. The
 *   curator's explicit "no leader"; the ETL writes `null` and crucially
 *   does NOT fall through to auto-detection (the three-state model from
 *   `lib/api/manual-layer.ts:mergeUnitFields`).
 *
 * - No override row -> `{ applied: false }`. The caller falls through to
 *   ADR-002 Path A (dept chair regex) / Path B (div chief detection) /
 *   Path C (`data/division-chiefs.txt`).
 *
 * The override CWID is written verbatim; the ETL does NOT cross-check it
 * against the scholar table. Override authority comes from the write path
 * (which validates); a transient absence (an override pinned ahead of an
 * incoming hire — SPEC edge 19) must not silently downgrade to auto-detection.
 */
export function resolveUnitLeaderForETL(
  code: string,
  overrides: ReadonlyMap<string, string>,
): ETLLeaderVerdict {
  const override = overrides.get(code);
  if (override === undefined) return { applied: false, reason: "no_override" };
  if (override === "") return { applied: true, cwid: null, reason: "override" };
  return { applied: true, cwid: override, reason: "override" };
}
