/**
 * Cancer Center collaboration-recommendations v2 weekly precompute
 * (`2026-08-10-cancer-center-collaboration-recommendations-v2-cancer-relevance-plan.md`).
 *
 * Computes BOTH axes together, for every full-time faculty member against
 * each center that has a program taxonomy, and writes one row per
 * (centerCode, cwid) to `CenterCollabCandidate`. Only full-time faculty can
 * be a Cancer Center member, so the candidate universe and the member set
 * are drawn from the SAME full-time-faculty query — a `CenterMembership` row
 * for someone who no longer qualifies (role change, suppression, departure)
 * is not trusted on its own. No REMOVE/ADD/recruit classification happens here
 * — the `/edit` Reports tab applies threshold filtering (percentage or
 * raw-count slider) against these stored numbers at request time, so it never
 * needs to re-run MeSH matching.
 *
 * Shares its pure core (`buildPmidIndex`, `buildGroups`, collaboration
 * counting) with the standalone `scripts/cancer-center-collaboration-
 * recommendations.ts` v1 CLI via `lib/center-collaboration/recommendations-
 * core.ts` — same functions, same answer, no drift.
 *
 * Full truncate-and-reload per center (not incremental): the candidate
 * universe and every count can change week to week (new papers, new MeSH
 * assignments, roster changes), and at ~2,400 candidates/center a full
 * recompute is cheap — there is no delta-scan concept for a report this
 * shape, unlike ReporterWeekly/NsfWeekly's genuinely incremental sources.
 *
 * Usage: npm run etl:cancer-center-collab-report
 */
import { isCancerRelated, loadCancerTaxonomy } from "@/lib/cancer-taxonomy";
import { isCenterMembershipActive } from "@/lib/api/centers";
import {
  computeCollabCandidateMetrics,
  DEFAULT_CUTOFF_YEAR,
  type CollabAuthorRow,
  type CollabUniverseMember,
} from "@/lib/center-collaboration/recommendations-core";
import { db, disconnect } from "@/lib/db";
import { withEtlRun } from "@/lib/etl-run";

async function computeForCenter(centerCode: string, cutoffYear: number): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);

  // Only full-time faculty can be Cancer Center members — the full-time-
  // faculty population below IS the whole candidate universe, so build the
  // member set FROM it rather than trusting `CenterMembership` alone. A role
  // change, suppression, or departure after joining must not leave a stale
  // row still counted as a research member.
  const facultyScholars = await db.write.scholar.findMany({
    where: { deletedAt: null, status: "active", roleCategory: "full_time_faculty" },
    select: { cwid: true },
  });
  const fullTimeFacultyCwids = new Set(facultyScholars.map((s) => s.cwid));

  // Active research members — v1's exact REMOVE-eligible population, now
  // additionally validated against the full-time-faculty set above — plus
  // the ANY-type active membership set, used only to exclude already-rostered
  // people from the candidate side (see the schema doc comment on
  // `CenterCollabCandidate`).
  const memberships = await db.write.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true, programCode: true, membershipType: true, startDate: true, endDate: true },
  });
  const active = memberships.filter((m) => isCenterMembershipActive(m.startDate, m.endDate, today));
  const anyActiveMemberCwids = new Set(active.map((m) => m.cwid));
  const researchMembers = active.filter(
    (m) => m.membershipType === "research" && fullTimeFacultyCwids.has(m.cwid),
  );

  // Candidate universe: every full-time faculty member, minus anyone already
  // on this center's roster under some OTHER membership type (not a fresh
  // candidate, out of REMOVE's scope too — see the schema comment).
  const universe: CollabUniverseMember[] = [
    ...researchMembers.map((m) => ({ cwid: m.cwid, isResearchMember: true, programCode: m.programCode })),
    // anyActiveMemberCwids is a superset of researchMemberCwids, so this also
    // correctly excludes research members from being added twice.
    ...facultyScholars
      .filter((s) => !anyActiveMemberCwids.has(s.cwid))
      .map((s) => ({ cwid: s.cwid, isResearchMember: false, programCode: null })),
  ];
  if (universe.length === 0) return 0;

  // One authorship pull for the whole universe — post-cutoff confirmed
  // Academic Article authorship, with each row's own MeSH UIs for the
  // cancer-relevance axis.
  const authorRows = await db.write.publicationAuthor.findMany({
    where: {
      cwid: { in: universe.map((u) => u.cwid) },
      isConfirmed: true,
      publication: { publicationType: "Academic Article", year: { gte: cutoffYear } },
    },
    select: { pmid: true, cwid: true, publication: { select: { meshTerms: true } } },
  });
  const lookup = await loadCancerTaxonomy(db.write.cancerTaxonomyDescriptor, db.write.meshDescriptor);
  const rows: CollabAuthorRow[] = authorRows
    .filter((r): r is typeof r & { cwid: string } => r.cwid !== null)
    .map((r) => {
      const mt = r.publication.meshTerms;
      const meshUis = Array.isArray(mt)
        ? mt.flatMap((x) => (x && typeof x === "object" && "ui" in x && typeof x.ui === "string" ? [x.ui] : []))
        : [];
      return { pmid: r.pmid, cwid: r.cwid, meshUis };
    });

  const metrics = computeCollabCandidateMetrics(universe, rows, (uis) => isCancerRelated(uis, lookup));

  await db.write.$transaction([
    db.write.centerCollabCandidate.deleteMany({ where: { centerCode } }),
    db.write.centerCollabCandidate.createMany({
      data: metrics.map((m) => ({
        centerCode,
        cwid: m.cwid,
        totalPapersPostCutoff: m.totalPapersPostCutoff,
        collaborationsWithCenter: m.collaborationsWithCenter,
        cancerRelatedPapers: m.cancerRelatedPapers,
        isCurrentMember: m.isCurrentMember,
        currentProgramCode: m.currentProgramCode,
      })),
    }),
  ]);
  return metrics.length;
}

async function main(): Promise<number> {
  // Data-driven, like the Programs/NCI-2a tabs — no hardcoded center check.
  const centers = await db.write.center.findMany({ where: { programs: { some: {} } }, select: { code: true } });
  let total = 0;
  for (const c of centers) total += await computeForCenter(c.code, DEFAULT_CUTOFF_YEAR);
  console.log(JSON.stringify({ event: "cancer_center_collab_report", centers: centers.length, rows: total, ts: new Date().toISOString() }));
  return total;
}

withEtlRun("CancerCenterCollabReport", main)
  .catch((err) => {
    console.error("[CancerCenterCollabReport] failed:", err);
    process.exit(1);
  })
  .finally(() => disconnect());
