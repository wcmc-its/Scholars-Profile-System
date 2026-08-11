/**
 * GET /api/edit/center/[code]/collab-report
 *
 * Cancer Center collaboration-recommendations v2 Reports tab
 * (`2026-08-10-cancer-center-collaboration-recommendations-v2-cancer-
 * relevance-plan.md`) — read-only, advisory. Returns every precomputed
 * `CenterCollabCandidate` row for this center (written weekly by
 * `etl/cancer-center-collab-report/index.ts`), joined with `Scholar` for
 * display name/department. No threshold filtering here — REMOVE / ADD
 * (collaborator + relevant) / ADD (recruit) is the slider-driven bucketing
 * the client applies against these already-computed numbers, matching the
 * plan's "cheap, no MeSH matching at request time."
 *
 * Authz mirrors `/api/edit/center/[code]/nci-2a`: Curator/Owner of the
 * center, or Superuser/comms_steward (`canEditUnit`) — same posture as every
 * other unit-content edit surface, not a public read.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { splitName } from "@/lib/center-collaboration/recommendations-core";
import { db } from "@/lib/db";
import { canEditUnit, getEffectiveUnitRole, logEditDenial, type UnitAdminLookup } from "@/lib/edit/authz";
import { editError, editOk, resolveEditIdentity } from "@/lib/edit/request";

const PATH = "/api/edit/center/[code]/collab-report";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const identity = await resolveEditIdentity();
  if (!identity) return editError(401, "unauthenticated");
  const { session, realCwid } = identity;

  const { code } = await params;
  const center = await db.read.center.findUnique({ where: { code }, select: { code: true } });
  if (!center) return editError(404, "unit_not_found", "code");

  const effective = await getEffectiveUnitRole(
    session,
    { kind: "center", code: center.code },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canEditUnit(session, effective);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: center.code,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "center",
      targetEntityId: center.code,
    });
    return editError(403, authz.reason);
  }

  const candidates = await db.read.centerCollabCandidate.findMany({
    where: { centerCode: center.code },
    orderBy: [{ collaborationsWithCenter: "desc" }, { cwid: "asc" }],
  });
  if (candidates.length === 0) return editOk({ generatedAt: null, rows: [] });

  const scholars = await db.read.scholar.findMany({
    where: { cwid: { in: candidates.map((c) => c.cwid) } },
    select: { cwid: true, preferredName: true, primaryDepartment: true },
  });
  const scholarByCwid = new Map(scholars.map((s) => [s.cwid, s]));

  const rows = candidates.map((c) => {
    const s = scholarByCwid.get(c.cwid);
    const { given, surname } = splitName(s?.preferredName ?? c.cwid);
    return {
      cwid: c.cwid,
      surname,
      givenName: given,
      primaryDepartment: s?.primaryDepartment ?? "",
      totalPapersPostCutoff: c.totalPapersPostCutoff,
      collaborationsWithCenter: c.collaborationsWithCenter,
      cancerRelatedPapers: c.cancerRelatedPapers,
      isCurrentMember: c.isCurrentMember,
      currentProgramCode: c.currentProgramCode,
    };
  });
  // All rows share one weekly run, so the max lastRefreshedAt is that run's
  // stamp — cheap to derive rather than a second query.
  const generatedAt = new Date(Math.max(...candidates.map((c) => c.lastRefreshedAt.getTime()))).toISOString();

  return editOk({ generatedAt, rows });
}
