/**
 * RePORTER grant materialization ETL (spec §12).
 *
 * Turns confirmed NIH eRA Commons `profile_id`s into `Grant` rows
 * (`source = "RePORTER"`) so the existing profile / search / edit stack renders
 * a scholar's prior-institution and dropped-WCM-history federal grants — the
 * portion InfoEd (WCM-administered awards only) never had. Distinct from its
 * siblings: `etl/reporter` enriches existing rows, `etl/nih-profile` resolves
 * profile_ids; this one CREATES grant rows.
 *
 * v1 scope: materialize ONLY from `person_nih_profile` (the curated resolver
 * output). The PMID name-matcher (`lib/edit/reporter-grants.rankByPmidOverlap`)
 * is NOT wired in here — that needs a confirm UI (v2).
 *
 * Per scholar:
 *   1. Fetch every fiscal year of every award for their profile_id(s).
 *   2. Collapse fiscal years per core_project_num (min/max dates, org pref WCM).
 *   3. Drop awards InfoEd already covers (`dedupeAgainstInfoEd`, spec §6a).
 *   4. Upsert a deterministic Grant row per net-new core (idempotent).
 *   5. Default-hide awards older than RECENCY_YEARS via a system `Suppression`
 *      (user-revocable to surface; spec §6c).
 *   6. Reconcile: delete `source='RePORTER'` rows no longer returned. NEVER
 *      touches `source='InfoEd'` rows.
 *
 * Usage: `npm run etl:reporter-grants`
 */
import { db } from "../../lib/db";
import { assertPruneVolume } from "../../lib/etl-guard";
import { withEtlRun } from "@/lib/etl-run";
import type { Prisma } from "@/lib/generated/prisma/client";
import {
  dedupeAgainstInfoEd,
  rankByPmidOverlap,
  type Candidate,
  type InfoedGrant,
} from "@/lib/edit/reporter-grants";
import {
  fetchGrantProjectsByProfileIds,
  fetchPublicationsByCoreProjectNums,
  searchProjectsByPiName,
  sleepBetweenRequests,
} from "../nih-profile/fetcher";
import {
  RECENCY_YEARS,
  buildReporterGrantRow,
  groupProjectsByCore,
  recencyShouldSuppress,
  toReporterProject,
  type ReporterGrantRow,
} from "./transform";
import {
  decideWriteOutcome,
  groupCandidatesByProfileId,
  candidatePredatesTerminalDegree,
  hasDiscriminator,
  parseFirstLast,
  reconcileWithExisting,
  selectRunWindow,
  selectV2Cohort,
  summarizeCandidateGrants,
  terminalDegreeYear,
} from "./v2";

/** createdBy marker for the age-based default-hide. User overrides (a manual
 *  "not mine" hide, or a revoke of this row) carry a different createdBy and are
 *  never touched by this ETL. */
const SYSTEM_RECENCY = "system-recency";

/** v2 PMID-overlap matcher (spec §9). Gates the entire v2 branch — cohort scan,
 *  candidate generation, auto-lock + pending writes. Off ⇒ ETL is v1-only.
 *  Read the same way as other ETL flags (e.g. SELF_EDIT_ED_ADMINS_IMPORT). */
const REPORTER_MATCH_V2_ENABLED = process.env.REPORTER_MATCH_V2 === "on";

/** Runtime guard (handoff #1). Per-run cap on scholars scanned so the nightly v2
 *  pass can't blow its window on the full cohort × ~3 RePORTER calls @ 1 req/s.
 *  A day-rotating window (selectRunWindow) covers everyone over ceil(cohort/cap)
 *  nights. Default 500 (≈ ≤30 min of RePORTER calls); tune
 *  REPORTER_MATCH_V2_MAX_PER_RUN once the staging cohort is sized. 0/negative ⇒
 *  no cap (whole cohort in one run). */
const maxPerRunRaw = Number(process.env.REPORTER_MATCH_V2_MAX_PER_RUN ?? "500");
const REPORTER_MATCH_V2_MAX_PER_RUN = Number.isFinite(maxPerRunRaw) ? maxPerRunRaw : 500;

/** Minimum trusted PMIDs for a scholar to enter the matcher. Default 1 (any
 *  PMID); raise REPORTER_MATCH_V2_MIN_PMIDS to trim to higher-yield scholars. */
const minPmidsRaw = Number(process.env.REPORTER_MATCH_V2_MIN_PMIDS ?? "1");
const REPORTER_MATCH_V2_MIN_PMIDS = Number.isFinite(minPmidsRaw) ? minPmidsRaw : 1;

/** 1-based day of the year (UTC) — the rotation index for selectRunWindow. */
function dayOfYear(d: Date): number {
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
}

/** resolution_source stamped on a person_nih_profile row a v2 auto-lock creates,
 *  so the audit SQL can split v2 (pmid-overlap) grants from v1 (spec §12). */
const PMID_OVERLAP_AUTO = "pmid-overlap-auto";

const DELETE_BATCH = 500;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * v2 branch (spec §4): resolve the non-`person_nih_profile` active cohort by
 * name → candidate profile_ids → PMID overlap, then auto-lock (K≥3) or propose
 * (K=2) the winner. Auto-locks write a `person_nih_profile` row whose grants the
 * v1 path below materializes in the *same* run; K=2 lands a pending
 * `ReporterProfileCandidate` for the /edit confirm card (no grants until a human
 * confirms). Runs before the v1 fetch so same-run materialization works.
 *
 * Idempotency (§4.6): terminal (rejected/revoked) candidates are never
 * resurrected, human/system `confirmed` rows are never overwritten by a re-run,
 * and a still-pending row just gets its summary + lastSeenAt refreshed.
 */
async function runReporterMatchV2(): Promise<void> {
  console.log("--- v2 PMID-overlap matcher (REPORTER_MATCH_V2=on) ---");
  const now = new Date();

  const activeScholars = await db.write.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: { cwid: true, fullName: true },
  });
  const profiledCwids = new Set(
    (await db.write.personNihProfile.findMany({ select: { cwid: true } })).map((r) => r.cwid),
  );
  const cohort = selectV2Cohort(activeScholars, profiledCwids);
  const runCohort = selectRunWindow(cohort, REPORTER_MATCH_V2_MAX_PER_RUN, dayOfYear(now));
  console.log(
    `  cohort: ${cohort.length} active scholars without a person_nih_profile row ` +
      `(of ${activeScholars.length} active); this run scans ${runCohort.length} ` +
      `(cap ${REPORTER_MATCH_V2_MAX_PER_RUN}/run, min ${REPORTER_MATCH_V2_MIN_PMIDS} trusted PMIDs).`,
  );

  let autoLocked = 0;
  let proposed = 0;
  let skippedNoPmids = 0;
  let namesakeSkipped = 0;
  let errored = 0;
  let processed = 0;

  for (const scholar of runCohort) {
    const trustedRows = await db.write.publicationAuthor.findMany({
      where: { cwid: scholar.cwid, isConfirmed: true },
      select: { pmid: true },
    });
    const trustedPmids = new Set(trustedRows.map((r) => Number(r.pmid)));
    if (!hasDiscriminator(trustedPmids.size, REPORTER_MATCH_V2_MIN_PMIDS)) {
      skippedNoPmids++;
      continue;
    }

    const { firstName, lastName } = parseFirstLast(scholar.fullName);
    if (!firstName || !lastName) continue;

    let projects;
    try {
      projects = await searchProjectsByPiName({ firstName, lastName });
    } catch (err) {
      errored++;
      console.warn(`  [${scholar.cwid}] pi_names search failed: ${(err as Error).message}`);
      await sleepBetweenRequests();
      continue;
    }
    await sleepBetweenRequests();

    const groups = groupCandidatesByProfileId(scholar.fullName, projects);
    if (groups.length === 0) continue;

    // Existing ledger rows for this scholar — drives the terminal-skip + reconcile.
    const existingRows = await db.write.reporterProfileCandidate.findMany({
      where: { cwid: scholar.cwid },
      select: { externalProfileId: true, status: true },
    });
    const statusByProfile = new Map(existingRows.map((r) => [r.externalProfileId, r.status]));

    const candidates: Candidate[] = [];
    for (const g of groups) {
      // Never re-probe a terminal (rejected/revoked) candidate (§4.6).
      const st = statusByProfile.get(g.profileId);
      if (st === "rejected" || st === "revoked") continue;
      let pubs;
      try {
        pubs = await fetchPublicationsByCoreProjectNums(g.coreNums);
      } catch (err) {
        errored++;
        console.warn(
          `  [${scholar.cwid}] publications fetch failed for profile ${g.profileId}: ` +
            `${(err as Error).message}`,
        );
        await sleepBetweenRequests();
        continue;
      }
      await sleepBetweenRequests();
      candidates.push({
        profileId: g.profileId,
        fullName: g.fullName,
        orgs: [],
        grantPmids: new Set(pubs.map((p) => p.pmid)),
      });
    }
    if (candidates.length === 0) continue;

    const match = rankByPmidOverlap(trustedPmids, candidates);
    const outcome = decideWriteOutcome(match);
    if (outcome.kind === "none") continue;

    const action = reconcileWithExisting(outcome, statusByProfile.get(outcome.profileId));
    if (action.kind === "skip") continue;

    // Card detail for the chosen candidate: real grant titles/orgs/years.
    let detail;
    try {
      detail = await fetchGrantProjectsByProfileIds([outcome.profileId]);
    } catch (err) {
      errored++;
      console.warn(`  [${scholar.cwid}] grant detail fetch failed: ${(err as Error).message}`);
      await sleepBetweenRequests();
      continue;
    }
    await sleepBetweenRequests();
    const winnerGroups = groupProjectsByCore(detail);

    // Terminal-degree namesake guard (precision): a same-name NIH profile whose
    // entire NON-fellowship grant history ends before the scholar's earliest
    // doctorate is almost certainly a different person — skip it. Fellowships
    // (F30/F31/F32/F33) legitimately precede the degree and don't count; a
    // scholar with no terminal degree on file fails open (never suppressed).
    const educations = await db.write.education.findMany({
      where: { cwid: scholar.cwid },
      select: { degree: true, year: true },
    });
    const degreeYear = terminalDegreeYear(educations);
    if (degreeYear !== null && candidatePredatesTerminalDegree(winnerGroups, degreeYear)) {
      namesakeSkipped++;
      console.log(
        `  [${scholar.cwid}] skipped profile ${outcome.profileId}: non-fellowship grants ` +
          `predate terminal degree (${degreeYear}) — likely namesake`,
      );
      continue;
    }

    const infoedRows = await db.write.grant.findMany({
      where: { cwid: scholar.cwid, source: "InfoEd", awardNumber: { not: null } },
      select: { awardNumber: true },
    });
    const summary = summarizeCandidateGrants(
      winnerGroups,
      infoedRows.map((r) => ({ awardNumber: r.awardNumber })),
    );
    const overlapK = match.ranked.find((r) => r.profileId === outcome.profileId)?.overlap ?? 0;
    const candidateName =
      groups.find((g) => g.profileId === outcome.profileId)?.fullName ?? scholar.fullName;
    const sampleGrantsJson = summary.sampleGrants as unknown as Prisma.InputJsonValue;

    if (action.kind === "autolock-confirm") {
      await db.write.$transaction(async (tx) => {
        await tx.personNihProfile.upsert({
          where: { cwid_nihProfileId: { cwid: scholar.cwid, nihProfileId: outcome.profileId } },
          create: {
            cwid: scholar.cwid,
            nihProfileId: outcome.profileId,
            resolutionSource: PMID_OVERLAP_AUTO,
            lastVerified: now,
          },
          update: { resolutionSource: PMID_OVERLAP_AUTO, lastVerified: now },
        });
        await tx.reporterProfileCandidate.upsert({
          where: {
            cwid_externalProfileId: { cwid: scholar.cwid, externalProfileId: outcome.profileId },
          },
          create: {
            cwid: scholar.cwid,
            externalProfileId: outcome.profileId,
            candidateName,
            candidateOrgs: summary.candidateOrgs,
            grantCount: summary.grantCount,
            overlapK,
            sampleGrants: sampleGrantsJson,
            status: "confirmed",
            reviewedBy: "system-autolock",
            reviewedAt: now,
            lastSeenAt: now,
          },
          update: {
            candidateName,
            candidateOrgs: summary.candidateOrgs,
            grantCount: summary.grantCount,
            overlapK,
            sampleGrants: sampleGrantsJson,
            status: "confirmed",
            reviewedBy: "system-autolock",
            reviewedAt: now,
            lastSeenAt: now,
          },
        });
      });
      autoLocked++;
    } else {
      // pending-upsert: refresh summary + lastSeenAt; never touch status on update
      // (reconcile already excluded terminal/confirmed rows, so it stays pending).
      await db.write.reporterProfileCandidate.upsert({
        where: {
          cwid_externalProfileId: { cwid: scholar.cwid, externalProfileId: outcome.profileId },
        },
        create: {
          cwid: scholar.cwid,
          externalProfileId: outcome.profileId,
          candidateName,
          candidateOrgs: summary.candidateOrgs,
          grantCount: summary.grantCount,
          overlapK,
          sampleGrants: sampleGrantsJson,
          status: "pending",
          lastSeenAt: now,
        },
        update: {
          candidateName,
          candidateOrgs: summary.candidateOrgs,
          grantCount: summary.grantCount,
          overlapK,
          sampleGrants: sampleGrantsJson,
          lastSeenAt: now,
        },
      });
      proposed++;
    }

    processed++;
    if (processed % 50 === 0) {
      console.log(
        `  ...v2 processed ${processed} matched scholars ` +
          `(${autoLocked} auto-locked, ${proposed} proposed, ${errored} fetch errors)`,
      );
    }
  }

  console.log(
    `  v2 complete: ${autoLocked} auto-locked, ${proposed} pending proposals ` +
      `(${skippedNoPmids} skipped: no trusted PMIDs, ${namesakeSkipped} skipped: ` +
      `grants predate terminal degree, ${errored} fetch errors).\n`,
  );
}

async function main() {
  console.log("\n=== RePORTER Grants ETL ===\n");
  const currentYear = new Date().getUTCFullYear();

  // 0. v2 PMID-overlap matcher (flag-gated). Runs first so any person_nih_profile
  //    row it auto-locks is materialized by the v1 path below in the same run.
  if (REPORTER_MATCH_V2_ENABLED) {
    await runReporterMatchV2();
  }

  // 1. Confirmed profile_ids per active scholar (resolution source #1; v1).
  //    Union all of a scholar's profile_ids — the PK allows multiple.
  const profileRows = await db.write.personNihProfile.findMany({
    where: { scholar: { deletedAt: null, status: "active" } },
    select: { cwid: true, nihProfileId: true },
  });
  const profilesByCwid = new Map<string, number[]>();
  for (const r of profileRows) {
    const arr = profilesByCwid.get(r.cwid) ?? [];
    arr.push(r.nihProfileId);
    profilesByCwid.set(r.cwid, arr);
  }
  console.log(
    `${profilesByCwid.size} active scholars with ≥1 confirmed RePORTER profile_id.`,
  );

  // 2. InfoEd grants per scholar, for dedup (spec §6a). InfoEd is WCM's system,
  //    so these rows are the WCM-administered floor a RePORTER award must clear.
  const infoedRows = await db.write.grant.findMany({
    where: { source: "InfoEd", awardNumber: { not: null } },
    select: { cwid: true, awardNumber: true },
  });
  const infoedByCwid = new Map<string, InfoedGrant[]>();
  for (const r of infoedRows) {
    const arr = infoedByCwid.get(r.cwid) ?? [];
    arr.push({ awardNumber: r.awardNumber });
    infoedByCwid.set(r.cwid, arr);
  }

  // Existing system-recency suppressions (active OR revoked). Revoked rows stay
  // in this set so a user who surfaced an old grant isn't re-hidden next run.
  const existingRecencyHides = new Set(
    (
      await db.write.suppression.findMany({
        where: { entityType: "grant", createdBy: SYSTEM_RECENCY },
        select: { entityId: true },
      })
    ).map((s) => s.entityId),
  );

  // 3. Per scholar: fetch → group → dedup → upsert (+ recency suppression).
  const keptIds = new Set<string>();
  // Scholars whose RePORTER fetch errored — their existing rows must be
  // EXCLUDED from the stale reconcile below, or a transient per-scholar API
  // failure deletes that scholar's entire RePORTER grant set (the swallowed
  // error keeps the run exiting 0).
  const erroredCwids = new Set<string>();
  let processed = 0;
  let grantsUpserted = 0;
  let newlySuppressed = 0;
  let skippedNoDate = 0;
  let errored = 0;

  const scholars = [...profilesByCwid.entries()];
  for (const [cwid, profileIds] of scholars) {
    let fetched;
    try {
      fetched = await fetchGrantProjectsByProfileIds(profileIds);
    } catch (err) {
      errored++;
      erroredCwids.add(cwid);
      console.warn(`  [${cwid}] RePORTER fetch failed: ${(err as Error).message}`);
      await sleepBetweenRequests();
      continue;
    }

    const grouped = groupProjectsByCore(fetched);
    const byCore = new Map(grouped.map((g) => [g.coreProjectNum, g]));
    const { netNew } = dedupeAgainstInfoEd(
      grouped.map(toReporterProject),
      infoedByCwid.get(cwid) ?? [],
    );

    const toWrite: Array<{ row: ReporterGrantRow; maxFiscalYear: number | null }> = [];
    for (const p of netNew) {
      const g = byCore.get(p.coreProjectNum.toUpperCase());
      if (!g) continue;
      const row = buildReporterGrantRow(cwid, g);
      if (!row) {
        skippedNoDate++;
        continue;
      }
      toWrite.push({ row, maxFiscalYear: g.maxFiscalYear });
    }

    if (toWrite.length > 0) {
      await db.write.$transaction(async (tx) => {
        for (const { row, maxFiscalYear } of toWrite) {
          await tx.grant.upsert({
            where: { id: row.id },
            create: row,
            update: {
              title: row.title,
              role: row.role,
              funder: row.funder,
              mechanism: row.mechanism,
              nihIc: row.nihIc,
              startDate: row.startDate,
              endDate: row.endDate,
              awardNumber: row.awardNumber,
              programType: row.programType,
              source: row.source,
              lastRefreshedAt: new Date(),
            },
          });
          keptIds.add(row.id);

          if (
            recencyShouldSuppress(maxFiscalYear, currentYear) &&
            !existingRecencyHides.has(row.externalId)
          ) {
            await tx.suppression.create({
              data: {
                entityType: "grant",
                entityId: row.externalId,
                reason:
                  `RePORTER grant default-hidden by age: last fiscal year ` +
                  `${maxFiscalYear ?? "unknown"} is more than ${RECENCY_YEARS} ` +
                  `years old. Revoke to surface it on the profile.`,
                createdBy: SYSTEM_RECENCY,
              },
            });
            existingRecencyHides.add(row.externalId);
            newlySuppressed++;
          }
        }
      });
      grantsUpserted += toWrite.length;
    }

    processed++;
    if (processed % 50 === 0) {
      console.log(
        `  ...processed ${processed}/${scholars.length} scholars ` +
          `(${grantsUpserted} grants upserted, ${errored} fetch errors)`,
      );
    }
    await sleepBetweenRequests();
  }

  console.log(
    `\nMaterialized ${grantsUpserted} net-new RePORTER grants across ` +
      `${processed} scholars ` +
      `(${newlySuppressed} default-hidden by age, ${skippedNoDate} skipped: no dates, ` +
      `${errored} fetch errors).`,
  );

  // 4. Reconcile (ADR-005). Delete RePORTER rows no longer returned — a
  //    profile_id was unlinked, or a grant aged out of fetch. Suppressions are
  //    left in place so a "not mine" / system hide survives a later re-add.
  //    The `source: "RePORTER"` guard means InfoEd rows are never touched.
  const existingReporter = await db.write.grant.findMany({
    where: { source: "RePORTER" },
    select: { id: true, cwid: true },
  });
  const staleIds = existingReporter
    .filter((g) => !erroredCwids.has(g.cwid))
    .map((g) => g.id)
    .filter((id) => !keptIds.has(id));
  if (erroredCwids.size > 0) {
    console.warn(
      `Reconcile: ${erroredCwids.size} scholar(s) with fetch errors excluded from the stale prune.`,
    );
  }
  // Belt-and-braces: even with errored scholars excluded, an implausibly
  // large stale set means a systemic fetch problem, not real churn.
  assertPruneVolume("reporter-grants:stale-reconcile", {
    pruning: staleIds.length,
    of: existingReporter.length,
    maxPct: 25,
  });
  let deleted = 0;
  for (const batch of chunks(staleIds, DELETE_BATCH)) {
    const res = await db.write.grant.deleteMany({
      where: { source: "RePORTER", id: { in: batch } },
    });
    deleted += res.count;
  }
  console.log(`Reconcile: deleted ${deleted} stale RePORTER grant rows.`);
  console.log("\nRePORTER Grants ETL complete.\n");
}

// Records an etl_run row (source "ReporterGrants") so the freshness heartbeat
// tracks this weekly step (PR-7). main() does not disconnect internally, so the
// success/failure etl_run update runs before the outer disconnect below.
withEtlRun("ReporterGrants", main)
  .then(() => db.write.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.write.$disconnect();
    process.exit(1);
  });
