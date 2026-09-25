/**
 * Center roster export (#1102) — the flag gate, the membership status
 * derivation, and the row projection for the `/edit/center/[code]/export`
 * roster download. The route serializes those rows as an .xlsx workbook via
 * `lib/edit/unit-roster-xlsx.ts` (kept out of this module so exceljs never
 * reaches the client bundle — see the GUARDRAIL below).
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
 * edit rights over); the #847 scope export keeps its own cap AND its own
 * release-code filter. Here the email cell runs `exportEmailCell`: the
 * `SCHOLAR_LIST_EXPORT_EMAIL` operator switch plus the #536 hidden-display-role
 * carve, and deliberately NOT the release code — see that function for why the
 * filter is wrong on a unit-scoped internal export (`none` is inferred from
 * missing data, never set by a person).
 *
 * The faculty columns are loaded by `loadRosterFacultyMeta` from the ROUTE, not
 * folded into `UnitEditContext` — that context is serialized to the client for
 * the Members tab, and email in a browser payload is a wider exposure than the
 * download itself.
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
import type { UnitEditContext } from "@/lib/api/unit-edit-context";
import { institutionDisplayName } from "@/lib/institutions";
import { INVITED_ROLE_KEY } from "@/lib/org-unit-roles";
import { exportEmailCell } from "@/lib/profile/email-visibility-flags";

/**
 * Whether the per-unit roster export is enabled (off by default). When off
 * the route 404s and the Members-tab "Export .xlsx" control is hidden — mirroring
 * `isDataQualityDashboardEnabled` / `isOrgUnitCreateSuperuserOnly`.
 */
export function isUnitRosterExportEnabled(): boolean {
  return process.env.EDIT_UNIT_ROSTER_EXPORT === "on";
}

export type RosterStatus = "active" | "pending" | "inactive" | "invited";

/**
 * The membership status, mirroring `statusOf` in `center-roster-card.tsx`
 * (#552 §3.3 active filter, inclusive boundaries, nulls open). Kept in lock-step
 * with the UI so the export's `status` column matches the table badge exactly.
 * An invitee (#2779 `INVITED_ROLE_KEY`) is `invited` whatever its dates; a
 * division row has no role key, so it never hits that case.
 */
export function rosterStatusOf(
  member: { startDate: string | null; endDate: string | null; membershipRoleKey?: string | null },
  today: string,
): RosterStatus {
  if (member.membershipRoleKey === INVITED_ROLE_KEY) return "invited";
  if (member.startDate && member.startDate > today) return "pending";
  if (member.endDate && member.endDate < today) return "inactive";
  return "active";
}

/** Column order — the export's header row + the per-row projection key order (#1102).
 *  `email`/`role_category`/`department`/`division` are the faculty block; they
 *  come through EMPTY when the caller supplies no `facultyByCwid`, so the header
 *  row is stable either way (a consumer's column indices never shift under them).
 *  `scholar_state` is always populated — it comes off the roster row itself, not
 *  the faculty join, so it is present even with no `facultyByCwid`. `institution`
 *  (faculty block, ED primary organization) was appended LAST, after it, so
 *  existing consumer indices did not shift. */
export const ROSTER_EXPORT_HEADERS = [
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
  "scholar_state",
  "institution",
] as const;

/** Per-scholar faculty metadata joined onto a roster row by cwid. Loaded in the
 *  route via `loadRosterFacultyMeta` — never carried on `UnitEditContext`. */
export type RosterFacultyMeta = {
  email: string | null;
  /** Gates the email cell via the #536 hidden-display-role carve, AND is emitted
   *  as its own `role_category` column. */
  roleCategory: string | null;
  departmentName: string | null;
  divisionName: string | null;
  /** `institutionDisplayName` of the ED primary organization; null when unset. */
  institution: string | null;
};

export type BuildRosterExportOptions = {
  /** Today as `YYYY-MM-DD` (injectable for tests / determinism). */
  today: string;
  /** When true, drop pending + inactive rows (the `?activeOnly=1` mode). */
  activeOnly?: boolean;
  /** cwid → faculty metadata. Omit to emit the four faculty columns empty. */
  facultyByCwid?: ReadonlyMap<string, RosterFacultyMeta>;
};

/** The email cell for one roster row — the shared two-gate rule, identical to the
 *  department/division export's. Absent metadata (an external member with no
 *  Scholar row) yields "". */
function emailCellFor(meta: RosterFacultyMeta | undefined): string {
  return meta ? exportEmailCell(meta) : "";
}

/**
 * Project a center's roster to export rows, in `ROSTER_EXPORT_HEADERS` order
 * (header row NOT included). `program_label` is resolved from the
 * center's program taxonomy (`ctx.programs`); a manual division has no program /
 * type taxonomy, so those columns come through empty. Pending + inactive members
 * are included by default (the dropped/lapsed-member visibility the Members tab
 * also exposes); `activeOnly` honors the dashboard-style narrowing.
 */
export function buildUnitRosterRows(
  ctx: UnitEditContext,
  options: BuildRosterExportOptions,
): string[][] {
  const { today, activeOnly = false, facultyByCwid } = options;
  const roster = ctx.roster ?? [];
  const programLabel = new Map<string, string>(
    (ctx.programs ?? []).map((p) => [p.code, p.label]),
  );

  const body: string[][] = [];
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
      // Whether the PERSON is still at WCM — an axis the `status` column above
      // cannot express, since that one reads membership DATES. A row can be
      // status=active AND scholar_state=departed: someone left and nobody
      // closed out their membership. That pair is the audit this column exists
      // for, and it is why filtering the export on `status` alone misses them.
      m.scholarState,
      meta?.institution ?? "",
    ]);
  }
  return body;
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
        roleCategory: string | null;
        department: { name: string } | null;
        division: { name: string } | null;
        primaryOrgCode: string | null;
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
      roleCategory: true,
      department: { select: { name: true } },
      division: { select: { name: true } },
      primaryOrgCode: true,
    },
  });
  for (const row of rows) {
    out.set(row.cwid, {
      email: row.email,
      roleCategory: row.roleCategory,
      departmentName: row.department?.name ?? null,
      divisionName: row.division?.name ?? null,
      institution: row.primaryOrgCode ? institutionDisplayName(row.primaryOrgCode) : null,
    });
  }
  return out;
}

/** Count of rows the export body will contain under the given options (for logging). */
export function countRosterExportRows(
  ctx: UnitEditContext,
  options: BuildRosterExportOptions,
): number {
  const { today, activeOnly = false } = options;
  const roster = ctx.roster ?? [];
  if (!activeOnly) return roster.length;
  return roster.filter((m) => rosterStatusOf(m, today) === "active").length;
}
