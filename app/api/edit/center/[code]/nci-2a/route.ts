/**
 * GET /api/edit/center/[code]/nci-2a?cycle=<reportingCycle>
 *
 * NCI CCSG Data Table 2A rows for one center (today, always Meyer Cancer
 * Center — this is data-driven on `CenterProgram` existing, not a hardcoded
 * center check, same posture as the collaboration-network gate) and one
 * import cycle, for the `/edit/reports/2` review panel
 * (`2026-08-08-cancer-center-nci-table-2a-feature-plan.md`). `[code]` is the
 * raw `Center.code` (e.g. `meyer_cancer_center`), matching
 * `/edit/center/[code]/page.tsx` — NOT the public-facing slug.
 *
 * `cycle` is optional — omitted, it resolves to the most recent cycle this
 * center has any rows for (`reportingCycle` sorts lexicographically by
 * design: `osra-YYYY-MM-DD`, so `desc` is chronological).
 *
 * The rows come from `loadNci2aReport` (`lib/edit/nci-2a-report.server.ts`),
 * the same loader the report body uses: applId and the program (the PI's
 * current center membership, else the stored allocation) resolve at read time.
 *
 * Returns nested JSON (award + its allocations), NOT the flat multi-row-per-
 * program table shape from the NCI worksheet — that's a presentation concern
 * the UI panel and the CSV export both derive from this same shape, so it
 * isn't duplicated into the API contract. Derived $ columns
 * (`cancerRelevantAnnualProjectDc`, `annualProgramDirectCosts`) ARE computed
 * here, once, so neither consumer re-implements the multiply-by-percent math.
 *
 * Authz mirrors `/api/edit/center-program`: Curator/Owner of the center, or
 * Superuser/comms_steward (`canEditUnit`) — this is real dollar-figure award
 * data, gated like every other unit-content edit surface, not a public read.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { canEditUnit, getEffectiveUnitRole, logEditDenial, type UnitAdminLookup } from "@/lib/edit/authz";
import { loadNci2aReport } from "@/lib/edit/nci-2a-report.server";
import { editError, editOk, resolveEditIdentity } from "@/lib/edit/request";

const PATH = "/api/edit/center/[code]/nci-2a";

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

  return editOk(await loadNci2aReport(center.code, request.nextUrl.searchParams.get("cycle")));
}
