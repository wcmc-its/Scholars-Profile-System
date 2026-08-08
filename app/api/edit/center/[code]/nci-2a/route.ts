/**
 * GET /api/edit/center/[code]/nci-2a?cycle=<reportingCycle>
 *
 * NCI CCSG Data Table 2A rows for one center (today, always Meyer Cancer
 * Center — this is data-driven on `CenterProgram` existing, not a hardcoded
 * center check, same posture as the collaboration-network gate) and one
 * import cycle, for the `/edit/center/[code]?attr=nci-2a` review panel
 * (`2026-08-08-cancer-center-nci-table-2a-feature-plan.md`). `[code]` is the
 * raw `Center.code` (e.g. `meyer_cancer_center`), matching
 * `/edit/center/[code]/page.tsx` — NOT the public-facing slug.
 *
 * `cycle` is optional — omitted, it resolves to the most recent cycle this
 * center has any rows for (`reportingCycle` sorts lexicographically by
 * design: `osra-YYYY-MM-DD`, so `desc` is chronological).
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
import { editError, editOk, resolveEditIdentity } from "@/lib/edit/request";

const PATH = "/api/edit/center/[code]/nci-2a";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

  const requestedCycle = request.nextUrl.searchParams.get("cycle");
  // Independent reads — neither depends on the other's result — so they run
  // concurrently (the import script's own analogous three-way read already
  // does this; this route didn't follow its own sibling's pattern).
  const [programs, latestCycle] = await Promise.all([
    db.read.centerProgram.findMany({
      where: { centerCode: center.code },
      orderBy: { sortOrder: "asc" },
      select: { code: true, label: true },
    }),
    requestedCycle
      ? Promise.resolve(null)
      : db.read.cancerCenterFundingAward.findFirst({
          where: { centerCode: center.code },
          orderBy: { reportingCycle: "desc" },
          select: { reportingCycle: true },
        }),
  ]);
  const programLabel = new Map(programs.map((p) => [p.code, p.label]));

  const cycle = requestedCycle ?? latestCycle?.reportingCycle ?? null;
  if (!cycle) return editOk({ cycle: null, programs, awards: [] });

  const awards = await db.read.cancerCenterFundingAward.findMany({
    where: { centerCode: center.code, reportingCycle: cycle },
    orderBy: [{ pi: "asc" }, { projectNumber: "asc" }],
    include: { allocations: { orderBy: { sortOrder: "asc" } } },
  });

  const shaped = awards.map((a) => {
    const pct = a.cancerRelevantPercent != null ? Number(a.cancerRelevantPercent) : null;
    const projectDc = Number(a.annualProjectDirectCosts);
    // Keep the UNROUNDED intermediate for chaining into the per-allocation
    // figure below — rounding this once for display, then rounding AGAIN off
    // the already-rounded value for annualProgramDirectCosts, compounds a
    // cent or two of drift per row that a hand-recomputed total wouldn't
    // reproduce. Round exactly once, at each figure's own final display value.
    const cancerRelevantAnnualProjectDcRaw = pct != null ? projectDc * (pct / 100) : null;
    const cancerRelevantAnnualProjectDc = cancerRelevantAnnualProjectDcRaw != null ? round2(cancerRelevantAnnualProjectDcRaw) : null;
    return {
      id: a.id,
      pi: a.pi,
      specificFundingSource: a.specificFundingSource,
      projectNumber: a.projectNumber,
      projectTitle: a.projectTitle,
      projectStartDate: a.projectStartDate.toISOString().slice(0, 10),
      projectEndDate: a.projectEndDate.toISOString().slice(0, 10),
      annualProjectDirectCosts: projectDc,
      cancerRelevantPercent: pct,
      cancerRelevantPercentSource: a.cancerRelevantPercentSource,
      cancerRelevantRationale: a.cancerRelevantRationale,
      cancerRelevantAnnualProjectDc,
      grantCwid: a.grantCwid,
      allocations: a.allocations.map((al) => {
        const programPercent = Number(al.programPercent);
        const annualProgramDirectCosts =
          cancerRelevantAnnualProjectDcRaw != null ? round2(cancerRelevantAnnualProjectDcRaw * (programPercent / 100)) : null;
        return {
          id: al.id,
          programCode: al.programCode,
          programLabel: al.programCode ? (programLabel.get(al.programCode) ?? al.programCode) : null,
          programPercent,
          source: al.source,
          annualProgramDirectCosts,
        };
      }),
    };
  });

  return editOk({ cycle, programs, awards: shaped });
}
