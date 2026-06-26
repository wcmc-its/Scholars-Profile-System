/**
 * Pure decision logic for the RePORTER grants v2 PMID-overlap matcher
 * (`etl/reporter-grants/index.ts` v2 branch, gated on REPORTER_MATCH_V2).
 *
 * Kept side-effect-free (no DB, no fetch) so the orchestration in `index.ts`
 * stays thin and these bits are unit-testable in isolation — same split as
 * `transform.ts` for the v1 materializer. The ranking math itself
 * (`rankByPmidOverlap`) lives in `@/lib/edit/reporter-grants` and is already
 * tested there; this module owns the v2-specific wiring: cohort selection,
 * candidate grouping by profile_id, the write-outcome decision, the
 * idempotency reconcile, and the card-summary build. Spec §4.
 */
import { namesMatch, reporterPiName } from "../nih-profile/resolver";
import type { ReporterProject } from "../nih-profile/fetcher";
import {
  dedupeAgainstInfoEd,
  type InfoedGrant,
  type MatchResult,
} from "@/lib/edit/reporter-grants";
import { toReporterProject, type GroupedProject } from "./transform";

/** Split Scholar.fullName into the (first_name, last_name) pair NIH RePORTER's
 *  `pi_names` filter expects — strips postnominals after the first comma, takes
 *  the first whitespace token as first and the last as last. Mirrors the v1
 *  resolver's local helper (un-exported there because its module runs an ETL on
 *  import). Returns empty strings when fewer than two tokens. Pure. */
export function parseFirstLast(fullName: string): { firstName: string; lastName: string } {
  const noPostnom = fullName.split(/,\s*/)[0] ?? fullName;
  const tokens = noPostnom
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length < 2) return { firstName: "", lastName: "" };
  return { firstName: tokens[0]!, lastName: tokens[tokens.length - 1]! };
}

/** A scholar's possible NIH `profile_id`, grouped from the `pi_names` search
 *  results. `coreNums` feeds the publications fetch; `fullName` populates the
 *  card's candidate_name. Orgs/titles are not on the project search payload —
 *  they're fetched per winner from the grant detail at write time. */
export interface CandidateGroup {
  profileId: number;
  fullName: string;
  coreNums: string[];
}

/**
 * Group a scholar's `searchProjectsByPiName` results by NIH `profile_id`.
 *
 * A name search returns every project where a same-named PI appears, including
 * co-PIs who are *not* our scholar. We keep only the PIs whose RePORTER
 * full_name agrees with the scholar's name (`namesMatch`, the same recall guard
 * v1's `resolveByPiNameQuery` uses) and accumulate each such PI's
 * `core_project_num`s under their profile_id. The most complete (longest)
 * matching name wins for the display label. Pure. (Spec §4.2.)
 */
export function groupCandidatesByProfileId(
  scholarFullName: string,
  projects: ReporterProject[],
): CandidateGroup[] {
  const byProfile = new Map<number, { fullName: string; cores: Set<string> }>();
  for (const project of projects) {
    const core = project.core_project_num?.toUpperCase() ?? null;
    for (const pi of project.principal_investigators) {
      const piName = reporterPiName(pi);
      if (!piName || !namesMatch(piName, scholarFullName)) continue;
      const entry = byProfile.get(pi.profile_id);
      if (!entry) {
        byProfile.set(pi.profile_id, {
          fullName: piName,
          cores: new Set(core ? [core] : []),
        });
      } else {
        if (piName.length > entry.fullName.length) entry.fullName = piName;
        if (core) entry.cores.add(core);
      }
    }
  }
  return [...byProfile.entries()].map(([profileId, v]) => ({
    profileId,
    fullName: v.fullName,
    coreNums: [...v.cores],
  }));
}

/** The v2 cohort = active scholars *minus* anyone already in
 *  `person_nih_profile` (those are v1's path). The active/non-deleted filter
 *  happens in the DB query; this drops the already-resolved tail. Pure. (§4.1.) */
export function selectV2Cohort<T extends { cwid: string }>(
  active: T[],
  profiledCwids: Set<string>,
): T[] {
  return active.filter((s) => !profiledCwids.has(s.cwid));
}

/** A scholar can only be matched when they have ≥`min` trusted PMIDs to
 *  discriminate candidates against. `min` defaults to 1 (any PMID); raise it via
 *  REPORTER_MATCH_V2_MIN_PMIDS to trim the cohort to higher-yield scholars — the
 *  matcher needs PMIDs anyway and auto-lock needs K≥3, so very-low-PMID scholars
 *  rarely lock. `min` is floored at 1 so 0 trusted PMIDs always skips (§4.1,
 *  case #1). Pure. */
export function hasDiscriminator(trustedPmidCount: number, min = 1): boolean {
  return trustedPmidCount >= Math.max(1, min);
}

/**
 * Bound a single nightly run's RePORTER call volume (handoff #1 runtime guard).
 * The full v2 cohort × ~3 RePORTER calls/scholar at 1 req/s runs many hours —
 * too long for the nightly window. This slices a deterministic, day-rotating
 * window of at most `maxPerRun` scholars: sort the cohort by cwid, then take the
 * `dayOfYear % numWindows`-th contiguous block. Every scholar is covered over
 * ceil(len/maxPerRun) nights with no persisted cursor. `maxPerRun ≤ 0`, or a
 * cohort that already fits, ⇒ no bound (whole cohort). Pure.
 *
 * ponytail: cursor-free day-rotation, not a persisted cursor. A still-pending
 * scholar is re-scanned on its next window turn (idempotent — just extra
 * RePORTER calls). Upgrade path: a persisted EtlState cursor if exact resume
 * (skip already-scanned) ever matters.
 */
export function selectRunWindow<T extends { cwid: string }>(
  cohort: T[],
  maxPerRunRaw: number,
  dayOfYear: number,
): T[] {
  const maxPerRun = Math.trunc(maxPerRunRaw); // integer window; a fractional cap would misalign slices
  if (maxPerRun <= 0 || cohort.length <= maxPerRun) return cohort;
  const sorted = [...cohort].sort((a, b) => (a.cwid < b.cwid ? -1 : a.cwid > b.cwid ? 1 : 0));
  const numWindows = Math.ceil(sorted.length / maxPerRun);
  const windowIndex = ((dayOfYear % numWindows) + numWindows) % numWindows;
  const start = windowIndex * maxPerRun;
  return sorted.slice(start, start + maxPerRun);
}

/** What a ranked match implies for the candidate ledger, before reconciling with
 *  any existing row. */
export type V2WriteOutcome =
  | { kind: "autolock"; profileId: number }
  | { kind: "pending"; profileId: number }
  | { kind: "none" };

/**
 * Translate a `rankByPmidOverlap` result into a write outcome (§4.4/§4.5):
 *   - autoLock set (K≥3 + separation)  → auto-lock the winner.
 *   - else a separated suggestion (K=2) → pending proposal for the top one.
 *   - else                              → nothing (ambiguous / recall miss).
 * Pure.
 */
export function decideWriteOutcome(match: MatchResult): V2WriteOutcome {
  if (match.autoLock !== null) {
    return { kind: "autolock", profileId: match.autoLock };
  }
  const top = match.suggestions[0];
  if (top) return { kind: "pending", profileId: top.profileId };
  return { kind: "none" };
}

/** What to actually do given the existing ledger row's status for this
 *  (cwid, profileId). */
export type V2WriteAction =
  | { kind: "skip" }
  | { kind: "autolock-confirm" }
  | { kind: "pending-upsert" };

/**
 * Reconcile a write outcome with the existing ledger state (§4.6 idempotency):
 *   - `rejected` / `revoked` are terminal — never resurrected.
 *   - a human/system `confirmed` row is never overwritten by a system re-run.
 *   - otherwise (no row, or still `pending`) the outcome applies: an auto-lock
 *     confirms, a suggestion upserts/refreshes a pending row, `none` is a no-op.
 * Pure.
 */
export function reconcileWithExisting(
  outcome: V2WriteOutcome,
  existingStatus: string | undefined,
): V2WriteAction {
  if (existingStatus === "rejected" || existingStatus === "revoked") {
    return { kind: "skip" };
  }
  if (existingStatus === "confirmed") return { kind: "skip" };
  if (outcome.kind === "autolock") return { kind: "autolock-confirm" };
  if (outcome.kind === "pending") return { kind: "pending-upsert" };
  return { kind: "skip" };
}

/** One sample grant for the card's recognition list. */
export interface SampleGrant {
  title: string;
  startYear: number | null;
  endYear: number | null;
}

/** The card-summary fields persisted on a `ReporterProfileCandidate` row. */
export interface CandidateSummary {
  grantCount: number;
  candidateOrgs: string;
  sampleGrants: SampleGrant[];
}

const yearOf = (d: Date | null): number | null =>
  d ? d.getUTCFullYear() : null;

/**
 * Build the card summary for a written candidate from its grouped grant projects
 * (the v1 `groupProjectsByCore` output) and the scholar's InfoEd grants:
 *   - grantCount    = # net-new cores after InfoEd dedup (the card's headline).
 *   - candidateOrgs = comma-joined distinct grantee orgs (recognition aid).
 *   - sampleGrants  = up to 3 net-new awards, most-recent first.
 * Pure. (§5 model fields.)
 */
export function summarizeCandidateGrants(
  grouped: GroupedProject[],
  infoed: InfoedGrant[],
  sampleLimit = 3,
): CandidateSummary {
  const byCore = new Map(grouped.map((g) => [g.coreProjectNum.toUpperCase(), g]));
  const { netNew } = dedupeAgainstInfoEd(grouped.map(toReporterProject), infoed);
  const netNewGroups = netNew
    .map((p) => byCore.get(p.coreProjectNum.toUpperCase()))
    .filter((g): g is GroupedProject => !!g);

  const orgs = [...new Set(netNewGroups.map((g) => g.orgName).filter((o): o is string => !!o))];
  const sampleGrants = [...netNewGroups]
    .sort((a, b) => {
      const ae = a.endDate?.getTime() ?? 0;
      const be = b.endDate?.getTime() ?? 0;
      return be - ae;
    })
    .slice(0, sampleLimit)
    .map((g) => ({
      title: g.title?.trim() || `(untitled grant ${g.coreProjectNum})`,
      startYear: yearOf(g.startDate),
      endYear: yearOf(g.endDate),
    }));

  return { grantCount: netNewGroups.length, candidateOrgs: orgs.join(", "), sampleGrants };
}
