/**
 * Cancer Center collaboration-recommendations v2 weekly precompute
 * (`2026-08-10-cancer-center-collaboration-recommendations-v2-cancer-relevance-plan.md`).
 *
 * Computes BOTH axes together, for every full-time faculty member (plus every
 * active research member — see below) against each center that has a program
 * taxonomy, and writes one row per (centerCode, cwid) to
 * `CenterCollabCandidate`. No REMOVE/ADD/recruit classification happens here
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
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildCodeByUi, isCancerRelated, parseCsv, type Descriptor } from "@/lib/cancer-center-mesh-taxonomy";
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

  // Active research members — v1's exact REMOVE-eligible population — plus
  // the ANY-type active membership set, used only to exclude already-rostered
  // people from the candidate side (see the schema doc comment on
  // `CenterCollabCandidate`).
  const memberships = await db.write.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true, programCode: true, membershipType: true, startDate: true, endDate: true },
  });
  const active = memberships.filter((m) => isCenterMembershipActive(m.startDate, m.endDate, today));
  const anyActiveMemberCwids = new Set(active.map((m) => m.cwid));
  const researchMembers = active.filter((m) => m.membershipType === "research");

  // Candidate universe: every full-time faculty member, minus anyone already
  // on this center's roster under some OTHER membership type (not a fresh
  // candidate, out of REMOVE's scope too — see the schema comment).
  const candidateScholars = await db.write.scholar.findMany({
    where: { deletedAt: null, status: "active", roleCategory: "full_time_faculty" },
    select: { cwid: true },
  });
  const universe: CollabUniverseMember[] = [
    ...researchMembers.map((m) => ({ cwid: m.cwid, isResearchMember: true, programCode: m.programCode })),
    // anyActiveMemberCwids is a superset of researchMemberCwids, so this also
    // correctly excludes research members from being added twice.
    ...candidateScholars
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
  const codeByUi = await loadCodeByUi();
  const rows: CollabAuthorRow[] = authorRows
    .filter((r): r is typeof r & { cwid: string } => r.cwid !== null)
    .map((r) => {
      const mt = r.publication.meshTerms;
      const meshUis = Array.isArray(mt)
        ? mt.flatMap((x) => (x && typeof x === "object" && "ui" in x && typeof x.ui === "string" ? [x.ui] : []))
        : [];
      return { pmid: r.pmid, cwid: r.cwid, meshUis };
    });

  const metrics = computeCollabCandidateMetrics(universe, rows, (uis) => isCancerRelated(uis, codeByUi));

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

let cachedCodeByUi: Map<string, Set<string>> | null = null;
async function loadCodeByUi(): Promise<Map<string, Set<string>>> {
  if (cachedCodeByUi) return cachedCodeByUi;
  const taxonomyCsv = readFileSync(path.join(process.cwd(), "docs/cancer-center-disease-taxonomy.csv"), "utf8");
  const taxonomy = parseCsv(taxonomyCsv);
  const descriptors: Descriptor[] = (
    await db.write.meshDescriptor.findMany({ select: { descriptorUi: true, name: true, treeNumbers: true } })
  ).map((d) => ({
    ui: d.descriptorUi,
    name: d.name,
    treeNumbers: Array.isArray(d.treeNumbers) ? d.treeNumbers.filter((x): x is string => typeof x === "string") : [],
  }));
  const { codeByUi, missing } = buildCodeByUi(descriptors, taxonomy);
  if (missing.length) throw new Error(`unresolved NLM descriptors: ${missing.join(", ")}`);
  cachedCodeByUi = codeByUi;
  return codeByUi;
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
