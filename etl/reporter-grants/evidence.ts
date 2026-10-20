/**
 * #3071 — assemble the scorer's evidence for one (scholar, award) pair from
 * what the ETL has read. Pure: no DB, no fetch. `index.ts` and the read-only
 * replay probe both call it, so a replay measures exactly what the ETL scores.
 */
import { parseNihAward } from "@/lib/award-number";
import { namesMatch, reporterPiName } from "@/etl/nih-profile/resolver";
import {
  authorKey,
  coauthorCounts,
  doctoralYearRange,
  infoedOtherEvidence,
  middleInitialConflict,
  priorInstitutionMatch,
  scholarInitials,
  topicOverlap,
  type AttributionEvidence,
} from "./score";
import { isWcmOrg, type CorroborationPolicy, type GroupedProject } from "./transform";
import { parseFirstLast } from "@/etl/reporter-grants/v2";

type NamePair = { fullName: string; preferredName: string } | undefined;

/** The scholar-side facts every award of one scholar shares. */
export interface ScholarFacts {
  scholarNames: Array<string | null | undefined>;
  /** False when the scholar has no name on file: cue 1's decisive branch and
   *  cue 4 cannot fire, so the award may not be revoked on their silence. */
  named: boolean;
  initials: ReturnType<typeof scholarInitials>;
  coauthors: Map<string, number>;
  meshCounts: Map<string, number>;
  taggedPapers: number;
  educations: ReadonlyArray<{ degree: string; institution: string; year: number | null }>;
  doctoralYears: { earliest: number; latest: number } | null;
  profileIds: Set<number>;
  /** Confirmed PMIDs (strings, as `publication_author.pmid`). */
  pmids: Set<string>;
  /** ReCiter rejections; null when the mirror is unavailable (cue 2 off). */
  rejected: Set<string> | null;
}

export function buildScholarFacts(args: {
  names: NamePair;
  confirmed: ReadonlyArray<{
    pmid: string;
    publication: { authorsString: string | null; meshTerms: unknown };
  }>;
  educations: ReadonlyArray<{ degree: string; institution: string; year: number | null }>;
  profileIds: Iterable<number>;
  rejected: Set<string> | null;
}): ScholarFacts {
  const scholarNames = [args.names?.fullName, args.names?.preferredName];
  const { firstName, lastName } = parseFirstLast(args.names?.fullName ?? "");
  const coauthors = coauthorCounts(
    args.confirmed.map((c) => c.publication.authorsString),
    lastName ? authorKey(lastName, firstName) : null,
  );
  const meshCounts = new Map<string, number>();
  let taggedPapers = 0;
  for (const c of args.confirmed) {
    const terms = c.publication.meshTerms;
    if (!Array.isArray(terms)) continue;
    const uis = new Set<string>();
    for (const t of terms as Array<{ ui?: unknown }>) if (typeof t?.ui === "string") uis.add(t.ui);
    if (uis.size === 0) continue;
    taggedPapers++;
    for (const u of uis) meshCounts.set(u, (meshCounts.get(u) ?? 0) + 1);
  }
  return {
    scholarNames,
    named: scholarNames.some((n) => !!n && n.trim().length > 0),
    initials: scholarInitials(scholarNames),
    coauthors,
    meshCounts,
    taggedPapers,
    educations: args.educations,
    doctoralYears: doctoralYearRange(args.educations),
    profileIds: new Set(args.profileIds),
    pmids: new Set(args.confirmed.map((c) => c.pmid)),
    rejected: args.rejected,
  };
}

/** The first fiscal year this scholar held the award. `orgHistory` comes from
 *  the profile's own project-years (`pi_profile_ids`), so it is their tenure,
 *  not the project's start. */
export function firstHeldYear(
  orgHistory: ReadonlyArray<{ fiscalYear: number | null }>,
): number | null {
  const years = orgHistory.map((o) => o.fiscalYear).filter((y): y is number => y !== null);
  return years.length === 0 ? null : Math.min(...years);
}

export function buildAwardEvidence(args: {
  policy: CorroborationPolicy;
  facts: ScholarFacts;
  group: Pick<GroupedProject, "coreProjectNum" | "orgName" | "orgHistory" | "pis">;
  /** ReCiter's grant citation (`grant_publication`) ties a confirmed paper. */
  linkedViaGrantPub: boolean;
  /** PMIDs RePORTER links to the core. */
  linked: ReadonlySet<string>;
  /** The core was over RePORTER's offset cap and fetched restricted to the
   *  scholar's PMIDs, so `linked` is not its true size. */
  linkedRestricted: boolean;
  /** Other WCM investigators InfoEd lists on the core (this scholar removed). */
  infoedOthers: ReadonlyArray<{ role: string; names: ReadonlyArray<string | null | undefined> }>;
  meshUis: ReadonlyArray<string>;
}): { evidence: AttributionEvidence; revocable: boolean } {
  const { facts, group } = args;
  const ourPis = group.pis.filter((pi) => facts.profileIds.has(pi.profile_id));
  const coPis = group.pis.filter((pi) => !facts.profileIds.has(pi.profile_id));
  const linked = args.linked;
  const evidence: AttributionEvidence = {
    policy: args.policy,
    wcmOrgHistory: isWcmOrg(group.orgName),
    publicationLinked: args.linkedViaGrantPub || [...linked].some((p) => facts.pmids.has(p)),
    activityCode: parseNihAward(group.coreProjectNum).mechanism,
    startYear: firstHeldYear(group.orgHistory),
    infoedOther: infoedOtherEvidence({
      ourPis: ourPis.map((pi) => ({ first_name: pi.first_name, piName: reporterPiName(pi) })),
      coPiNames: coPis.map(reporterPiName).filter((n) => n.length > 0),
      scholarNames: facts.scholarNames,
      others: args.infoedOthers,
      namesMatch,
    }),
    rejected: facts.rejected
      ? {
          overlap: [...linked].filter((p) => facts.rejected!.has(p)).length,
          linkedTotal: args.linkedRestricted ? null : linked.size,
        }
      : null,
    doctoralYears: facts.doctoralYears,
    middleInitialConflict: middleInitialConflict(
      ourPis.map((pi) => pi.middle_name),
      facts.initials,
    ),
    priorInstitution: priorInstitutionMatch(group.orgHistory, facts.educations, isWcmOrg),
    coPiSharedPapers:
      coPis.length === 0
        ? null
        : Math.max(
            0,
            ...coPis.map((pi) => {
              const k = pi.last_name ? authorKey(pi.last_name, pi.first_name) : null;
              return k ? (facts.coauthors.get(k) ?? 0) : 0;
            }),
          ),
    topic: topicOverlap(args.meshUis, facts.meshCounts, facts.taggedPapers),
  };
  // A revoke lifts a hide on the strength of negative cues NOT firing. Cue 1's
  // decisive branch and cue 4 read the RePORTER PI on our profile and the
  // scholar's name: without either, their silence proves nothing.
  return { evidence, revocable: ourPis.length > 0 && facts.named };
}
