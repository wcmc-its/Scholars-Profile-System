/**
 * The ONE home of the "which scholars does this selection pick" rule — the
 * person-type + org-unit filter the Profiles / COI rosters (`lib/api/data-quality.ts`,
 * Prisma) and report 8 (`lib/edit/article-count-report.ts`, raw SQL) share.
 *
 * URL vocabulary (`PERSON_FILTER_PARAMS`): repeated `type` (raw roleCategory)
 * and repeated `unit` (`dept:CODE` / `div:CODE` / `center:CODE` / `inst:CODE`).
 * A selection is: role_category IN types AND (any selected unit matches), units
 * OR'd together. dept / div / institution are scholar columns; a center is its
 * CURRENT members (`isCurrentCenterMembership` / `currentCenterMembershipSql`).
 *
 * ONE rule for undecodable units, every consumer: a unit filter is present iff
 * any `unit` value was given (`unitValues`, raw) — both builders key on that and
 * decode it themselves. Values given but none decode → match NOTHING, never
 * everyone (a mangled link must not widen to the whole institution).
 *
 * `UNIT_KINDS` is the single kind → column table both builders iterate, so a
 * kind cannot be added to one side only (`tests/unit/person-filter-parity.test.ts`).
 *
 * Server-safe and client-free: no `@/lib/db`, no prisma client at module scope
 * (a caller that needs a query passes its client). The `Prisma` value import is
 * the generated namespace (`Prisma.sql`), not a client — still, import this
 * module from a `"use client"` file type-only.
 */
import type { DataQualityFacets } from "@/lib/api/data-quality";
import type { EditRosterUnitFilter } from "@/lib/api/edit-roster";
import { Prisma } from "@/lib/generated/prisma/client";
import { INVITED_ROLE_KEY } from "@/lib/org-unit-roles";

/** Reserved URL param names. A report must not reuse them for anything else. */
export const PERSON_FILTER_PARAMS = { type: "type", unit: "unit" } as const;

export type UnitKind = EditRosterUnitFilter["kind"];

/** The person-type column on each side. */
export const PERSON_TYPE_COLUMN = { sql: "role_category", prisma: "roleCategory" } as const;

/**
 * Unit kind → URL prefix + scholar column (SQL / Prisma). `center` has no
 * scholar column: it resolves through `center_membership`. Order is the OR
 * order both builders emit.
 */
export const UNIT_KINDS = {
  department: { prefix: "dept", sql: "dept_code", prisma: "deptCode" },
  division: { prefix: "div", sql: "div_code", prisma: "divCode" },
  institution: { prefix: "inst", sql: "primary_org_code", prisma: "primaryOrgCode" },
  center: { prefix: "center", sql: null, prisma: null },
} as const satisfies Record<
  UnitKind,
  { prefix: string; sql: string | null; prisma: keyof Prisma.ScholarWhereInput | null }
>;

const KIND_ORDER = Object.keys(UNIT_KINDS) as UnitKind[];

/** Decode a unit-filter value (`dept:CODE` / `div:CODE` / `center:CODE` / `inst:CODE`). */
export function parseUnitValue(v: string): EditRosterUnitFilter | null {
  const sep = v.indexOf(":");
  if (sep < 0) return null;
  const prefix = v.slice(0, sep);
  const code = v.slice(sep + 1);
  if (!code) return null;
  const kind = KIND_ORDER.find((k) => UNIT_KINDS[k].prefix === prefix);
  return kind ? { kind, code } : null;
}

export type PersonFilter = {
  /** Raw roleCategory values. */
  types: string[];
  /** The raw encoded `unit` values, trimmed, non-empty — for hrefs / UI seeding. */
  unitValues: string[];
  /** The decodable subset of `unitValues`. */
  units: EditRosterUnitFilter[];
};

/** The decodable subset of raw `unit` values, in order. */
export function decodeUnitValues(values: readonly string[]): EditRosterUnitFilter[] {
  return values.map(parseUnitValue).filter((u): u is EditRosterUnitFilter => u !== null);
}

/** Parse `type` / `unit` from a `URLSearchParams` OR a Next searchParams object. */
export function parsePersonFilter(
  source: URLSearchParams | Record<string, string | string[] | undefined>,
): PersonFilter {
  const valuesOf = (key: string): string[] => {
    if (source instanceof URLSearchParams) return source.getAll(key);
    const raw = source[key];
    return Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  };
  const clean = (key: string) =>
    valuesOf(key)
      .map((v) => v.trim())
      .filter(Boolean);
  const unitValues = clean(PERSON_FILTER_PARAMS.unit);
  return {
    types: clean(PERSON_FILTER_PARAMS.type),
    unitValues,
    units: decodeUnitValues(unitValues),
  };
}

/** Codes of one kind, in selection order. */
export function unitCodes(units: readonly EditRosterUnitFilter[], kind: UnitKind): string[] {
  return units.filter((u) => u.kind === kind).map((u) => u.code);
}

/** `unit` value → display label (department / division / center name,
 *  institution display name) from the facet options — for criteria text. */
export function unitLabels(facets: DataQualityFacets): Map<string, string> {
  const opts = [
    ...facets.departments.flatMap((d) => [d, ...d.divisions]),
    ...facets.centers,
    ...facets.institutions,
  ];
  return new Map(opts.map((o) => [o.value, o.label]));
}

/**
 * The who-filter rows of an export's criteria block — report 8's Criteria sheet
 * and the ORCID CSV header state the selection the same way. Pure (labels are
 * passed in). An unknown unit value prints raw. "All" when unset.
 */
export function personFilterCriteria(
  f: { types: readonly string[]; unitValues: readonly string[] },
  labels: ReadonlyMap<string, string>,
  roleLabel: (roleCategory: string) => string,
): [string, string][] {
  const list = (xs: string[]) => (xs.length > 0 ? xs.join("; ") : "All");
  const units = f.unitValues.map((u) => labels.get(u) ?? u);
  return [
    ["Person type", list(f.types.map(roleLabel))],
    ["Department / division / center / institution", units.length > 1 ? `Any of: ${list(units)}` : list(units)],
  ];
}

// ---------------------------------------------------------------------------
// "Current center membership" — the ONE date rule: UTC today; start null or
// <= today; end null or >= today (pending / expired excluded). An `invited`
// row is never current (same rule as `isCenterMembershipActive`).
// ---------------------------------------------------------------------------

/** UTC calendar date `YYYY-MM-DD` — not the DB session's CURDATE(). */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** In-app form (the Prisma path reads rows, then filters). */
export function isCurrentCenterMembership(
  row: { startDate: Date | null; endDate: Date | null; membershipRoleKey: string | null },
  today: string,
): boolean {
  if (row.membershipRoleKey === INVITED_ROLE_KEY) return false;
  const start = row.startDate ? row.startDate.toISOString().slice(0, 10) : null;
  const end = row.endDate ? row.endDate.toISOString().slice(0, 10) : null;
  if (start && start > today) return false; // pending
  if (end && end < today) return false; // expired
  return true;
}

/** SQL form: the date-active clause on a `center_membership` alias. */
export function currentCenterMembershipSql(alias: string, today: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.start_date IS NULL OR ${a}.start_date <= ${today})
           AND (${a}.end_date IS NULL OR ${a}.end_date >= ${today})
           AND (${a}.membership_role_key IS NULL OR ${a}.membership_role_key <> ${Prisma.raw(`'${INVITED_ROLE_KEY}'`)})`;
}

// ---------------------------------------------------------------------------
// Builders. Both take the RAW `unitValues` and decode them (module doc: one
// undecodable-unit rule). Units given but none decode, or decoded but nothing
// resolves (e.g. an empty center) → match nothing, on both sides.
// ---------------------------------------------------------------------------

/** `AND role_category IN (…) AND (unit OR group)` for a raw-SQL report. Undecodable-only
 *  units match nothing (`AND 1 = 0`). `aliases.scholar` is the `scholar` table alias. */
export function personFilterSql(
  f: Pick<PersonFilter, "types" | "unitValues">,
  aliases: { scholar: string; centerMembership?: string },
  today: string = utcToday(),
): Prisma.Sql {
  const s = aliases.scholar;
  const col = (c: string) => Prisma.raw(`${s}.${c}`);
  const parts: Prisma.Sql[] = [];
  if (f.types.length > 0) {
    parts.push(Prisma.sql`AND ${col(PERSON_TYPE_COLUMN.sql)} IN (${Prisma.join(f.types)})`);
  }
  if (f.unitValues.length > 0) {
    const units = decodeUnitValues(f.unitValues);
    const ors: Prisma.Sql[] = [];
    for (const kind of KIND_ORDER) {
      const codes = unitCodes(units, kind);
      if (codes.length === 0) continue;
      const column = UNIT_KINDS[kind].sql;
      if (column) {
        ors.push(Prisma.sql`${col(column)} IN (${Prisma.join(codes)})`);
      } else {
        const cm = aliases.centerMembership ?? "cm";
        ors.push(Prisma.sql`${col("cwid")} IN (SELECT ${Prisma.raw(cm)}.cwid FROM center_membership ${Prisma.raw(cm)}
         WHERE ${Prisma.raw(cm)}.center_code IN (${Prisma.join(codes)})
           AND ${currentCenterMembershipSql(cm, today)})`);
      }
    }
    parts.push(ors.length > 0 ? Prisma.sql`AND (${Prisma.join(ors, " OR ")})` : Prisma.sql`AND 1 = 0`);
  }
  return parts.length > 0 ? Prisma.join(parts, " ") : Prisma.empty;
}

/**
 * Prisma form for the rosters. `centerMemberCwids` = the current members of
 * the selected centers (resolved by the caller with `isCurrentCenterMembership`).
 * Returns the roleCategory filter (undefined = none; the caller owns the
 * include-hidden fallback) and the unit OR clause (undefined = no `unit` given;
 * `{ cwid: { in: [] } }` = match nothing).
 */
export function personFilterWhere(
  f: Pick<PersonFilter, "types" | "unitValues">,
  centerMemberCwids: readonly string[],
): { roleCategory?: { in: string[] }; unit?: Prisma.ScholarWhereInput } {
  const out: { roleCategory?: { in: string[] }; unit?: Prisma.ScholarWhereInput } = {};
  const types = f.types.filter(Boolean);
  if (types.length > 0) out.roleCategory = { in: [...types] };
  if (f.unitValues.length > 0) {
    const units = decodeUnitValues(f.unitValues);
    const ors: Prisma.ScholarWhereInput[] = [];
    for (const kind of KIND_ORDER) {
      const field = UNIT_KINDS[kind].prisma;
      if (field) {
        const codes = unitCodes(units, kind);
        if (codes.length > 0) ors.push({ [field]: { in: codes } });
      } else if (unitCodes(units, kind).length > 0 && centerMemberCwids.length > 0) {
        ors.push({ cwid: { in: [...centerMemberCwids] } });
      }
    }
    out.unit = ors.length > 0 ? { OR: ors } : { cwid: { in: [] } };
  }
  return out;
}
