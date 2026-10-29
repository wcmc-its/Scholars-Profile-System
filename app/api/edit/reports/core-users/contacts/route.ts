/**
 * POST /api/edit/reports/core-users/contacts — report 11's "Email these users":
 * the email addresses of the page's currently filtered people, for an Outlook
 * Bcc. Called only when the button is clicked, so addresses never sit in the
 * page HTML. Nothing is sent from SPS.
 *
 * Body: `{ query }` — the report's own query string (`center=<coreId>&kind=core`
 * plus its filters), parsed by `parseCoreUsersParams` and loaded by
 * `loadCoreUsersReport` exactly as the page does, so the list matches the
 * visible people. Recipients, cap and gate: `lib/edit/core-users-contact.ts`.
 *
 * 400 no core / the all-cores roll-up; 403 not this core's owner, curator,
 * superuser or steward on the person's OWN roles (observers, content editors and
 * a non-superuser "View as" are refused via `readEditRequest`); 409 above
 * `CORE_CONTACT_CAP` recipients (refused whole, never truncated). 200 carries
 * `{ count, emails }` and writes one `core_users_contact_copy` audit row (actor,
 * core, count and the filters — never an address). An empty list is 200 with
 * no audit row: nothing was handed over.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { getCoreOwnerRole, logEditDenial, type CoreOwnerLookup } from "@/lib/edit/authz";
import { isAllCores, loadCoreConfirmedPmids } from "@/lib/edit/core-report-common";
import {
  canContactCoreUsers,
  coreContactAllowed,
  loadCoreContactRecipients,
} from "@/lib/edit/core-users-contact";
import {
  coreUsersQuery,
  loadCoreUsersReport,
  parseCoreUsersParams,
} from "@/lib/edit/core-users-report";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/reports/core-users/contacts";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  if (typeof body.query !== "string" || body.query.length > 4000) {
    return editError(400, "invalid_query", "query");
  }
  const sp = new URLSearchParams(body.query);
  const coreId = sp.get("center");
  if (!coreId || coreId.length > 64) return editError(400, "missing_center", "center");
  if (isAllCores(coreId)) return editError(400, "not_for_all_cores", "center");

  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  if (!canContactCoreUsers(session, coreId, coreRole)) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: coreId,
      path: PATH,
      reason: "not_core_owner",
      targetEntityType: "core",
      targetEntityId: coreId,
    });
    return editError(403, "not_core_owner");
  }
  const core = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
  if (!core) return editError(404, "core_not_found", "center");

  const params = parseCoreUsersParams(sp);
  const result = await loadCoreUsersReport(coreId, await loadCoreConfirmedPmids(coreId), params);
  const emails = await loadCoreContactRecipients(result.people.map((p) => p.cwid));
  if (!coreContactAllowed(emails.length)) return editError(409, "over_core_contact_cap");
  if (emails.length === 0) return editOk({ count: 0, emails: [] });

  await appendAuditRow(db.write, {
    actorCwid: realCwid,
    targetEntityType: "core",
    targetEntityId: coreId,
    action: "core_users_contact_copy",
    fieldsChanged: null,
    beforeValues: null,
    afterValues: {
      recipients: emails.length,
      filters: coreUsersQuery(params, "people").toString(),
    },
    ts: new Date(),
    requestId,
    impersonatedCwid,
  });
  const res = editOk({ count: emails.length, emails });
  res.headers.set("cache-control", "no-store");
  return res;
}
