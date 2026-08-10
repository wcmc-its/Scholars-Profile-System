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
 * EMAIL + faculty metadata (email / role_category / department / division) are
 * emitted when the caller supplies `facultyByCwid` — the #847 no-email decision
 * is superseded for THIS surface only (the per-unit roster an admin already has
 * edit rights over); the #847 scope export keeps its own cap. The email cell
 * still stacks the `SCHOLAR_LIST_EXPORT_EMAIL` operator switch plus two filters
 * that are NOT policy toggles: the #536 hidden-display-role carve, and the Web
 * Directory release code (`isEmailExportableByReleaseCode`) — a scholar whose
 * release code is `none` has declined to have their address released, and no
 * unit admin's edit rights override that.
 *
 * NOTE: the release-code filter is INERT while `PROFILE_EMAIL_RELEASE_GATE` is
 * off (fail-open, and prod is off) — so on prod today this column emits every
 * member's address regardless of release code. The gate cannot be flipped until
 * the prod ED backfill populates `Scholar.emailVisibility` (NULL is fail-closed
 * and would blank email site-wide). Staging's backfill landed 2026-06-11.
 *
 * The faculty columns are loaded by `loadRosterFacultyMeta` from the ROUTE, not
 * folded into `UnitEditContext` — that context is serialized to the client for
 * the Members tab, and email has no business in a browser payload.
 *
 * GUARDRAIL: this module sources membership ONLY from the `UnitEditContext`
 * roster (Prisma, via `lib/api/centers.ts`/`loadUnitEditContext`), NEVER from the
 * search index. It does not emit, read, or reference any `centerProgram:` or
 * browse-facet key (#1074/#1076).
 *
 * GUARDRAIL: reachable from the CLIENT bundle (`components/edit/unit-edit-page.tsx`
 * imports `isUnitRosterExportEnabled`). Never import `@/lib/db` or anything that
 * constructs `prisma` at module scope — `loadRosterFacultyMeta` takes its client
 * as a parameter for exactly this reason.
 */
import { toCsv, type CsvCell } from "@/lib/csv";
import type { UnitEditContext } from "@/lib/api/unit-edit-context";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { isEmailExportableByReleaseCode } from "@/lib/profile/email-visibility-flags";
import { isScholarListExportEmailEnabled } from "@/lib/export/scholar-export-flags";

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

/** Column order — the CSV header row + the per-row projection key order (#1102).
 *  The trailing four are the faculty block; they come through EMPTY when the
 *  caller supplies no `facultyByCwid`, so the header row is stable either way
 *  (a consumer's column indices never shift under them). */
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
  "email",
  "role_category",
  "department",
  "division",
] as const;

/** Per-scholar faculty metadata joined onto a roster row by cwid. Loaded in the
 *  route via `loadRosterFacultyMeta` — never carried on `UnitEditContext`. */
export type RosterFacultyMeta = {
  email: string | null;
  /** The Web Directory release audience (`public` | `institution` | `none` |
   *  null). Gates the email cell; never emitted as a column itself. */
  emailVisibility: string | null;
  roleCategory: string | null;
  departmentName: string | null;
  divisionName: string | null;
};

export type BuildRosterCsvOptions = {
  /** Today as `YYYY-MM-DD` (injectable for tests / determinism). */
  today: string;
  /** When true, drop pending + inactive rows (the `?activeOnly=1` mode). */
  activeOnly?: boolean;
  /** cwid → faculty metadata. Omit to emit the four faculty columns empty. */
  facultyByCwid?: ReadonlyMap<string, RosterFacultyMeta>;
};

/**
 * The email cell for one roster row. Blank unless ALL THREE gates pass:
 *   1. `SCHOLAR_LIST_EXPORT_EMAIL` — the operator kill switch (#866). Reused
 *      rather than newly invented: it is already the per-env switch for "email
 *      column in an internal roster CSV" and is already "on" in staging + prod
 *      (2026-07-07, operator-approved), so this surface inherits an OFF lever
 *      that does not need a revert + redeploy to pull.
 *   2. #536 — a hidden-display role never emits contact info.
 *   3. SPEC §B.2 — the scholar's Web Directory release code permits it.
 * Blank (not omitted) so the column count is identical on every row.
 */
function emailCellFor(meta: RosterFacultyMeta | undefined): string {
  if (!meta?.email) return "";
  if (!isScholarListExportEmailEnabled()) return "";
  if (!isPubliclyDisplayed(meta.roleCategory)) return "";
  if (!isEmailExportableByReleaseCode(meta.emailVisibility)) return "";
  return meta.email;
}

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
  const { today, activeOnly = false, facultyByCwid } = options;
  const roster = ctx.roster ?? [];
  const programLabel = new Map<string, string>(
    (ctx.programs ?? []).map((p) => [p.code, p.label]),
  );

  const body: CsvCell[][] = [];
  for (const m of roster) {
    const status = rosterStatusOf(m, today);
    if (activeOnly && status !== "active") continue;
    const meta = facultyByCwid?.get(m.cwid);
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
      emailCellFor(meta),
      meta?.roleCategory ?? "",
      meta?.departmentName ?? "",
      meta?.divisionName ?? "",
    ]);
  }
  return toCsv(ROSTER_CSV_HEADERS, body);
}

/** The narrow Prisma surface `loadRosterFacultyMeta` reads — `db.read` satisfies
 *  it structurally, and the unit tests mock exactly this. Injected rather than
 *  imported so this module stays free of `@/lib/db` (see the header GUARDRAIL). */
export type RosterFacultyClient = {
  scholar: {
    findMany(args: unknown): Promise<
      Array<{
        cwid: string;
        email: string | null;
        emailVisibility: string | null;
        roleCategory: string | null;
        department: { name: string } | null;
        division: { name: string } | null;
      }>
    >;
  };
};

/**
 * Load the faculty block for a roster's cwids in ONE query. Returns an empty map
 * for an empty roster (no query issued). A roster cwid with no `Scholar` row —
 * an external member — is simply absent from the map and exports the four
 * faculty columns empty.
 */
export async function loadRosterFacultyMeta(
  cwids: ReadonlyArray<string>,
  client: RosterFacultyClient,
): Promise<Map<string, RosterFacultyMeta>> {
  const out = new Map<string, RosterFacultyMeta>();
  const unique = [...new Set(cwids.filter((c) => c.length > 0))];
  if (unique.length === 0) return out;
  const rows = await client.scholar.findMany({
    where: { cwid: { in: unique } },
    select: {
      cwid: true,
      email: true,
      emailVisibility: true,
      roleCategory: true,
      department: { select: { name: true } },
      division: { select: { name: true } },
    },
  });
  for (const row of rows) {
    out.set(row.cwid, {
      email: row.email,
      emailVisibility: row.emailVisibility,
      roleCategory: row.roleCategory,
      departmentName: row.department?.name ?? null,
      divisionName: row.division?.name ?? null,
    });
  }
  return out;
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
