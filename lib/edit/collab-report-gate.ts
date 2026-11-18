/**
 * The gate every report 1 (`Optimize membership`) route shares:
 * `/api/edit/center/[code]/collab-report/{export,xlsx,selected}`. The
 * caller must be signed in (401), the center must exist (404), and
 * `canEditUnit` must pass: superuser, comms_steward, or the center's
 * Owner/Curator (403, denial logged) — or, with `LEADER_REPORT_ACCESS` on,
 * one of the center's leaders, who can view these reports
 * (`authorizeUnitReportView`). One copy, so the three downloads can't
 * drift apart on who may pull a scholar list. Report 19's matrix download
 * (`collab-pub-matrix/xlsx`) uses it too.
 *
 * Server-only (`@/lib/db`).
 */
import type { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeUnitReportView } from "@/lib/edit/unit-leader-access";
import { editError, resolveEditIdentity } from "@/lib/edit/request";

export type CollabReportGate =
  | { ok: true; center: { code: string; name: string } }
  | { ok: false; response: NextResponse };

export async function gateCollabReportRoute(code: string, path: string): Promise<CollabReportGate> {
  const identity = await resolveEditIdentity();
  if (!identity) return { ok: false, response: editError(401, "unauthenticated") };
  const { session, realCwid } = identity;

  const center = await db.read.center.findUnique({
    where: { code },
    select: { code: true, name: true },
  });
  if (!center) return { ok: false, response: editError(404, "unit_not_found", "code") };

  // Report data: the unit's editors, or (LEADER_REPORT_ACCESS) its leaders.
  const authz = await authorizeUnitReportView(session, { kind: "center", code: center.code }, db.read);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: center.code,
      path,
      reason: authz.reason,
      targetEntityType: "center",
      targetEntityId: center.code,
    });
    return { ok: false, response: editError(403, authz.reason) };
  }
  return { ok: true, center };
}
