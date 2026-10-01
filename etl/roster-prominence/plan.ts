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

/**
 * Refuse to write when tonight's result is implausibly thin vs. what is stored:
 *
 *  - `roster-prominence:scholars`  — fewer scholars scored (a short scholar read).
 *  - `roster-prominence:leaders`   — fewer scholars in any leadership tier (an
 *    emptied `org_unit_role_assignment`, or titles nulled upstream).
 *  - `roster-prominence:score-drops` — too many scholars' scores FELL by more than
 *    `SCORE_DROP_EPSILON` (an emptied `grant` table, `scored_pub_count` wiped).
 *    Also trips on a weight tuned DOWN, deliberately: rerun with the bypass
 *    (docs/OPERATIONS-RUNBOOK.md, "Roster prominence").
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

  const isLeader = (tier: number | null) => tier !== null && tier < LEADERSHIP_TIER.none;
  assertSourceVolume("roster-prominence:leaders", {
    incoming: [...computed.values()].filter((e) => isLeader(e.leadershipTier)).length,
    existing: held.filter((s) => isLeader(s.rosterLeadershipTier)).length,
    maxDropPct: MAX_LEADER_DROP_PCT,
  });

  let comparable = 0;
  let dropped = 0;
  for (const s of held) {
    const next = computed.get(s.cwid);
    if (!next) continue;
    comparable++;
    if (s.rosterProminence! - next.prominence > SCORE_DROP_EPSILON) dropped++;
  }
  assertPruneVolume("roster-prominence:score-drops", {
    pruning: dropped,
    of: comparable,
    maxPct: MAX_SCORE_DROPS_PCT,
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
