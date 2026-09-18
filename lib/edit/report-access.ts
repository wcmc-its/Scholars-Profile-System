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
 * `canManageReportAccess` (superuser || comms_steward).
 *
 * Server-only (reads `@/lib/db`); imported by server pages and route handlers,
 * never by a `"use client"` component.
 */
import { db } from "@/lib/db";
import type { EditSession } from "@/lib/auth/superuser";
import { appendAuditRow } from "@/lib/edit/audit";

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

export type ReportAccessRow = {
  reportKey: string;
  scopeKey: string;
  cwid: string;
  grantedBy: string;
  grantedAt: Date;
};

/** Every grant row for `reportKey`, cwid then scope — the "Viewers" panel's
 *  list and the POST route's response body. */
export async function listReportAccess(reportKey: string): Promise<ReportAccessRow[]> {
  return db.read.reportAccess.findMany({
    where: { reportKey },
    orderBy: [{ cwid: "asc" }, { scopeKey: "asc" }],
  });
}

type GrantArgs = {
  reportKey: string;
  scopeKey: string;
  cwid: string;
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

/**
 * Create one `(reportKey, scopeKey, cwid)` grant with its audit row, in one
 * transaction. Idempotent: an existing row is left alone and NOT re-audited
 * (`changed: false`). The caller validates `scopeKey` / `cwid` shape first.
 */
export async function grantReportAccess(args: GrantArgs): Promise<{ changed: boolean }> {
  const { reportKey, scopeKey, cwid, actorCwid } = args;
  const existing = await db.read.reportAccess.findUnique({
    where: { reportKey_scopeKey_cwid: { reportKey, scopeKey, cwid } },
    select: { cwid: true },
  });
  if (existing) return { changed: false };
  await db.write.$transaction(async (tx) => {
    const row = await tx.reportAccess.create({
      data: { reportKey, scopeKey, cwid, grantedBy: actorCwid },
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
        granted_by: row.grantedBy,
        granted_at: row.grantedAt.toISOString(),
      },
      ts: new Date(),
      requestId: args.requestId ?? null,
    });
  });
  return { changed: true };
}

/**
 * Delete one grant with its audit row, in one transaction. Revoking a row that
 * does not exist is an idempotent no-op with no audit row (`changed: false`) —
 * the same posture `/api/edit/proxy`'s revoke takes.
 */
export async function revokeReportAccess(args: GrantArgs): Promise<{ changed: boolean }> {
  const { reportKey, scopeKey, cwid, actorCwid } = args;
  const existing = await db.read.reportAccess.findUnique({
    where: { reportKey_scopeKey_cwid: { reportKey, scopeKey, cwid } },
  });
  if (!existing) return { changed: false };
  await db.write.$transaction(async (tx) => {
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
        granted_by: existing.grantedBy,
        granted_at: existing.grantedAt.toISOString(),
      },
      afterValues: null,
      ts: new Date(),
      requestId: args.requestId ?? null,
    });
  });
  return { changed: true };
}
