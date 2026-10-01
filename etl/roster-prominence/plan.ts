/**
 * Pure half of `etl:roster-prominence` (#2596): diff tonight's scores against
 * what `Scholar` holds, and refuse a thin result before anything is written.
 * No DB edge, so it is unit-testable; `index.ts` owns the reads and the write.
 */
import { assertPruneVolume, assertSourceVolume } from "@/lib/etl-guard";
import { LEADERSHIP_TIER, type ProminenceEntry } from "@/lib/api/prominence";

/** What `Scholar` holds today, for every row (deleted ones included). */
export type StoredProminence = {
  cwid: string;
  rosterProminence: number | null;
  rosterLeadershipTier: number | null;
};

export type ProminenceUpdate = {
  cwid: string;
  rosterProminence: number | null;
  rosterLeadershipTier: number | null;
};

/** A stored score this much higher than tonight's counts as a drop. log1p
 *  units: 0.5 is roughly a 40% fall in scored publications for one scholar. */
export const SCORE_DROP_EPSILON = 0.5;

/** Guard thresholds, in percent. Nightly drift is small and mostly upward
 *  (publications and grants accumulate), so a large fall is a thin input. */
export const MAX_SCORED_DROP_PCT = 20;
export const MAX_LEADER_DROP_PCT = 20;
export const MAX_SCORE_DROPS_PCT = 10;
export const MAX_GRANT_LOSS_PCT = 20;
export const MAX_RANKED_DROP_PCT = 20;

/** The tiers `classifyLeadership` can award from an `org_unit_role_assignment`
 *  row (department chair/director, center director, division chief). Every
 *  other tier (deanery, endowed, program director, academic rank) comes from
 *  title text alone, so an emptied role table cannot move it. */
export const ROLE_TIERS: ReadonlySet<number> = new Set([
  LEADERSHIP_TIER.chair,
  LEADERSHIP_TIER.institutionalCenterDirector,
  LEADERSHIP_TIER.divisionChief,
]);

/** A score fall this large, on a scholar with no grant score tonight, reads as
 *  lost grants: just under one PI grant's weight (0.5 · ln 2 ≈ 0.35). */
export const GRANT_LOSS_EPSILON = 0.3;

/**
 * Refuse to write when tonight's result is implausibly thin vs. what is stored:
 *
 *  - `roster-prominence:scholars`  — fewer scholars scored (a short scholar read).
 *  - `roster-prominence:leaders`   — too many held ROLE-tier leaders (`ROLE_TIERS`)
 *    demoted: a worse tier tonight, or a score fall over `SCORE_DROP_EPSILON`
 *    (the chair/chief weight lost while the title keeps the tier). An emptied
 *    `org_unit_role_assignment`. Title-only tiers are left out on purpose: they
 *    outnumber the role-backed leaders and would dilute a role wipe away.
 *  - `roster-prominence:score-drops` — too many scholars' scores FELL by more than
 *    `SCORE_DROP_EPSILON` (`scored_pub_count` wiped). Also trips on a weight
 *    tuned DOWN, deliberately: rerun with the bypass
 *    (docs/OPERATIONS-RUNBOOK.md, "Roster prominence").
 *  - `roster-prominence:grants`    — too many grant holders LOST their grant
 *    score: of the scholars with a grant score tonight plus those with none
 *    whose score fell over `GRANT_LOSS_EPSILON`, the latter share. An emptied
 *    `grant` table, which score-drops misses when grant holders are a small
 *    share of the roster. A weight tuned down can trip it too; same bypass.
 *  - `roster-prominence:ranked`    — far fewer scholars hold ANY tier below
 *    `none`: titles nulled by an ED run. Title text moves no score, so no
 *    other guard sees it, and the write would flatten every title rank to none.
 *
 * Every guard no-ops on a first run (nothing stored yet).
 */
export function assertRosterProminenceVolume(
  stored: readonly StoredProminence[],
  computed: ReadonlyMap<string, ProminenceEntry>,
): void {
  const held = stored.filter((s) => s.rosterProminence !== null);
  assertSourceVolume("roster-prominence:scholars", {
    incoming: computed.size,
    existing: held.length,
    maxDropPct: MAX_SCORED_DROP_PCT,
  });

  let comparable = 0;
  let dropped = 0;
  let roleLeaders = 0;
  let demoted = 0;
  let grantHolders = 0;
  let grantsLost = 0;
  for (const s of held) {
    const next = computed.get(s.cwid);
    if (!next) continue;
    comparable++;
    const fall = s.rosterProminence! - next.prominence;
    if (fall > SCORE_DROP_EPSILON) dropped++;
    const tier = s.rosterLeadershipTier;
    if (tier !== null && ROLE_TIERS.has(tier)) {
      roleLeaders++;
      if (next.leadershipTier > tier || fall > SCORE_DROP_EPSILON) demoted++;
    }
    if (next.grantScore > 0) grantHolders++;
    else if (fall > GRANT_LOSS_EPSILON) grantsLost++;
  }
  assertPruneVolume("roster-prominence:score-drops", {
    pruning: dropped,
    of: comparable,
    maxPct: MAX_SCORE_DROPS_PCT,
  });
  // The cohort guards run after score-drops, so a broad fall (pubs wiped) is
  // named for what it is rather than for whichever cohort it also thins.
  assertPruneVolume("roster-prominence:leaders", {
    pruning: demoted,
    of: roleLeaders,
    maxPct: MAX_LEADER_DROP_PCT,
  });
  assertPruneVolume("roster-prominence:grants", {
    pruning: grantsLost,
    of: grantHolders + grantsLost,
    maxPct: MAX_GRANT_LOSS_PCT,
  });
  const isRanked = (tier: number | null) => tier !== null && tier < LEADERSHIP_TIER.none;
  assertSourceVolume("roster-prominence:ranked", {
    incoming: [...computed.values()].filter((e) => isRanked(e.leadershipTier)).length,
    existing: held.filter((s) => isRanked(s.rosterLeadershipTier)).length,
    maxDropPct: MAX_RANKED_DROP_PCT,
  });
}

/**
 * The rows whose stored values differ from tonight's. A scholar absent from
 * `computed` (deleted) is cleared to NULL. Unchanged rows are skipped, so a
 * quiet night writes almost nothing.
 */
export function planRosterProminence(
  stored: readonly StoredProminence[],
  computed: ReadonlyMap<string, ProminenceEntry>,
): ProminenceUpdate[] {
  const updates: ProminenceUpdate[] = [];
  for (const s of stored) {
    const next = computed.get(s.cwid);
    const rosterProminence = next ? next.prominence : null;
    const rosterLeadershipTier = next ? next.leadershipTier : null;
    if (
      s.rosterProminence !== rosterProminence ||
      s.rosterLeadershipTier !== rosterLeadershipTier
    ) {
      updates.push({ cwid: s.cwid, rosterProminence, rosterLeadershipTier });
    }
  }
  return updates;
}
