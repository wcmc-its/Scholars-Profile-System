/**
 * Issue #90 — resolve NIH RePORTER `profile_id` to a WCM `cwid`.
 *
 * Two-tier resolution:
 *
 *   1. Grant-join (primary, high confidence). For each NIH RePORTER
 *      project we know the core_project_num. We have Grant rows in our
 *      Postgres for the same core_project_num — one row per WCM scholar
 *      attributed to the project. Pair the project's PIs with those
 *      grant rows: the Grant row's `cwid` is the answer.
 *
 *   2. Name-match fallback (lower confidence). For PIs that don't pair
 *      cleanly via grant-join — typically because the awardNumber on the
 *      WCM Grant row didn't parse to the project's core_project_num —
 *      fuzzy-match the RePORTER `full_name` against scholars who have at
 *      least one NIH grant in our DB.
 *
 * Resolution source is recorded on each row of `person_nih_profile` so
 * the curator review queue can surface low-confidence matches without
 * re-running the resolver.
 */
import type { ReporterPI, ReporterProject } from "./fetcher";

export type ResolutionSource = "grant_join_contact" | "grant_join_pi" | "name_match";

export type ResolvedObservation = {
  profileId: number;
  cwid: string;
  fullName: string;
  projectEndDate: string | null;
  resolutionSource: ResolutionSource;
};

/** PI rows on a project we own in Postgres. Caller passes one per
 *  core_project_num so the resolver doesn't need DB access. */
export type GrantRowForResolution = {
  cwid: string;
  /** "PI" | "PI-Subaward" | "Co-PI" | "Co-I" | etc. */
  role: string;
  /** Scholar.fullName at the time the resolver runs — used for the
   *  name-match step. */
  fullName: string;
};

/** Normalized name tokens: lowercased, punctuation stripped, dropped
 *  postnominals, kept order-insensitive. Exposed for testing. */
export function nameTokens(name: string): Set<string> {
  // Drop postnominal segments after the first comma ("Smith, MD, PhD").
  const noPostnom = name.split(/,\s*/)[0] ?? name;
  // Keep alphanumerics and hyphen-glued surnames, drop punctuation.
  const cleaned = noPostnom
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim();
  if (cleaned.length === 0) return new Set();
  return new Set(cleaned.split(/\s+/).filter((t) => t.length > 0));
}

/** A PI's full_name matches a candidate's fullName when their last token
 *  matches and at least one other token matches (covers `J A Smith` vs
 *  `John A Smith` vs `John Adam Smith` without false-firing on
 *  `Jane Smith` vs `John Smith`). Initials count: a one-letter token
 *  matches the first letter of any other-side token. */
export function namesMatch(a: string, b: string): boolean {
  const at = Array.from(nameTokens(a));
  const bt = Array.from(nameTokens(b));
  if (at.length === 0 || bt.length === 0) return false;
  // Last token comparison — last names need to match exactly (after
  // hyphen-collapse). "diaz-meco" matches "diaz-meco" but not "meco".
  const aLast = at[at.length - 1]!;
  const bLast = bt[bt.length - 1]!;
  if (aLast !== bLast) return false;
  // Beyond the last name, require ≥1 additional token match. Initials
  // count: a single-character token matches the first character of any
  // multi-character token on the other side.
  const aRest = at.slice(0, -1);
  const bRest = bt.slice(0, -1);
  for (const x of aRest) {
    for (const y of bRest) {
      if (x === y) return true;
      if (x.length === 1 && y.startsWith(x)) return true;
      if (y.length === 1 && x.startsWith(y)) return true;
    }
  }
  return false;
}

/** Treat "PI" / "PI-Subaward" / "Co-PI" as PI-level for matching
 *  purposes. Multi-PI projects in InfoEd surface co-PIs as Co-PI rows;
 *  RePORTER lists every multi-PI in `principal_investigators[]`. */
function isPiRole(role: string): boolean {
  return role === "PI" || role === "PI-Subaward" || role === "Co-PI";
}

function reporterPiName(pi: ReporterPI): string {
  if (pi.full_name && pi.full_name.trim()) return pi.full_name;
  return [pi.first_name, pi.middle_name, pi.last_name]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join(" ");
}

/** Resolve a project's PIs to cwids via grant-join. Returns one
 *  observation per (profile_id, cwid) pair successfully matched. PIs
 *  that don't pair are returned as `unresolved` so the caller can run
 *  the name-match fallback against the broader pool. */
export function resolveProjectGrantJoin(
  project: ReporterProject,
  grants: GrantRowForResolution[],
): {
  observations: ResolvedObservation[];
  unresolved: ReporterPI[];
} {
  const observations: ResolvedObservation[] = [];
  const unresolved: ReporterPI[] = [];
  if (project.principal_investigators.length === 0) return { observations, unresolved };

  // Pool of candidate cwids on this project (PI-level roles only).
  const candidates = grants.filter((g) => isPiRole(g.role));
  const used = new Set<string>(); // cwids already paired on this project
  // Single PI-level candidate covers >90% of projects — use the cwid
  // for the contact PI directly.
  const contactCwid =
    candidates.length === 1
      ? candidates[0]!.cwid
      : candidates.find((g) => g.role === "PI" || g.role === "PI-Subaward")?.cwid ?? null;

  for (const pi of project.principal_investigators) {
    const piName = reporterPiName(pi);
    let cwid: string | null = null;
    let source: ResolutionSource | null = null;

    if (pi.is_contact_pi && contactCwid && !used.has(contactCwid)) {
      cwid = contactCwid;
      source = "grant_join_contact";
    } else {
      // Name-match against any unused PI-level grant row on this project.
      const match = candidates.find(
        (c) => !used.has(c.cwid) && namesMatch(piName, c.fullName),
      );
      if (match) {
        cwid = match.cwid;
        source = "grant_join_pi";
      }
    }

    if (cwid && source) {
      used.add(cwid);
      observations.push({
        profileId: pi.profile_id,
        cwid,
        fullName: piName,
        projectEndDate: project.project_end_date,
        resolutionSource: source,
      });
    } else {
      unresolved.push(pi);
    }
  }

  return { observations, unresolved };
}

/** Name-match an unresolved PI against the broader pool of scholars
 *  with at least one NIH grant. Returns the cwid when exactly one
 *  candidate matches; null on zero or multiple matches (ambiguity is a
 *  silent skip — better unresolved than wrong). */
export function resolveByNameFallback(
  pi: ReporterPI,
  pool: GrantRowForResolution[],
): string | null {
  const piName = reporterPiName(pi);
  if (!piName) return null;
  const matches = new Set<string>();
  for (const candidate of pool) {
    if (namesMatch(piName, candidate.fullName)) matches.add(candidate.cwid);
  }
  if (matches.size === 1) return Array.from(matches)[0]!;
  return null;
}

/** Given a stream of (profile_id, cwid) observations, pick the
 *  preferred mapping for each cwid. When a scholar has more than one
 *  profile_id (rare), the one tied to the most recent project end-date
 *  wins. Returns one row per (cwid, profile_id) pair so callers can
 *  upsert the full set and update is_preferred per cwid. */
export function aggregatePreferred(observations: ResolvedObservation[]): Array<{
  cwid: string;
  profileId: number;
  isPreferred: boolean;
  resolutionSource: ResolutionSource;
}> {
  // Per (cwid, profileId), pick the strongest resolution source and
  // keep the latest project_end_date so we can break is_preferred ties.
  const sourceRank: Record<ResolutionSource, number> = {
    grant_join_contact: 0,
    grant_join_pi: 1,
    name_match: 2,
  };
  const byPair = new Map<
    string,
    {
      cwid: string;
      profileId: number;
      bestSource: ResolutionSource;
      latestEnd: string;
    }
  >();
  for (const obs of observations) {
    const key = `${obs.cwid}::${obs.profileId}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, {
        cwid: obs.cwid,
        profileId: obs.profileId,
        bestSource: obs.resolutionSource,
        latestEnd: obs.projectEndDate ?? "0000-00-00",
      });
      continue;
    }
    if (sourceRank[obs.resolutionSource] < sourceRank[existing.bestSource]) {
      existing.bestSource = obs.resolutionSource;
    }
    if ((obs.projectEndDate ?? "0000-00-00") > existing.latestEnd) {
      existing.latestEnd = obs.projectEndDate ?? existing.latestEnd;
    }
  }

  // For each cwid, pick the profile_id with the latest end-date (then
  // strongest source as tiebreaker) as is_preferred.
  const byCwid = new Map<string, { profileId: number; latestEnd: string; bestSource: ResolutionSource }[]>();
  for (const v of byPair.values()) {
    const arr = byCwid.get(v.cwid) ?? [];
    arr.push({ profileId: v.profileId, latestEnd: v.latestEnd, bestSource: v.bestSource });
    byCwid.set(v.cwid, arr);
  }

  const out: Array<{
    cwid: string;
    profileId: number;
    isPreferred: boolean;
    resolutionSource: ResolutionSource;
  }> = [];
  for (const [cwid, list] of byCwid.entries()) {
    list.sort((a, b) => {
      if (a.latestEnd !== b.latestEnd) return a.latestEnd < b.latestEnd ? 1 : -1;
      return sourceRank[a.bestSource] - sourceRank[b.bestSource];
    });
    list.forEach((v, i) => {
      out.push({
        cwid,
        profileId: v.profileId,
        isPreferred: i === 0,
        resolutionSource: v.bestSource,
      });
    });
  }
  return out;
}
