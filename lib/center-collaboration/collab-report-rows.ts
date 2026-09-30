/**
 * Report 1's one query: every precomputed `CenterCollabCandidate` row for a
 * center (weekly ETL, `etl/cancer-center-collab-report`), joined to `Scholar`
 * for name, department and institution and to `CenterProgram` for the
 * program name. Shared by the page body and both `.xlsx` routes, so the
 * download can never list a different population than the screen.
 *
 * Server-only (takes a Prisma client). Thresholding is NOT done here; that is
 * `bucketLists` in `lib/edit/optimize-membership-report.ts`.
 */
import { splitName } from "@/lib/center-collaboration/recommendations-core";
import type { CollabRow } from "@/lib/edit/optimize-membership-report";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { institutionDisplayName } from "@/lib/institutions";

export type CollabReportClient = Pick<
  PrismaClient,
  "centerCollabCandidate" | "scholar" | "centerProgram"
>;

export type CollabReportData = {
  rows: CollabRow[];
  /** ISO stamp of the weekly run (max `lastRefreshedAt`); null when no rows. */
  lastRefreshedAt: string | null;
};

export async function loadCollabReportRows(
  db: CollabReportClient,
  centerCode: string,
): Promise<CollabReportData> {
  const candidates = await db.centerCollabCandidate.findMany({
    where: { centerCode },
    orderBy: [{ collaborationsWithCenter: "desc" }, { cwid: "asc" }],
  });
  if (candidates.length === 0) return { rows: [], lastRefreshedAt: null };

  const [scholars, programs] = await Promise.all([
    db.scholar.findMany({
      where: { cwid: { in: candidates.map((c) => c.cwid) } },
      select: { cwid: true, preferredName: true, primaryDepartment: true, primaryOrgCode: true },
    }),
    db.centerProgram.findMany({ where: { centerCode }, select: { code: true, label: true } }),
  ]);
  const scholarByCwid = new Map(scholars.map((s) => [s.cwid, s]));
  const programLabel = new Map(programs.map((p) => [p.code, p.label]));

  const rows = candidates.map((c): CollabRow => {
    const s = scholarByCwid.get(c.cwid);
    const { given, surname } = splitName(s?.preferredName ?? c.cwid);
    return {
      cwid: c.cwid,
      surname,
      givenName: given,
      primaryDepartment: s?.primaryDepartment ?? "",
      institution: s?.primaryOrgCode ? institutionDisplayName(s.primaryOrgCode) : "",
      totalPapersPostCutoff: c.totalPapersPostCutoff,
      collaborationsWithCenter: c.collaborationsWithCenter,
      cancerRelatedPapers: c.cancerRelatedPapers,
      isCurrentMember: c.isCurrentMember,
      currentProgramCode: c.currentProgramCode,
      programLabel: c.currentProgramCode ? (programLabel.get(c.currentProgramCode) ?? null) : null,
    };
  });
  // All rows share one weekly run, so the max is that run's stamp.
  const lastRefreshedAt = new Date(
    Math.max(...candidates.map((c) => c.lastRefreshedAt.getTime())),
  ).toISOString();
  return { rows, lastRefreshedAt };
}
