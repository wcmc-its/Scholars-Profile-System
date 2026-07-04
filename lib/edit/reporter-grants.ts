/**
 * NIH RePORTER historical-grant matching + dedup for the CV generator.
 *
 * The CV generator needs a complete grant list per scholar, but the InfoEd-sourced
 * `Grant` table only holds WCM-administered awards — missing prior-institution grants
 * (lateral recruits) and affiliate grants WCM never managed. NIH RePORTER fills that
 * gap, keyed to the investigator's eRA `profile_id` across institutions.
 *
 * This module owns the two pieces of non-trivial, validated logic:
 *   1. `rankByPmidOverlap` — resolve which RePORTER `profile_id` is a given scholar by
 *      intersecting each name-collision candidate's grant-linked PMIDs with the scholar's
 *      trusted PubMed set. (RePORTER exposes no email/ORCID — see the spec.)
 *   2. `dedupeAgainstInfoEd` — drop RePORTER grants already represented by an InfoEd row,
 *      including NIH phased-award siblings (UG3/UH3, K99/R00) which differ by activity code.
 *
 * Calibrated against 50 WCM scholars with ground-truth profile_ids (2026-06-26):
 * 0 wrong suggestions at every K from 1–5; a runner-up candidate never scored any PMID
 * overlap. Full method + evidence: docs/reporter-grants-matcher-spec.md.
 *
 * The RePORTER HTTP fetch and the Prisma-side profile_id resolution (person_nih_profile →
 * manual → this matcher) are wired by the CV generator (lib/edit/cv-export.ts), not here:
 * their shape follows that module's conventions, and this file stays pure + unit-testable.
 */

import { coreProjectNum } from "@/lib/award-number";

// Matcher thresholds (spec §5). Constants, not config — surface only if a real
// false-match appears. Validated: precision 100% at every K in [1,5].
export const K_AUTOLOCK = 3; // silent auto-lock floor (recall ~62%)
export const K_SUGGEST = 2; // show as ranked human-confirm suggestion (recall ~70%)
export const SEPARATION = 2; // winner must beat the runner-up by this factor

/** A RePORTER project (one fiscal year of one award). */
export interface ReporterProject {
  coreProjectNum: string; // e.g. "R01CA245678"
  awardNumber: string; // project_num, e.g. "5R01CA245678-03"
  orgName: string | null; // grantee org for this award
  fiscalYear: number | null;
  awardAmount: number | null;
  title: string | null;
}

/** An existing InfoEd-sourced Grant row, reduced to what dedup needs. InfoEd is
 *  WCM's system, so its grants are treated as WCM-org. */
export interface InfoedGrant {
  awardNumber: string | null;
}

/** A RePORTER profile_id candidate for a scholar, with its grant-linked PMIDs. */
export interface Candidate {
  profileId: number;
  fullName: string;
  orgs: string[];
  grantPmids: Set<number>;
}

export interface RankedCandidate {
  profileId: number;
  fullName: string;
  orgs: string[];
  overlap: number; // # grant-linked PMIDs shared with the scholar's pub set
  precision: number; // overlap / candidate's grant-linked PMID count
}

export interface MatchResult {
  /** profile_id confident enough to lock without review, else null. */
  autoLock: number | null;
  /** candidates worth showing for human confirmation (overlap ≥ K_SUGGEST). */
  suggestions: RankedCandidate[];
  /** full ranked list, as evidence. */
  ranked: RankedCandidate[];
}

/**
 * Rank name-collision candidates by how many of their grant-linked publications
 * appear in the scholar's trusted PubMed set. A same-name different person's grants
 * cite *their* papers, disjoint from ours, so overlap cleanly separates the real
 * person from collisions. Pure.
 */
export function rankByPmidOverlap(
  personPmids: Set<number>,
  candidates: Candidate[],
): MatchResult {
  const ranked: RankedCandidate[] = candidates
    .map((c) => {
      let overlap = 0;
      for (const pmid of c.grantPmids) if (personPmids.has(pmid)) overlap++;
      return {
        profileId: c.profileId,
        fullName: c.fullName,
        orgs: c.orgs,
        overlap,
        precision: c.grantPmids.size ? overlap / c.grantPmids.size : 0,
      };
    })
    .sort((a, b) => b.overlap - a.overlap);

  const top = ranked[0];
  const runnerUp = ranked[1]?.overlap ?? 0;
  // Floor runner-up at 1 so a lone candidate still needs ≥ K overlap, and a
  // 1-vs-0 split isn't treated as "infinitely separated".
  const beatsRunnerUp = (overlap: number) => overlap >= SEPARATION * Math.max(runnerUp, 1);

  const autoLock =
    top && top.overlap >= K_AUTOLOCK && beatsRunnerUp(top.overlap) ? top.profileId : null;
  const suggestions = ranked.filter((r) => r.overlap >= K_SUGGEST && beatsRunnerUp(r.overlap));
  return { autoLock, suggestions, ranked };
}

const isWcmOrg = (org: string | null | undefined): boolean => /weill|cornell/i.test(org ?? "");

/** NIH phased awards (UG3/UH3, K99/R00, R61/R33) share an IC prefix + serial but
 *  differ by activity code. `coreProjectNum` is activity(3) + IC-prefix(2) + serial,
 *  so dropping the leading activity code yields the phase-independent family key. */
const familyKey = (core: string): string => core.slice(3);

export interface DedupResult {
  /** RePORTER grants InfoEd does not already cover — the CV's net-new federal grants. */
  netNew: ReporterProject[];
  /** RePORTER grants already represented by an InfoEd row (InfoEd wins; richer). */
  dropped: ReporterProject[];
}

/**
 * Split RePORTER projects into net-new vs already-in-InfoEd. A project is a duplicate
 * when InfoEd has the exact core_project_num, OR a phased sibling of the same family
 * AND the RePORTER award is WCM-administered (InfoEd is WCM-only, so a same-family award
 * at another institution — e.g. a K99 held at a prior institution whose R00 is at WCM —
 * is a genuinely distinct CV line and is kept). Pure.
 */
export function dedupeAgainstInfoEd(
  projects: ReporterProject[],
  infoed: InfoedGrant[],
): DedupResult {
  const infoedCores = new Set<string>();
  const infoedFamilies = new Set<string>();
  for (const g of infoed) {
    const core = coreProjectNum(g.awardNumber);
    if (!core) continue;
    infoedCores.add(core);
    infoedFamilies.add(familyKey(core));
  }

  const netNew: ReporterProject[] = [];
  const dropped: ReporterProject[] = [];
  for (const p of projects) {
    const core = (p.coreProjectNum || "").toUpperCase();
    const isDuplicate =
      infoedCores.has(core) ||
      (core.length > 3 && isWcmOrg(p.orgName) && infoedFamilies.has(familyKey(core)));
    (isDuplicate ? dropped : netNew).push(p);
  }
  return { netNew, dropped };
}

/** Classify a net-new grant for CV labeling: prior-institution vs WCM history InfoEd
 *  dropped. Both are real value (InfoEd has a historical floor); the distinction only
 *  affects how the line is captioned. */
export function netNewLabel(p: ReporterProject): "prior-institution" | "wcm-historical" {
  return isWcmOrg(p.orgName) ? "wcm-historical" : "prior-institution";
}
