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
 *      (user-revocable to surface; spec §6c). Behind
 *      REPORTER_GRANTS_CORROBORATION_HIDE, score every award from a name-only
 *      or grant-join profile (#3071, `score.ts`) and act on the band: hide
 *      mints a system-unverified hide, queue mints one AND files a curator
 *      review (`grant_attribution_review`), show revokes a hide an earlier run
 *      minted (see `attribution-plan.ts` for what is never overridden).
 *   6. Reconcile: delete `source='RePORTER'` rows no longer returned. NEVER
 *      touches `source='InfoEd'` rows.
 *
 * Usage: `npm run etl:reporter-grants`
 */
import { db, disconnect } from "../../lib/db";
import { assertPruneVolume } from "../../lib/etl-guard";
import { withEtlRun } from "@/lib/etl-run";
import { Prisma } from "@/lib/generated/prisma/client";
import { coreProjectNum } from "@/lib/award-number";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  dedupeAgainstInfoEd,
  rankByPmidOverlap,
  type Candidate,
  type InfoedGrant,
} from "@/lib/edit/reporter-grants";
import { reflectGrantSuppressions } from "@/lib/edit/search-suppression";
import {
  fetchGrantProjectsByProfileIds,
  fetchPublicationsByCoreProjectNums,
  PAGE_LIMIT as PI_NAME_PAGE_LIMIT,
  searchProjectsByPiName,
  sleepBetweenRequests,
} from "../nih-profile/fetcher";
import { reporterPiName } from "../nih-profile/resolver";
import {
  SYSTEM_RESCORED,
  attributionGate,
  isReopenedFromDecision,
  planAward,
  type AwardPlan,
  type AwardState,
} from "./attribution-plan";
import { buildAwardEvidence, buildScholarFacts, profileProof } from "./evidence";
import {
  evidenceKey,
  nameProfileCountFrom,
  piSurnameMatches,
  scoreAttribution,
  type AttributionScore,
  type CueId,
} from "./score";
import {
  RECENCY_YEARS,
  buildReporterGrantRow,
  corroborationPolicy,
  groupProjectsByCore,
  isPublicationMatchedSource,
  recencyShouldSuppress,
  toReporterProject,
  type CorroborationPolicy,
  type GroupedProject,
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

/** createdBy marker for the #3071 default-hide of an uncorroborated award from a
 *  name-only or grant-join profile. Same lifecycle as SYSTEM_RECENCY: minted
 *  once per row, user-revocable, and a revoked one is never re-minted. */
const SYSTEM_UNVERIFIED = "system-unverified";

/** #3071 — the Suppression.reason for an unverified hide, by policy. */
const UNVERIFIED_REASON: Record<Exclude<CorroborationPolicy, "none">, string> = {
  "wcm-or-publication":
    `RePORTER grant default-hidden as unverified: the scholar's NIH profile was ` +
    `matched by name only, and neither a WCM org nor a confirmed publication ` +
    `ties this award to them. Revoke to surface it on the profile.`,
  "publication-only":
    `RePORTER grant default-hidden as unverified: the scholar's NIH profile was ` +
    `matched through a WCM grant and a name check, which a similarly named WCM ` +
    `colleague can pass, and no confirmed publication ties this award to them. ` +
    `Revoke to surface it on the profile.`,
};

/** #3071 — the Suppression.reason for a queued award (hidden until a curator
 *  decides on /edit/grant-attribution-queue). */
const QUEUED_REASON =
  `RePORTER grant hidden pending curator review: the evidence tying it to the ` +
  `scholar is weak or points both ways.`;

/** #3071 — gates the uncorroborated-award default-hide. Off ⇒ behaviour is
 *  exactly as before. Wired per env in cdk/lib/etl-stack.ts. */
const CORROBORATION_HIDE_ENABLED = process.env.REPORTER_GRANTS_CORROBORATION_HIDE === "on";

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
 * name → candidate profile_ids → PMID overlap, then auto-lock a separated K≥2
 * winner. Auto-locks write a `person_nih_profile` row whose grants the v1 path
 * below materializes in the *same* run, plus a B03 audit row (system actor
 * "system-autolock", action `reporter_profile_confirm`) in the same
 * transaction — this write has no human session, so it can't go through the
 * `/edit` confirm route's audited path. An unseparated/ambiguous result instead
 * lands a pending `ReporterProfileCandidate` for the /edit confirm card (no
 * grants until a human confirms) — see the K_AUTOLOCK/K_SUGGEST note in
 * `lib/edit/reporter-grants.ts` for why that pending branch rarely fires now.
 * Runs before the v1 fetch so same-run materialization works.
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
        pubs = await fetchPublicationsByCoreProjectNums(g.coreNums, trustedPmids);
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

    const priorStatus = statusByProfile.get(outcome.profileId);
    const action = reconcileWithExisting(outcome, priorStatus);
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
        const candidateRow = await tx.reporterProfileCandidate.upsert({
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
        // B03 audit row for the system auto-lock (previously unaudited — there
        // is no human session here, so this can't go through the /edit confirm
        // route's `appendAuditRow` call; reuses the same `reporter_profile_confirm`
        // action rather than a new enum value, actor stamped as "system-autolock"
        // to match `reviewedBy` above). Written in the SAME transaction as the
        // two upserts, per appendAuditRow's atomic-with-the-write contract.
        await appendAuditRow(tx, {
          actorCwid: "system-autolock",
          impersonatedCwid: null,
          targetEntityType: "reporter_profile_candidate",
          targetEntityId: candidateRow.id,
          action: "reporter_profile_confirm",
          fieldsChanged: ["status"],
          beforeValues: priorStatus ? { status: priorStatus } : null,
          afterValues: { status: "confirmed", nihProfileId: outcome.profileId },
          ts: now,
          requestId: null,
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

/** #3071 — one award the scorer judges, with what it needs from the grouping. */
interface ScoredCandidate {
  row: ReporterGrantRow;
  group: GroupedProject;
}

/** #3071 — the run-wide inputs the attribution scorer reads, loaded once. */
interface AttributionContext {
  profileIdsByCwid: Map<string, number[]>;
  /** The subset matched by publications or a curator (cue 8). */
  matchedProfileIdsByCwid: Map<string, number[]>;
  /** Other WCM investigators per core project number (InfoEd). */
  infoedByCore: Map<string, Array<{ cwid: string; role: string }>>;
  namesByCwid: Map<string, { fullName: string; preferredName: string }>;
  educationByCwid: Map<string, Array<{ degree: string; institution: string; year: number | null }>>;
  /** False until etl:reciter has mirrored ReCiter rejections at least once:
   *  cue 2 is then unavailable, not "no rejections". */
  rejectedAvailable: boolean;
  /** WCM directory namesakes per name-only scholar (etl:ed). null ⇒ the table
   *  is empty, so "held at WCM" counts as it did before the guard. */
  wcmNamesakesByCwid: Map<string, number> | null;
}

/** What `scoreScholarAwards` returns per award: the scorer's verdict plus the
 *  card facts a queued review stores. */
interface ScoredAward {
  score: AttributionScore;
  key: string;
  award: Prisma.InputJsonValue;
  /** Every per-award negative input was known (`buildAwardEvidence`). */
  revocable: boolean;
  /** RePORTER's name for the PI entry on one of the scholar's NIH profiles. */
  reporterName: string | null;
}

const yearOf = (d: Date | null): number | null => (d ? d.getUTCFullYear() : null);

/** The card's award facts: what RePORTER says, as printed. */
function awardFacts(c: ScoredCandidate): Prisma.InputJsonValue {
  const orgs = new Map<string, { name: string; from: number | null; to: number | null }>();
  for (const o of c.group.orgHistory) {
    if (!o.orgName) continue;
    const e = orgs.get(o.orgName) ?? { name: o.orgName, from: o.fiscalYear, to: o.fiscalYear };
    if (o.fiscalYear !== null) {
      if (e.from === null || o.fiscalYear < e.from) e.from = o.fiscalYear;
      if (e.to === null || o.fiscalYear > e.to) e.to = o.fiscalYear;
    }
    orgs.set(o.orgName, e);
  }
  return {
    title: c.row.title,
    awardNumber: c.row.awardNumber,
    coreProjectNum: c.group.coreProjectNum,
    activityCode: c.row.mechanism,
    applId: c.group.applId,
    startYear: yearOf(c.row.startDate),
    endYear: yearOf(c.row.endDate),
    orgs: [...orgs.values()],
    piNames: c.group.pis.map(reporterPiName).filter((n) => n.length > 0),
  };
}

/**
 * #3071 — score every candidate award of one scholar. One pass of reads, all
 * this scholar's: confirmed publications (with authors and MeSH), ReCiter
 * rejections, the RePORTER publication links for the candidate cores, and the
 * MeSH descriptors already on the grant rows.
 *
 * Fails OPEN, never closed: a scholar with no confirmed PMIDs ("no-pmids") or a
 * failed RePORTER call ("fetch-error") is left unjudged, so nothing is hidden,
 * queued or revoked for them this run. A blip must not become a wave of hides.
 */
async function scoreScholarAwards(
  cwid: string,
  policy: CorroborationPolicy,
  candidates: ScoredCandidate[],
  ctx: AttributionContext,
): Promise<Map<string, ScoredAward> | "no-pmids" | "fetch-error"> {
  const confirmed = await db.write.publicationAuthor.findMany({
    where: { cwid, isConfirmed: true },
    select: { pmid: true, publication: { select: { authorsString: true, meshTerms: true } } },
  });
  if (confirmed.length === 0) return "no-pmids";

  const rejected = ctx.rejectedAvailable
    ? new Set(
        (
          await db.write.reciterRejectedPmid.findMany({ where: { cwid }, select: { pmid: true } })
        ).map((r) => r.pmid),
      )
    : null;
  const facts = buildScholarFacts({
    names: ctx.namesByCwid.get(cwid),
    confirmed,
    educations: ctx.educationByCwid.get(cwid) ?? [],
    profileIds: ctx.profileIdsByCwid.get(cwid) ?? [],
    matchedProfileIds: ctx.matchedProfileIdsByCwid.get(cwid) ?? [],
    rejected,
  });

  const ids = candidates.map((c) => c.row.id);
  const linkedViaGrantPub = new Set(
    (
      await db.write.grantPublication.findMany({
        where: { grantId: { in: ids } },
        select: { grantId: true, pmid: true },
      })
    )
      .filter((l) => facts.pmids.has(l.pmid))
      .map((l) => l.grantId),
  );

  // Every candidate core, not only the ones grant_publication left open: cue 2
  // needs each award's full linked set. The PMID list only restricts a core
  // over RePORTER's offset cap (center grants); confirmed plus rejected keeps
  // both cues answerable there, and `restricted` marks those cores so cue 2
  // never reads the restricted set as the award's size.
  const restricted = new Set<string>();
  let pubs;
  try {
    pubs = await fetchPublicationsByCoreProjectNums(
      candidates.map((c) => c.group.coreProjectNum),
      [...facts.pmids, ...(rejected ?? [])].map(Number).filter((n) => Number.isFinite(n) && n > 0),
      restricted,
    );
  } catch (err) {
    console.warn(`  [${cwid}] attribution publications fetch failed: ${(err as Error).message}`);
    return "fetch-error";
  } finally {
    await sleepBetweenRequests();
  }
  const linkedByCore = new Map<string, Set<string>>();
  for (const p of pubs) {
    if (!p.coreProjectNum) continue;
    const core = p.coreProjectNum.toUpperCase();
    const set = linkedByCore.get(core) ?? new Set<string>();
    set.add(String(p.pmid));
    linkedByCore.set(core, set);
  }

  const meshByGrant = new Map(
    (
      await db.write.grant.findMany({
        where: { id: { in: ids } },
        select: { id: true, meshDescriptorUis: true },
      })
    ).map((g) => [g.id, Array.isArray(g.meshDescriptorUis) ? (g.meshDescriptorUis as unknown[]) : []]),
  );

  const built = candidates.map((c) => {
    const core = c.group.coreProjectNum;
    return buildAwardEvidence({
      policy,
      facts,
      group: c.group,
      linkedViaGrantPub: linkedViaGrantPub.has(c.row.id),
      linked: linkedByCore.get(core) ?? new Set<string>(),
      linkedRestricted: restricted.has(core.toUpperCase()),
      infoedOthers: (ctx.infoedByCore.get(core) ?? [])
        .filter((o) => o.cwid !== cwid)
        .map((o) => {
          const n = ctx.namesByCwid.get(o.cwid);
          return { role: o.role, names: [n?.fullName, n?.preferredName] };
        }),
      meshUis: (meshByGrant.get(c.row.id) ?? []).filter((u): u is string => typeof u === "string"),
    });
  });
  // Cue 8 needs every award's publicationLinked first: a profile is proven by
  // its OTHER awards.
  const proof = profileProof(
    built.map((b) => ({ ourProfileIds: b.ourProfileIds, publicationLinked: b.evidence.publicationLinked })),
    facts.matchedProfileIds,
  );
  // Rule 4: how many NIH PI profiles share the name. Name-only profiles only.
  // A failed search leaves the scholar unjudged, like the publications fetch:
  // dropping the cue could move an award across a band and mint a hide.
  let nameProfileCount: number | null = null;
  const fullName = ctx.namesByCwid.get(cwid)?.fullName;
  if (policy === "wcm-or-publication" && fullName) {
    const { firstName, lastName } = parseFirstLast(fullName);
    if (firstName) {
      try {
        const projects = await searchProjectsByPiName({ firstName, lastName });
        nameProfileCount = nameProfileCountFrom(
          groupCandidatesByProfileId(fullName, projects).length,
          projects.length,
          PI_NAME_PAGE_LIMIT,
        );
      } catch (err) {
        console.warn(`  [${cwid}] name rarity search failed: ${(err as Error).message}`);
        return "fetch-error";
      } finally {
        await sleepBetweenRequests();
      }
    }
  }
  const wcmNamesakes = ctx.wcmNamesakesByCwid ? (ctx.wcmNamesakesByCwid.get(cwid) ?? null) : null;
  const out = new Map<string, ScoredAward>();
  const scholarNames = [ctx.namesByCwid.get(cwid)?.fullName, ctx.namesByCwid.get(cwid)?.preferredName];
  candidates.forEach((c, i) => {
    const { evidence, revocable, ourProfileIds } = built[i]!;
    const ours = c.group.pis.find((pi) => ourProfileIds.includes(pi.profile_id));
    const reporterName = ours ? reporterPiName(ours) || null : null;
    const score = scoreAttribution({
      ...evidence,
      profileProven: proof[i]!,
      nameProfileCount,
      wcmNamesakes,
      piSurnameMatches: piSurnameMatches(reporterName, scholarNames),
    });
    out.set(c.row.externalId, {
      score,
      key: evidenceKey(score),
      award: awardFacts(c),
      revocable,
      reporterName,
    });
  });
  return out;
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
    select: { cwid: true, nihProfileId: true, resolutionSource: true },
  });
  const profilesByCwid = new Map<string, number[]>();
  const matchedProfilesByCwid = new Map<string, number[]>();
  const sourcesByCwid = new Map<string, string[]>();
  for (const r of profileRows) {
    if (isPublicationMatchedSource(r.resolutionSource)) {
      matchedProfilesByCwid.set(r.cwid, [...(matchedProfilesByCwid.get(r.cwid) ?? []), r.nihProfileId]);
    }
    const arr = profilesByCwid.get(r.cwid) ?? [];
    arr.push(r.nihProfileId);
    profilesByCwid.set(r.cwid, arr);
    const src = sourcesByCwid.get(r.cwid) ?? [];
    src.push(r.resolutionSource);
    sourcesByCwid.set(r.cwid, src);
  }
  console.log(
    `${profilesByCwid.size} active scholars with ≥1 confirmed RePORTER profile_id.`,
  );

  // 2. InfoEd grants per scholar, for dedup (spec §6a). InfoEd is WCM's system,
  //    so these rows are the WCM-administered floor a RePORTER award must clear.
  const infoedRows = await db.write.grant.findMany({
    where: { source: "InfoEd", awardNumber: { not: null } },
    select: { cwid: true, awardNumber: true, role: true },
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

  // #3071 — attribution scoring state, loaded once. Off ⇒ nothing is read.
  //   unverified: per award, the active system-unverified hide, and whether a
  //     PERSON revoked one (never re-minted). A SYSTEM_RESCORED revoke is the
  //     ETL's own and does not count.
  //   reviews: the curator queue's ledger, by award.
  //   attribution: the run-wide cue inputs.
  const unverified = new Map<string, { activeId: string | null; humanRevoked: boolean }>();
  const reviews = new Map<string, NonNullable<AwardState["review"]>>();
  let attribution: AttributionContext | null = null;
  // Revoking needs every NEGATIVE cue source: without one, missing evidence
  // against an award would read as "show" and lift its hide.
  let allowRevoke = false;
  if (CORROBORATION_HIDE_ENABLED) {
    for (const s of await db.write.suppression.findMany({
      where: { entityType: "grant", createdBy: SYSTEM_UNVERIFIED },
      select: { id: true, entityId: true, revokedAt: true, revokedBy: true },
    })) {
      const e = unverified.get(s.entityId) ?? { activeId: null, humanRevoked: false };
      if (s.revokedAt === null) e.activeId = s.id;
      else if (s.revokedBy !== SYSTEM_RESCORED) e.humanRevoked = true;
      unverified.set(s.entityId, e);
    }
    for (const r of await db.write.grantAttributionReview.findMany({
      select: { grantExternalId: true, status: true, evidenceKey: true, decidedByCwid: true },
    })) {
      reviews.set(r.grantExternalId, {
        status: r.status as NonNullable<AwardState["review"]>["status"],
        evidenceKey: r.evidenceKey,
        reopenedFromDecision: isReopenedFromDecision(r),
      });
    }

    // InfoEd is the dedup floor AND cue 1. An empty read is a degraded one:
    // score nothing rather than read its absence as "no other WCM holder".
    const preGate = attributionGate({ infoedRows: infoedRows.length, educationRows: 1, rejectedRows: 1 });
    if (!preGate.score) {
      for (const w of preGate.warnings) console.warn(`#3071 attribution: ${w}`);
    } else {
      const infoedByCore = new Map<string, Array<{ cwid: string; role: string }>>();
      for (const r of infoedRows) {
        const core = coreProjectNum(r.awardNumber);
        if (!core) continue;
        const arr = infoedByCore.get(core) ?? [];
        arr.push({ cwid: r.cwid, role: r.role });
        infoedByCore.set(core, arr);
      }
      const namesByCwid = new Map(
        (
          await db.write.scholar.findMany({
            where: { deletedAt: null },
            select: { cwid: true, fullName: true, preferredName: true },
          })
        ).map((s) => [s.cwid, { fullName: s.fullName, preferredName: s.preferredName }]),
      );
      const educationByCwid = new Map<
        string,
        Array<{ degree: string; institution: string; year: number | null }>
      >();
      const educationRows = await db.write.education.findMany({
        where: { cwid: { in: [...profilesByCwid.keys()] } },
        select: { cwid: true, degree: true, institution: true, year: true },
      });
      for (const e of educationRows) {
        const arr = educationByCwid.get(e.cwid) ?? [];
        arr.push({ degree: e.degree, institution: e.institution, year: e.year });
        educationByCwid.set(e.cwid, arr);
      }
      const rejectedRows = await db.write.reciterRejectedPmid.count();
      const rejectedAvailable = rejectedRows > 0;
      const gate = attributionGate({
        infoedRows: infoedRows.length,
        educationRows: educationRows.length,
        rejectedRows,
      });
      for (const w of gate.warnings) console.warn(`#3071 attribution: ${w}`);
      const namesakeRows = await db.write.wcmNamesake.findMany({ select: { cwid: true, count: true } });
      if (namesakeRows.length === 0) {
        console.warn("#3071 attribution: no WCM namesake counts yet (etl:ed); held-at-WCM unguarded");
      }
      attribution = {
        profileIdsByCwid: profilesByCwid,
        matchedProfileIdsByCwid: matchedProfilesByCwid,
        infoedByCore,
        namesByCwid,
        educationByCwid,
        rejectedAvailable,
        wcmNamesakesByCwid:
          namesakeRows.length > 0 ? new Map(namesakeRows.map((r) => [r.cwid, r.count])) : null,
      };
      allowRevoke = gate.allowRevoke;
    }
  }
  const tally = {
    band: { show: 0, hide: 0, queue: 0 },
    rule: { conflict: 0, sum: 0 },
    cue: {} as Partial<Record<CueId, number>>,
    minted: { "wcm-or-publication": 0, "publication-only": 0, queue: 0 },
    revoked: 0,
    /** Scored awards whose hide the ETL lifted: the auto-confirmed rows. */
    recovered: 0,
    scholars: 0,
    review: { create: 0, refresh: 0, reopen: 0, withdraw: 0 },
    skippedNoPmids: 0,
    skippedFetchError: 0,
  };

  // 3. Per scholar: fetch → group → dedup → upsert (+ recency suppression).
  const keptIds = new Set<string>();
  // Scholars whose RePORTER fetch errored — their existing rows must be
  // EXCLUDED from the stale reconcile below, or a transient per-scholar API
  // failure deletes that scholar's entire RePORTER grant set (the swallowed
  // error keeps the run exiting 0).
  const erroredCwids = new Set<string>();
  let processed = 0;
  let grantsUpserted = 0;
  let skippedNoDate = 0;
  let errored = 0;
  // #2284 — ADR-005 layer 1 for the recency default-hides minted below.
  // Collected across the whole run and reflected ONCE after the loop: the
  // reflect must happen after its transaction commits, and batching pays for
  // the corpus key scan once. `reporter:{cwid}:{core}` ids parse to nothing, so
  // in practice the batch emits no index op at all — but it still STAMPS
  // `searchReflectedAt`, which is the #2204 defect.
  const minted: Array<{ suppressionId: string; entityId: string }> = [];

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

    const toWrite: Array<{
      row: ReporterGrantRow;
      maxFiscalYear: number | null;
      group: GroupedProject;
    }> = [];
    for (const p of netNew) {
      const g = byCore.get(p.coreProjectNum.toUpperCase());
      if (!g) continue;
      const row = buildReporterGrantRow(cwid, g);
      if (!row) {
        skippedNoDate++;
        continue;
      }
      toWrite.push({ row, maxFiscalYear: g.maxFiscalYear, group: g });
    }

    // #3071 — score this scholar's awards and plan what to do with each.
    // Recency-hidden awards are out of scope: the ETL keeps one system hide
    // per award, so one revoke surfaces it.
    const plans = new Map<string, { plan: AwardPlan; scored: ScoredAward | null }>();
    // Every award judged this run, whatever its band (`grant_attribution_score`).
    let judged: Map<string, ScoredAward> | null = null;
    const policy = corroborationPolicy(sourcesByCwid.get(cwid) ?? []);
    if (CORROBORATION_HIDE_ENABLED && attribution) {
      const inScope = toWrite.filter(
        ({ row, maxFiscalYear }) =>
          !existingRecencyHides.has(row.externalId) &&
          !recencyShouldSuppress(maxFiscalYear, currentYear),
      );
      const stateOf = (externalId: string) => {
        const u = unverified.get(externalId);
        return {
          activeHideId: u?.activeId ?? null,
          humanRevoked: u?.humanRevoked ?? false,
          review: reviews.get(externalId) ?? null,
        };
      };
      if (policy === "none") {
        // Every profile confirmed by publications: nothing to judge. An award a
        // name-linked profile once hid is shown again (when revoking is safe).
        for (const { row } of inScope) {
          const plan = planAward("show", stateOf(row.externalId), "", allowRevoke);
          if (plan.mintHide || plan.revokeHideId || plan.review !== "none") {
            plans.set(row.externalId, { plan, scored: null });
          }
        }
      } else if (inScope.length === 0) {
        // Fetched, nothing left in scope (InfoEd covers it, aged out, gone
        // from RePORTER): judged on zero awards, so last run's rows go.
        judged = new Map();
      } else {
        const scored = await scoreScholarAwards(
          cwid,
          policy,
          inScope.map(({ row, group }) => ({ row, group })),
          attribution,
        );
        if (scored === "no-pmids") {
          tally.skippedNoPmids++;
        } else if (scored === "fetch-error") {
          tally.skippedFetchError++;
        } else {
          judged = scored;
          tally.scholars++;
          for (const [externalId, sc] of scored) {
            tally.band[sc.score.band]++;
            tally.rule[sc.score.rule]++;
            for (const r of sc.score.reasons) tally.cue[r.id] = (tally.cue[r.id] ?? 0) + 1;
            const plan = planAward(
              sc.score.band,
              stateOf(externalId),
              sc.key,
              allowRevoke && sc.revocable,
            );
            plans.set(externalId, { plan, scored: sc });
          }
        }
      }
    }

    if (toWrite.length > 0) {
      await db.write.$transaction(async (tx) => {
        const now = new Date();
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
            const sup = await tx.suppression.create({
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
            minted.push({ suppressionId: sup.id, entityId: row.externalId });
            // Falls through: an aged award has no plan (out of scope), but a
            // review still pending on it is closed just below.
          }

          // An award the age rule hides is out of the scorer's scope, and the
          // queue cannot confirm it (the decision route refuses: hidden_by_age).
          // Close any review still pending on it, or it sits there for good.
          if (
            CORROBORATION_HIDE_ENABLED &&
            existingRecencyHides.has(row.externalId) &&
            reviews.get(row.externalId)?.status === "pending"
          ) {
            const prior = reviews.get(row.externalId)!;
            await tx.grantAttributionReview.updateMany({
              where: { grantExternalId: row.externalId, status: "pending" },
              data: { status: "withdrawn", decidedByCwid: SYSTEM_RESCORED, decidedAt: now, lastSeenAt: now },
            });
            reviews.set(row.externalId, { status: "withdrawn", evidenceKey: prior.evidenceKey });
            tally.review.withdraw++;
            continue;
          }

          const entry = plans.get(row.externalId);
          if (!entry) continue;
          const { plan, scored } = entry;
          // A curator may have sent this award back to review since the state
          // was read: their pending review stands (rule 1b), so this run
          // neither lifts its hide nor withdraws it.
          if ((plan.revokeHideId || plan.review === "withdraw") && reviews.get(row.externalId)?.status !== "pending") {
            const live = await tx.grantAttributionReview.findUnique({
              where: { grantExternalId: row.externalId },
              select: { status: true, decidedByCwid: true },
            });
            if (live && isReopenedFromDecision(live)) continue;
          }
          const queued = scored?.score.band === "queue";

          if (plan.mintHide && policy !== "none") {
            const sup = await tx.suppression.create({
              data: {
                entityType: "grant",
                entityId: row.externalId,
                reason: queued ? QUEUED_REASON : UNVERIFIED_REASON[policy],
                createdBy: SYSTEM_UNVERIFIED,
              },
            });
            unverified.set(row.externalId, { activeId: sup.id, humanRevoked: false });
            minted.push({ suppressionId: sup.id, entityId: row.externalId });
            if (queued) tally.minted.queue++;
            else tally.minted[policy]++;
          }

          if (plan.revokeHideId) {
            // A SYSTEM revoke, recorded as such on the row (revokedBy) and in
            // the audit log (actor), so it is never mistaken for a person's.
            const res = await tx.suppression.updateMany({
              where: { id: plan.revokeHideId, revokedAt: null },
              data: { revokedAt: now, revokedBy: SYSTEM_RESCORED, searchReflectedAt: null },
            });
            if (res.count === 1) {
              await appendAuditRow(tx, {
                actorCwid: SYSTEM_RESCORED,
                impersonatedCwid: null,
                targetEntityType: "grant",
                targetEntityId: row.externalId,
                action: "suppression_revoke",
                fieldsChanged: null,
                beforeValues: { suppression_id: plan.revokeHideId },
                afterValues: {
                  revoked_by: SYSTEM_RESCORED,
                  revoked_at: now.toISOString(),
                  score: scored?.score.score ?? null,
                  band: "show",
                },
                ts: now,
                requestId: null,
              });
              unverified.set(row.externalId, { activeId: null, humanRevoked: false });
              minted.push({ suppressionId: plan.revokeHideId, entityId: row.externalId });
              tally.revoked++;
              if (scored) tally.recovered++;
            }
          }

          if (plan.review !== "none") {
            const scoreFields = scored
              ? {
                  score: scored.score.score,
                  band: scored.score.band,
                  cues: scored.score.reasons as unknown as Prisma.InputJsonValue,
                  award: scored.award,
                  scoredAt: now,
                  lastSeenAt: now,
                }
              : { band: "show", lastSeenAt: now };
            const prior = reviews.get(row.externalId);
            if (plan.review === "create" && scored) {
              await tx.grantAttributionReview.create({
                data: {
                  cwid,
                  grantExternalId: row.externalId,
                  score: scored.score.score,
                  band: scored.score.band,
                  cues: scored.score.reasons as unknown as Prisma.InputJsonValue,
                  evidenceKey: scored.key,
                  award: scored.award,
                  scoredAt: now,
                },
              });
              reviews.set(row.externalId, { status: "pending", evidenceKey: scored.key });
            } else if (plan.review === "refresh" && scored) {
              await tx.grantAttributionReview.updateMany({
                where: { grantExternalId: row.externalId, status: "pending" },
                data: { ...scoreFields, evidenceKey: scored.key },
              });
            } else if (plan.review === "reopen" && scored && prior) {
              // Conditional on the status read at load: a curator who decided
              // in the meantime wins, and this matches nothing. Reopening a
              // CURATOR decision keeps its fields (who, when, why, effects):
              // they mark the row as reopened-from-decision, so later runs
              // leave it pending (`planAward` rule 1b), and the card can say
              // what was decided. A withdrawn review re-queued starts clean.
              const fromDecision = prior.status === "confirmed" || prior.status === "rejected";
              await tx.grantAttributionReview.updateMany({
                where: { grantExternalId: row.externalId, status: prior.status },
                data: {
                  ...scoreFields,
                  evidenceKey: scored.key,
                  status: "pending",
                  ...(fromDecision
                    ? {}
                    : {
                        decidedByCwid: null,
                        decidedAt: null,
                        rejectionReason: null,
                        decisionEffects: Prisma.DbNull,
                      }),
                  reopenedAt: now,
                },
              });
              reviews.set(row.externalId, {
                status: "pending",
                evidenceKey: scored.key,
                reopenedFromDecision: fromDecision,
              });
            } else if (plan.review === "withdraw") {
              await tx.grantAttributionReview.updateMany({
                where: { grantExternalId: row.externalId, status: "pending" },
                data: {
                  ...scoreFields,
                  status: "withdrawn",
                  decidedByCwid: SYSTEM_RESCORED,
                  decidedAt: now,
                },
              });
              reviews.set(row.externalId, {
                status: "withdrawn",
                evidenceKey: prior?.evidenceKey ?? "",
              });
            }
            tally.review[plan.review]++;
          }
        }
      });
      grantsUpserted += toWrite.length;
    }

    // #3071 — the scorer's verdict on each award judged, for the queue's strip
    // and report 14. A scholar judged this run replaces their rows; one whose
    // profiles are all publication-matched ("none") is no longer judged at all.
    // Unjudged runs (no PMIDs, fetch error) leave last week's rows standing.
    if (judged !== null || (attribution && policy === "none")) {
      const now = new Date();
      await db.write.$transaction(async (tx) => {
        await tx.grantAttributionScore.deleteMany({
          where: { cwid, grantExternalId: { notIn: [...(judged?.keys() ?? [])] } },
        });
        for (const [externalId, sc] of judged ?? []) {
          const data = {
            band: sc.score.band,
            score: sc.score.score,
            cues: sc.score.reasons as unknown as Prisma.InputJsonValue,
            evidenceKey: sc.key,
            award: sc.award,
            reporterName: sc.reporterName,
            scoredAt: now,
          };
          await tx.grantAttributionScore.upsert({
            where: { grantExternalId: externalId },
            create: { grantExternalId: externalId, cwid, ...data },
            update: data,
          });
        }
      });
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

  if (attribution) {
    // Scholars no longer linked to any NIH profile are no longer judged.
    await db.write.grantAttributionScore.deleteMany({
      where: { cwid: { notIn: [...profilesByCwid.keys()] } },
    });
    // A run that judged no one (RePORTER down) records no totals: a row of
    // zeros would read as the latest week on the strip and report 14.
    if (tally.scholars > 0) {
      await db.write.grantAttributionRun.create({
        data: {
          ranAt: new Date(),
          scholars: tally.scholars,
          show: tally.band.show,
          hide: tally.band.hide,
          queue: tally.band.queue,
          recovered: tally.recovered,
          cues: tally.cue as Prisma.InputJsonValue,
        },
      });
    } else {
      console.warn("#3071 attribution: no scholar was scored; run totals not recorded.");
    }
  }

  // Minted hides AND system revokes: both are index-relevant transitions.
  await reflectGrantSuppressions(minted);

  const unverifiedTotal =
    tally.minted["wcm-or-publication"] + tally.minted["publication-only"] + tally.minted.queue;
  console.log(
    `\nMaterialized ${grantsUpserted} net-new RePORTER grants across ` +
      `${processed} scholars ` +
      `(${minted.length - unverifiedTotal - tally.revoked} default-hidden by age, ` +
      `${skippedNoDate} skipped: no dates, ${errored} fetch errors).`,
  );
  if (CORROBORATION_HIDE_ENABLED) {
    // Aggregates only: never a cwid, name or award number.
    const cues = Object.entries(tally.cue)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(
      `#3071 attribution: scored show=${tally.band.show} hide=${tally.band.hide} ` +
        `queue=${tally.band.queue} (conflict=${tally.rule.conflict}); newly hidden ${unverifiedTotal} ` +
        `(${tally.minted["wcm-or-publication"]} name-only, ${tally.minted["publication-only"]} ` +
        `grant-join, ${tally.minted.queue} queued); revoked ${tally.revoked}` +
        `${allowRevoke ? "" : " (revoking off this run)"}; reviews created ` +
        `${tally.review.create}, refreshed ${tally.review.refresh}, reopened ` +
        `${tally.review.reopen}, withdrawn ${tally.review.withdraw}; scholars left ` +
        `unjudged: ${tally.skippedNoPmids} with no confirmed PMIDs, ` +
        `${tally.skippedFetchError} with a publication fetch error.`,
    );
    console.log(`#3071 attribution cues fired: ${cues || "none"}.`);
  }

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
//
// `disconnect()`, not `db.write.$disconnect()`: reflectGrantSuppressions reads
// through `db.read`. This step routes to the `baseUnit` task def, the one that
// injects DATABASE_URL_RO, so the reader really is a second mariadb pool here —
// leaving it open holds the event loop open after main() resolves.
withEtlRun("ReporterGrants", main)
  .then(() => disconnect())
  .catch(async (err) => {
    console.error(err);
    await disconnect();
    process.exit(1);
  });
