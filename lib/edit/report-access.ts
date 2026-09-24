/**
 * Data-driven per-report access grants (`report_access`) — the gate for the
 * Mentored publications report (`/edit/reports/7`).
 *
 * Reports 1–6 are UNIT-scoped: their gate is a unit Owner/Curator grant
 * (`loadReportsContext`, `lib/edit/cancer-center-reports.ts`). This report is
 * program-scoped (MD / MD-PhD / ECR learners, from `aoc_mentee`) and its
 * audience is a couple of named Medical Education staff who administer no org
 * unit and hold no ED-group role. Rather than mint an org unit or an LDAP
 * group for two people, access is a ROW: `(reportKey, scopeKey, cwid)`.
 *
 * Verdict shape (mirrors `canViewDataSharingDashboard`'s "superuser ||
 * comms_steward || the surface's own role" OR, with the role read from a
 * table instead of the directory):
 *   - superuser / comms_steward → every scope (`"*"`), no table read;
 *   - anyone else → the union of their rows' `scopeKey`s for the report;
 *   - no rows → the EMPTY set, and the page/route treat empty as forbidden.
 * Fail closed: there is NO env flag — an empty table is the dark state.
 *
 * Grants are written only through `grantReportAccess` / `revokeReportAccess`
 * (each inside one transaction with a B03 audit row), from
 * `app/api/edit/report-access/route.ts`, which is itself gated by
 * `canManageReportAccess` (superuser || comms_steward). A grant also stores
 * the grantee's directory name (`grantee_name`) as the people picker
 * returned it, because the runtime cannot reach LDAP and these grantees hold
 * no Scholar row; `listReportAccess` resolves each row's display `name` as
 * `Scholar.preferredName ?? granteeName ?? cwid` (the administrators-roster
 * chain).
 *
 * Reader vs writer (the `app/api/edit/core-client/route.ts` rule, PR #2620):
 * `db.read` is the Aurora READER replica in prod (staging has none, so staging
 * can never surface the race). A read that decides what a write does — the
 * existence probe before a grant / revoke — or that reports what a write just
 * did — the row list the panel re-renders from — must NOT go through it: a
 * lagged replica reads a just-granted row as absent (a second grant would then
 * throw P2002 on a row that exists; an immediate revoke would no-op) and a
 * just-revoked row as still present. So both writes probe existence on
 * `db.write`, re-read the report's full list INSIDE their own transaction, and
 * hand that list back; the route returns it verbatim instead of taking a
 * separate reader read. Only the gate (`loadReportScopesForCwid`, consulted on
 * the GRANTEE's next page load) and the page's server render stay on the
 * reader.
 *
 * Server-only (reads `@/lib/db`); imported by server pages and route handlers,
 * never by a `"use client"` component.
 */
import { db } from "@/lib/db";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { EditSession } from "@/lib/auth/superuser";
import { appendAuditRow } from "@/lib/edit/audit";
import { PROGRAM_LABEL } from "@/lib/edit/mentorship-type";

/** The one report this table gates today. `reportKey` is a column, not an
 *  enum, so a second program report is one more constant, not a migration. */
export const MENTORED_PUBS_REPORT = "mentored-publications";

/** The program buckets an `aoc_mentee` row can carry, via
 *  `bucketProgramType` (`lib/api/mentoring-pmids.ts`): AOC / AOC-* → `md`,
 *  MDPHD / MD-PhD → `mdphd`, ECR → `ecr`. (`phd` / `postdoc` are Jenzabar /
 *  ED sources that never appear in `aoc_mentee`.) A grant's `scopeKey` is one
 *  of these or the wildcard `"*"`. */
export const MENTORED_PUBS_SCOPES = ["md", "mdphd", "ecr"] as const;
export type MentoredPubsScope = (typeof MENTORED_PUBS_SCOPES)[number];

/** The wildcard scope — "every bucket". */
export const ALL_SCOPES = "*";

/** The `[scopeKey, label]` pairs the "Who can run this report" popover's
 *  add form offers for the Mentored publications report — the wildcard
 *  first, then every grantable bucket under its office-facing name
 *  (`PROGRAM_LABEL`: `md` reads "MD"). ONE definition, handed to the popover
 *  by `/edit/reports/7` AND by the index's program row
 *  (`app/edit/reports/page.tsx`), so the two cannot drift. Plain tuples —
 *  serializable across the server/client boundary as-is. */
export const MENTORED_PUBS_SCOPE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  [ALL_SCOPES, "All programs"],
  ...MENTORED_PUBS_SCOPES.map((s) => [s, PROGRAM_LABEL[s] ?? s] as const),
];

/** Report 8 (Article counts) and report 9 (Top clinical and high-impact journal publications) take
 *  person grants too, for staff who administer no unit. Neither has scopes:
 *  a grant is the wildcard alone. */
export const ARTICLE_COUNT_REPORT = "article-count";
export const HIGH_IMPACT_PUBS_REPORT = "high-impact-publications";
export const WHOLE_REPORT_SCOPE_OPTIONS: ReadonlyArray<readonly [string, string]> = [[ALL_SCOPES, "Whole report"]];

/** Every grantable `reportKey` → the `[scopeKey, label]` pairs it accepts.
 *  The route validates against this; a new person-granted report is one entry. */
export const REPORT_ACCESS_SCOPE_OPTIONS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  [MENTORED_PUBS_REPORT]: MENTORED_PUBS_SCOPE_OPTIONS,
  [ARTICLE_COUNT_REPORT]: WHOLE_REPORT_SCOPE_OPTIONS,
  [HIGH_IMPACT_PUBS_REPORT]: WHOLE_REPORT_SCOPE_OPTIONS,
};

/** Whether `cwid` holds a grant on ANY report — the `/edit` landing and the
 *  console's Reports tab use it to give a grant-only holder a way in. */
export async function hasAnyReportAccess(cwid: string): Promise<boolean> {
  if (!cwid) return false;
  const rows = await db.read.reportAccess.findMany({ where: { cwid }, select: { cwid: true }, take: 1 });
  return rows.length > 0;
}

/** Whether `value` is a grantable scope key for the Mentored publications
 *  report: one of `MENTORED_PUBS_SCOPES` or `"*"`. */
export function isMentoredPubsScopeKey(value: unknown): value is MentoredPubsScope | typeof ALL_SCOPES {
  return (
    typeof value === "string" &&
    (value === ALL_SCOPES || (MENTORED_PUBS_SCOPES as readonly string[]).includes(value))
  );
}

/** The `EditSession` fields the verdicts read — a structural subset so a test
 *  (or `/edit`'s profile-less fallthrough) can pass a plain object. */
type ReportSession = Pick<EditSession, "cwid" | "isSuperuser" | "isCommsSteward">;

/** Superuser / comms_steward may manage grants (and always pass the view
 *  gate). Same OR `authorizeCommsStewardAction` (`lib/edit/authz.ts`) uses. */
export function canManageReportAccess(session: Pick<EditSession, "isSuperuser" | "isCommsSteward">): boolean {
  return session.isSuperuser || session.isCommsSteward;
}

/** The scope keys `cwid` holds rows for on `reportKey` — the table read
 *  behind `getReportScopes`, exposed on its own for `/edit`'s profile-less
 *  fallthrough (which has a bare cwid, not an `EditSession`). Empty when the
 *  cwid holds no row. */
export async function loadReportScopesForCwid(
  cwid: string,
  reportKey: string,
): Promise<ReadonlySet<string>> {
  if (!cwid) return new Set();
  const rows = await db.read.reportAccess.findMany({
    where: { reportKey, cwid },
    select: { scopeKey: true },
  });
  return new Set(rows.map((r) => r.scopeKey));
}

/**
 * The scope set this session may see on `reportKey`. `Set(["*"])` for a
 * superuser / comms_steward (no table read); otherwise the session's own rows'
 * scope keys; the EMPTY set when there are none — callers treat empty as
 * "forbidden" (the page 404s like `/edit/data-sharing` does for a non-viewer,
 * the download route 403s).
 */
export async function getReportScopes(
  session: ReportSession,
  reportKey: string,
): Promise<ReadonlySet<string>> {
  if (canManageReportAccess(session)) return new Set([ALL_SCOPES]);
  return loadReportScopesForCwid(session.cwid, reportKey);
}

/** Whether a scope set admits `bucket` — a wildcard grant admits everything. */
export function scopeAdmits(scopes: ReadonlySet<string>, bucket: string): boolean {
  return scopes.has(ALL_SCOPES) || scopes.has(bucket);
}

/** One grant row as the popover renders it: the table's columns plus the
 *  resolved display `name`. */
export type ReportAccessRow = {
  reportKey: string;
  scopeKey: string;
  cwid: string;
  grantedBy: string;
  grantedAt: Date;
  /** The directory name the people picker returned when the grant was made
   *  (`report_access.grantee_name`); null on rows granted before the column
   *  existed. Stored because the app runtime cannot reach LDAP (#443) and the
   *  grantees this table is for hold no Scholar row — the
   *  `UnitAdmin.granteeName` precedent. */
  granteeName: string | null;
  /** Display name: `Scholar.preferredName ?? granteeName ?? cwid` — the same
   *  chain `lib/api/administrators-roster.ts` uses, so a Scholar's curated
   *  name wins, a staff grantee shows the name captured at grant time, and a
   *  pre-column row shows the CWID until it is re-granted. */
  name: string;
};

/** What a list read goes through: the reader for a page render, the writer or
 *  an open write transaction for anything that must see a row this request
 *  just wrote (the tx client is structurally a `Pick` of the full client).
 *  `scholar` is for the one name-resolution read `listReportAccess` makes. */
type ReportAccessReader = Pick<PrismaClient, "reportAccess" | "scholar">;

/** Every grant row for `reportKey`, cwid then scope, each with its display
 *  `name` resolved — the "Who can run this report" popover's initial list on
 *  the page's server render. Defaults to the READER; the write paths below
 *  pass their own transaction so the list they return cannot lag the row
 *  they just wrote. Name resolution is ONE `scholar.findMany` over the rows'
 *  cwids (skipped entirely when there are no rows), on the same client. */
export async function listReportAccess(
  reportKey: string,
  client: ReportAccessReader = db.read,
): Promise<ReportAccessRow[]> {
  const rows = await client.reportAccess.findMany({
    where: { reportKey },
    orderBy: [{ cwid: "asc" }, { scopeKey: "asc" }],
  });
  if (rows.length === 0) return [];
  const cwids = [...new Set(rows.map((r) => r.cwid))];
  const scholars = await client.scholar.findMany({
    where: { cwid: { in: cwids } },
    select: { cwid: true, preferredName: true },
  });
  const preferredName = new Map(scholars.map((s) => [s.cwid, s.preferredName]));
  return rows.map((r) => ({
    ...r,
    name: preferredName.get(r.cwid) ?? r.granteeName ?? r.cwid,
  }));
}

/** A grant / revoke's outcome: whether a row changed, and the report's full
 *  list as it stands AFTER the write, read from the writer (inside the write's
 *  own transaction when one ran). The route returns `rows` verbatim; it must
 *  not take a second, reader-side list — see the module comment. */
export type ReportAccessWriteResult = {
  changed: boolean;
  rows: ReportAccessRow[];
};

type GrantArgs = {
  reportKey: string;
  scopeKey: string;
  cwid: string;
  /** The grantee's directory display name as the people picker returned it,
   *  stored on the row (`grantee_name`) at grant time — see `ReportAccessRow`.
   *  Null / omitted when the caller has none (a revoke never carries one). */
  granteeName?: string | null;
  /** The REAL signed-in human (audit `actor_cwid` and `granted_by`) — never
   *  an impersonation target. */
  actorCwid: string;
  /** The "View as" target when the actor was impersonating (audit
   *  `impersonated_cwid`), else null. */
  impersonatedCwid?: string | null;
  requestId?: string | null;
};

function targetId({ reportKey, scopeKey, cwid }: Pick<GrantArgs, "reportKey" | "scopeKey" | "cwid">): string {
  return `${reportKey}:${scopeKey}:${cwid}`;
}

/** Prisma unique-constraint violation (`(reportKey, scopeKey, cwid)` is the
 *  PK) — the same shape check `app/api/edit/roles/route.ts` uses. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/**
 * Create one `(reportKey, scopeKey, cwid)` grant with its audit row, in one
 * transaction. Idempotent: an existing row is left alone and NOT re-audited
 * (`changed: false`). The caller validates `scopeKey` / `cwid` shape first.
 *
 * The existence probe runs on the WRITER (never the reader — see the module
 * comment), and a P2002 from the create is the one race that probe cannot
 * close (two grants of the same triple in flight at once): it means the row
 * exists, so it is reported as the same idempotent no-op, not a failure.
 */
export async function grantReportAccess(args: GrantArgs): Promise<ReportAccessWriteResult> {
  const { reportKey, scopeKey, cwid, actorCwid } = args;
  const existing = await db.write.reportAccess.findUnique({
    where: { reportKey_scopeKey_cwid: { reportKey, scopeKey, cwid } },
    select: { cwid: true },
  });
  if (existing) return { changed: false, rows: await listReportAccess(reportKey, db.write) };
  try {
    const rows = await db.write.$transaction(async (tx) => {
      const row = await tx.reportAccess.create({
        data: {
          reportKey,
          scopeKey,
          cwid,
          grantedBy: actorCwid,
          granteeName: args.granteeName ?? null,
        },
      });
      await appendAuditRow(tx, {
        actorCwid,
        impersonatedCwid: args.impersonatedCwid ?? null,
        targetEntityType: "report_access",
        targetEntityId: targetId(args),
        action: "report_access_grant",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: {
          report_key: reportKey,
          scope_key: scopeKey,
          cwid,
          grantee_name: row.granteeName,
          granted_by: row.grantedBy,
          granted_at: row.grantedAt.toISOString(),
        },
        ts: new Date(),
        requestId: args.requestId ?? null,
      });
      // Re-read from the SAME transaction: this is the list the panel renders
      // as truth, so it must include the row two statements up.
      return listReportAccess(reportKey, tx);
    });
    return { changed: true, rows };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a concurrent-grant race: the row is there (the other request wrote
    // and audited it), so this is the idempotent path, not a 500.
    return { changed: false, rows: await listReportAccess(reportKey, db.write) };
  }
}

/**
 * Delete one grant with its audit row, in one transaction. Revoking a row that
 * does not exist is an idempotent no-op with no audit row (`changed: false`) —
 * the same posture `/api/edit/proxy`'s revoke takes. The existence probe runs
 * on the WRITER so a row granted a moment ago is never read as "not there".
 */
export async function revokeReportAccess(args: GrantArgs): Promise<ReportAccessWriteResult> {
  const { reportKey, scopeKey, cwid, actorCwid } = args;
  const existing = await db.write.reportAccess.findUnique({
    where: { reportKey_scopeKey_cwid: { reportKey, scopeKey, cwid } },
  });
  if (!existing) return { changed: false, rows: await listReportAccess(reportKey, db.write) };
  const rows = await db.write.$transaction(async (tx) => {
    await tx.reportAccess.delete({
      where: { reportKey_scopeKey_cwid: { reportKey, scopeKey, cwid } },
    });
    await appendAuditRow(tx, {
      actorCwid,
      impersonatedCwid: args.impersonatedCwid ?? null,
      targetEntityType: "report_access",
      targetEntityId: targetId(args),
      action: "report_access_revoke",
      fieldsChanged: null,
      beforeValues: {
        report_key: reportKey,
        scope_key: scopeKey,
        cwid,
        grantee_name: existing.granteeName,
        granted_by: existing.grantedBy,
        granted_at: existing.grantedAt.toISOString(),
      },
      afterValues: null,
      ts: new Date(),
      requestId: args.requestId ?? null,
    });
    // Same-transaction re-read — the deleted row must already be gone from it.
    return listReportAccess(reportKey, tx);
  });
  return { changed: true, rows };
}

/** Staff with no unit can always run report 8 via a grant; unit
 *  administrators can without one. The popover says so. */
export const ARTICLE_COUNT_ACCESS_NOTE =
  "Every unit administrator (an Owner or Curator of any unit), superuser and comms steward can always run this report.";

