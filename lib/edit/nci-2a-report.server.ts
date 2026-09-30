/**
 * Report 2 — NCI Table 2a loader: one center's rows for one OSRA import cycle,
 * shaped as `Nci2aData` (`lib/edit/nci-2a-report.ts`). Shared by the report
 * body (`components/edit/reports/nci-table-2a-body.tsx`) and
 * `GET /api/edit/center/[code]/nci-2a`; the caller has already passed the
 * `canEditUnit` gate. Server-only (reads `@/lib/db`).
 *
 * `cycle` omitted → the most recent cycle this center has rows for
 * (`reportingCycle` is `osra-YYYY-MM-DD`, so `desc` is chronological).
 *
 * Two joins happen at READ time, not import time, so a later ETL run shows up
 * without a re-import:
 *   - `applId` (the RePORTER link) from `Grant.awardNumber`. A normalized
 *     award number that matches more than one DISTINCT applId is ambiguous
 *     and left null — a wrong applId is a live link to the wrong project.
 *   - Program: the PI's CURRENT `CenterMembership.programCode` (via
 *     `grantCwid`), one allocation at 100%. With no membership program the
 *     stored allocation rows stand (`programFrom: "stored"`). The report
 *     doesn't edit programs any more; the roster does.
 *
 * Derived dollars are computed once here. The unrounded relevant DC feeds the
 * per-program figure, so each value is rounded exactly once.
 */
import { normalizeAwardNumber } from "@/lib/award-number";
import { db } from "@/lib/db";
import type { Nci2aAllocation, Nci2aAward, Nci2aData } from "@/lib/edit/nci-2a-report";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function loadNci2aReport(
  centerCode: string,
  requestedCycle?: string | null,
): Promise<Nci2aData> {
  const [programs, latestCycle, grants] = await Promise.all([
    db.read.centerProgram.findMany({
      where: { centerCode },
      orderBy: { sortOrder: "asc" },
      select: { code: true, label: true },
    }),
    requestedCycle
      ? Promise.resolve(null)
      : db.read.cancerCenterFundingAward.findFirst({
          where: { centerCode },
          orderBy: { reportingCycle: "desc" },
          select: { reportingCycle: true },
        }),
    db.read.grant.findMany({
      where: { awardNumber: { not: null } },
      select: { awardNumber: true, applId: true },
    }),
  ]);
  const programLabel = new Map(programs.map((p) => [p.code, p.label]));

  const applIdsSeen = new Map<string, Set<number>>();
  for (const g of grants) {
    if (!g.awardNumber || g.applId == null) continue;
    const key = normalizeAwardNumber(g.awardNumber);
    if (!applIdsSeen.has(key)) applIdsSeen.set(key, new Set());
    applIdsSeen.get(key)!.add(g.applId);
  }
  const applIdByAwardNumber = new Map<string, number>();
  for (const [key, ids] of applIdsSeen)
    if (ids.size === 1) applIdByAwardNumber.set(key, [...ids][0]);

  const cycle = requestedCycle || latestCycle?.reportingCycle || null;
  if (!cycle) return { cycle: null, programs, awards: [] };

  const awards = await db.read.cancerCenterFundingAward.findMany({
    where: { centerCode, reportingCycle: cycle },
    orderBy: [{ pi: "asc" }, { projectNumber: "asc" }],
    include: { allocations: { orderBy: { sortOrder: "asc" } } },
  });

  const cwids = [...new Set(awards.map((a) => a.grantCwid).filter((c): c is string => !!c))];
  const memberships = cwids.length
    ? await db.read.centerMembership.findMany({
        where: { centerCode, cwid: { in: cwids }, programCode: { not: null } },
        select: { cwid: true, programCode: true },
      })
    : [];
  const liveProgram = new Map(
    memberships.filter((m) => m.programCode).map((m) => [m.cwid, m.programCode as string]),
  );

  const shaped = awards.map((a): Nci2aAward => {
    const pct = a.cancerRelevantPercent != null ? Number(a.cancerRelevantPercent) : null;
    const projectDc = Number(a.annualProjectDirectCosts);
    const relevantRaw = pct != null ? projectDc * (pct / 100) : null;
    const programDc = (programPercent: number) =>
      relevantRaw != null ? round2(relevantRaw * (programPercent / 100)) : null;
    const live = a.grantCwid ? liveProgram.get(a.grantCwid) : undefined;
    const allocations: Nci2aAllocation[] = live
      ? [
          {
            id: `membership-${a.id}`,
            programCode: live,
            programLabel: programLabel.get(live) ?? live,
            programPercent: 100,
            source: "membership",
            annualProgramDirectCosts: programDc(100),
          },
        ]
      : a.allocations.map((al) => {
          const programPercent = Number(al.programPercent);
          return {
            id: al.id,
            programCode: al.programCode,
            programLabel: al.programCode
              ? (programLabel.get(al.programCode) ?? al.programCode)
              : null,
            programPercent,
            source: al.source as Nci2aAllocation["source"],
            annualProgramDirectCosts: programDc(programPercent),
          };
        });
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
      cancerRelevantPercentSource: a.cancerRelevantPercentSource === "human" ? "human" : "llm",
      cancerRelevantPercentAi:
        a.cancerRelevantPercentAi != null ? Number(a.cancerRelevantPercentAi) : null,
      cancerRelevantRationale: a.cancerRelevantRationale,
      cancerRelevantAnnualProjectDc: relevantRaw != null ? round2(relevantRaw) : null,
      isPeerReviewed: a.isPeerReviewed,
      grantCwid: a.grantCwid,
      applId: applIdByAwardNumber.get(normalizeAwardNumber(a.projectNumber)) ?? null,
      programFrom: live ? "membership" : "stored",
      allocations,
    };
  });

  return { cycle, programs, awards: shaped };
}
