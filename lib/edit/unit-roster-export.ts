/**
 * Unit-roster CSV export (#1102) — the flag gate, the membership status
 * derivation, and the CSV builder for the `/edit/{center,division}/[code]/export`
 * roster download.
 *
 * The roster itself is loaded by `loadUnitEditContext` (the SAME read the Members
 * tab renders), so the unit CODE — not a query param — is the authorization
 * boundary: the export route re-derives the actor's role on that unit via
 * `loadUnitEditContext` and 401/404s before serializing anything.
 *
 * Flag is read lazily inside the helper (never at module load), per the repo
 * convention (mirrors `isOrgUnitCreateSuperuserOnly` / `isDataQualityDashboardEnabled`).
 * Off by default so the affordance ships dark (prod-dark) pending rollout.
 *
 * NO email column, by the #847 no-email decision — a roster CSV never carries a
 * contact address.
 *
 * GUARDRAIL: this module sources membership ONLY from the `UnitEditContext`
 * roster (Prisma, via `lib/api/centers.ts`/`loadUnitEditContext`), NEVER from the
 * search index. It does not emit, read, or reference any `centerProgram:` or
 * browse-facet key (#1074/#1076).
 */
import { toCsv, type CsvCell } from "@/lib/csv";
import type { UnitEditContext } from "@/lib/api/unit-edit-context";

/**
 * Whether the per-unit roster CSV export is enabled (off by default). When off
 * the route 404s and the Members-tab "Export CSV" control is hidden — mirroring
 * `isDataQualityDashboardEnabled` / `isOrgUnitCreateSuperuserOnly`.
 */
export function isUnitRosterExportEnabled(): boolean {
  return process.env.EDIT_UNIT_ROSTER_EXPORT === "on";
}

export type RosterStatus = "active" | "pending" | "inactive";

/**
 * The membership status, mirroring `statusOf` in `center-roster-card.tsx`
 * (#552 §3.3 active filter, inclusive boundaries, nulls open). Kept in lock-step
 * with the UI so the CSV `status` column matches the table badge exactly.
 */
export function rosterStatusOf(
  member: { startDate: string | null; endDate: string | null },
  today: string,
): RosterStatus {
  if (member.startDate && member.startDate > today) return "pending";
  if (member.endDate && member.endDate < today) return "inactive";
  return "active";
}

/** Column order — the CSV header row + the per-row projection key order (#1102). */
export const ROSTER_CSV_HEADERS = [
  "cwid",
  "name",
  "title",
  "membership_type",
  "program_code",
  "program_label",
  "start_date",
  "end_date",
  "status",
  "source",
] as const;

export type BuildRosterCsvOptions = {
  /** Today as `YYYY-MM-DD` (injectable for tests / determinism). */
  today: string;
  /** When true, drop pending + inactive rows (the `?activeOnly=1` mode). */
  activeOnly?: boolean;
};

/**
 * Serialize a unit's roster to CSV. `program_label` is resolved from the
 * center's program taxonomy (`ctx.programs`); a manual division has no program /
 * type taxonomy, so those columns come through empty. Pending + inactive members
 * are included by default (the dropped/lapsed-member visibility the Members tab
 * also exposes); `activeOnly` honors the dashboard-style narrowing.
 */
export function buildUnitRosterCsv(
  ctx: UnitEditContext,
  options: BuildRosterCsvOptions,
): string {
  const { today, activeOnly = false } = options;
  const roster = ctx.roster ?? [];
  const programLabel = new Map<string, string>(
    (ctx.programs ?? []).map((p) => [p.code, p.label]),
  );

  const body: CsvCell[][] = [];
  for (const m of roster) {
    const status = rosterStatusOf(m, today);
    if (activeOnly && status !== "active") continue;
    body.push([
      m.cwid,
      m.name,
      m.title ?? "",
      m.membershipType ?? "",
      m.programCode ?? "",
      m.programCode ? (programLabel.get(m.programCode) ?? "") : "",
      m.startDate ?? "",
      m.endDate ?? "",
      status,
      m.source,
    ]);
  }
  return toCsv(ROSTER_CSV_HEADERS, body);
}

/** Count of rows the CSV body will contain under the given options (for logging). */
export function countRosterCsvRows(
  ctx: UnitEditContext,
  options: BuildRosterCsvOptions,
): number {
  const { today, activeOnly = false } = options;
  const roster = ctx.roster ?? [];
  if (!activeOnly) return roster.length;
  return roster.filter((m) => rosterStatusOf(m, today) === "active").length;
}
