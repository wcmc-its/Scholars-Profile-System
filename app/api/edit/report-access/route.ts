/**
 * POST /api/edit/report-access — grant / revoke a per-report access row
 * (`report_access`, `lib/edit/report-access.ts`) from the "Who can run this
 * report" popover (`components/edit/report-access-popover.tsx`) on
 * `/edit/reports/7`.
 *
 * Body: `{ op: "grant" | "revoke", reportKey, scopeKey, cwid, name? }`.
 *   - `reportKey` a key of `REPORT_ACCESS_SCOPE_OPTIONS` (reports 7, 8, 9);
 *   - `scopeKey` one of that report's options (`"*"` alone for 8 and 9);
 *   - `cwid` lowercased, then `/^[a-z][a-z0-9]{1,11}$/`;
 *   - `name` (grant only, optional): the grantee's directory display name as
 *     the people picker returned it, stored on the row as `grantee_name` so
 *     the popover can show a name for a grantee with no Scholar row (the
 *     runtime cannot reach LDAP). Trimmed and kept when 1–255 chars; anything
 *     else — absent, not a string, empty, over-long — is stored as null, never
 *     a 400: the name is a display convenience, not part of the grant. A
 *     revoke ignores it.
 *
 * Gate order (mirrors `/api/edit/roles`): shared preamble (`readEditRequest`
 * — origin / content-type / session / body) → not superuser or comms_steward
 * ⇒ 403 `not_comms_steward` BEFORE any field of the body is read → field
 * validation ⇒ 400 → the write, one transaction with its
 * `report_access_grant` / `report_access_revoke` audit row (`actorCwid` is
 * always `realCwid`, never the "View as" target). Responds with the updated
 * list for the report (each row with its resolved display `name` and stored
 * `granteeName`) so the popover re-renders from the server's truth — the
 * list the write itself returned, read inside its transaction on the WRITER.
 * It is never re-fetched here through `listReportAccess`'s reader default:
 * `db.read` is the Aurora reader replica in prod, and a post-write read there
 * can miss the row just written (the `core-client` route's rule, PR #2620).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { logEditDenial } from "@/lib/edit/authz";
import { fillDirectoryNames } from "@/lib/edit/directory-names";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import {
  canManageReportAccess,
  grantReportAccess,
  REPORT_ACCESS_SCOPE_OPTIONS,
  revokeReportAccess,
  type ReportAccessWriteResult,
} from "@/lib/edit/report-access";

const PATH = "/api/edit/report-access";

/** The grantee shape this route accepts — lowercased first. Stricter than the
 *  house `CWID_PATTERN` on length by design (2–12 chars covers every real
 *  staff CWID this panel is for). */
const GRANTEE_PATTERN = /^[a-z][a-z0-9]{1,11}$/;

/** `report_access.grantee_name` is VARCHAR(255). */
const GRANTEE_NAME_MAX = 255;

/** The optional `name` a grant carries, normalized for storage: a string is
 *  trimmed and kept when 1–`GRANTEE_NAME_MAX` chars; anything else is null.
 *  Never rejects — see the header. */
function granteeNameFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= GRANTEE_NAME_MAX ? trimmed : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (!canManageReportAccess(session)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: "not_comms_steward",
    });
    return editError(403, "not_comms_steward");
  }

  const { op, reportKey, scopeKey } = body;
  if (op !== "grant" && op !== "revoke") {
    return editError(400, "invalid_op", "op");
  }
  if (typeof reportKey !== "string" || !Object.hasOwn(REPORT_ACCESS_SCOPE_OPTIONS, reportKey)) {
    return editError(400, "invalid_report_key", "reportKey");
  }
  if (typeof scopeKey !== "string" || !REPORT_ACCESS_SCOPE_OPTIONS[reportKey].some(([k]) => k === scopeKey)) {
    return editError(400, "invalid_scope_key", "scopeKey");
  }
  const cwid = typeof body.cwid === "string" ? body.cwid.trim().toLowerCase() : "";
  if (!GRANTEE_PATTERN.test(cwid)) {
    return editError(400, "invalid_cwid", "cwid");
  }

  const args = { reportKey, scopeKey, cwid, actorCwid: realCwid, impersonatedCwid, requestId };
  let result: ReportAccessWriteResult;
  try {
    result =
      op === "grant"
        ? await grantReportAccess({ ...args, granteeName: granteeNameFrom(body.name) })
        : await revokeReportAccess(args);
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // ED names for grantees with no Scholar row and no stored name, after the
  // write committed (fail-soft: the CWID shows on any directory error).
  const rows = await fillDirectoryNames(
    result.rows,
    (r) => r.name,
    (r, name) => ({ ...r, name }),
  );
  return editOk({
    op,
    changed: result.changed,
    rows: rows.map((r) => ({ ...r, grantedAt: r.grantedAt.toISOString() })),
  });
}
