/**
 * Cross-sectional "standings" over a SINGLE rank snapshot — the rival-benchmark
 * companion to `rank-basket.ts`'s temporal before/after diff.
 *
 * Where `diffSnapshots` answers "did WCM move between two dates", this answers
 * "at one point in time, how does WCM's research-profiles platform stack up
 * against peer institutions' platforms for funder-style expert queries". It
 * reads the per-(query, target) placements a snapshot already records, groups
 * targets into institutions (or platforms), and reports share-of-voice.
 *
 * Honest framing (see docs/seo-rank-tracking.md): broad expert queries are
 * nationally competitive, so these are RELATIVE standings, never "we're #1".
 *
 * Everything here is pure and network-free — unit-tested without API credits.
 */

import type { BasketTarget, RankSnapshot, SnapshotRow } from "./rank-basket";

/** Which surfaces count toward the standings. */
export type SurfaceFilter = "research-profiles" | "clinical" | "all";

/**
 * Query slice. "flagship" = curated expert queries (`flagship` flag); "matched"
 * = name queries carrying a `matchGroup`; the rest map to a `QueryType`.
 */
export type QuerySegment = "all" | "expert" | "topical" | "branded" | "flagship" | "matched";

/** A set of targets aggregated under one row of the standings table. */
export interface RankGroup {
  /** Group id, e.g. institution "WCM" or platform "Elsevier Pure". */
  key: string;
  label: string;
  platform?: string;
  /** Member target keys (an institution may own several: scholars + vivo). */
  targetKeys: string[];
}

/** Aggregate metrics for one group over the selected query segment. */
export interface GroupStanding {
  key: string;
  label: string;
  platform?: string;
  /** Queries considered (the whole selected segment). */
  queries: number;
  /** Queries where the group appeared anywhere in the fetched window. */
  appeared: number;
  top3: number;
  top10: number;
  /** Median best position among queries where it appeared (null if it never did). */
  medianBest: number | null;
  /** Queries where this group had the lowest position (ties shared). */
  wins: number;
  /** Queries where this group was STRICTLY best (no tie). */
  soleWins: number;
}

/** A group's best placement for one query: lowest position across its targets. */
export interface GroupPlacement {
  position: number | null;
  /** Which member target produced the best hit (e.g. "wcm-new" vs "wcm-vivo"). */
  targetKey: string | null;
  url: string | null;
}

const RP_DEFAULT: NonNullable<BasketTarget["surfaceType"]> = "research-profiles";

function surfaceOf(t: BasketTarget): NonNullable<BasketTarget["surfaceType"]> {
  return t.surfaceType ?? RP_DEFAULT;
}

function inSurface(t: BasketTarget, surface: SurfaceFilter): boolean {
  return surface === "all" || surfaceOf(t) === surface;
}

/** Group targets by institution (`institution` field, falling back to `key`). */
export function groupByInstitution(
  targets: BasketTarget[],
  surface: SurfaceFilter = "research-profiles",
): RankGroup[] {
  const out = new Map<string, RankGroup>();
  for (const t of targets) {
    if (!inSurface(t, surface)) continue;
    const key = t.institution ?? t.key;
    const g = out.get(key) ?? { key, label: t.institution ?? t.label, platform: t.platform, targetKeys: [] };
    g.targetKeys.push(t.key);
    if (!g.platform && t.platform) g.platform = t.platform;
    out.set(key, g);
  }
  return [...out.values()];
}

/** Group targets by platform software (for "which platform out-SEOs which"). */
export function groupByPlatform(
  targets: BasketTarget[],
  surface: SurfaceFilter = "research-profiles",
): RankGroup[] {
  const out = new Map<string, RankGroup>();
  for (const t of targets) {
    if (!inSurface(t, surface)) continue;
    const key = t.platform ?? "(unlabeled)";
    const g = out.get(key) ?? { key, label: key, platform: t.platform, targetKeys: [] };
    g.targetKeys.push(t.key);
    out.set(key, g);
  }
  return [...out.values()];
}

/** Lowest (best) placement for `targetKeys` in one snapshot row. */
export function bestPlacement(row: SnapshotRow, targetKeys: string[]): GroupPlacement {
  let best: GroupPlacement = { position: null, targetKey: null, url: null };
  for (const p of row.placements) {
    if (!targetKeys.includes(p.targetKey)) continue;
    if (p.position === null) continue;
    if (best.position === null || p.position < best.position) {
      best = { position: p.position, targetKey: p.targetKey, url: p.url };
    }
  }
  return best;
}

export function queryInSegment(row: SnapshotRow, segment: QuerySegment): boolean {
  switch (segment) {
    case "all":
      return true;
    case "flagship":
      return row.type === "expert" && row.flagship === true;
    case "matched":
      return row.type === "branded" && row.matchGroup != null;
    default:
      return row.type === segment;
  }
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Compute standings for a set of groups over a query segment. Each group's
 * position for a query is the lowest position across its member targets; a
 * "win" is the lowest position among all groups for that query (ties shared,
 * `soleWins` counts only strict wins). Sorted by wins desc, then median asc.
 */
export function computeStandings(
  snapshot: RankSnapshot,
  groups: RankGroup[],
  segment: QuerySegment = "all",
): GroupStanding[] {
  const rows = snapshot.rows.filter((r) => queryInSegment(r, segment));
  const positions = new Map<string, number[]>(); // present-only positions
  const queries = new Map<string, number>();
  const wins = new Map<string, number>();
  const soleWins = new Map<string, number>();
  for (const g of groups) {
    positions.set(g.key, []);
    queries.set(g.key, 0);
    wins.set(g.key, 0);
    soleWins.set(g.key, 0);
  }

  for (const row of rows) {
    const perGroup = groups.map((g) => ({ g, pos: bestPlacement(row, g.targetKeys).position }));
    for (const { g, pos } of perGroup) {
      queries.set(g.key, queries.get(g.key)! + 1);
      if (pos !== null) positions.get(g.key)!.push(pos);
    }
    const finite = perGroup.filter((x): x is { g: RankGroup; pos: number } => x.pos !== null);
    if (finite.length === 0) continue;
    const min = Math.min(...finite.map((x) => x.pos));
    const winners = finite.filter((x) => x.pos === min);
    for (const w of winners) wins.set(w.g.key, wins.get(w.g.key)! + 1);
    if (winners.length === 1) soleWins.set(winners[0].g.key, soleWins.get(winners[0].g.key)! + 1);
  }

  return groups
    .map((g) => {
      const present = positions.get(g.key)!;
      return {
        key: g.key,
        label: g.label,
        platform: g.platform,
        queries: queries.get(g.key)!,
        appeared: present.length,
        top3: present.filter((p) => p <= 3).length,
        top10: present.filter((p) => p <= 10).length,
        medianBest: median(present),
        wins: wins.get(g.key)!,
        soleWins: soleWins.get(g.key)!,
      };
    })
    .sort((a, b) => b.wins - a.wins || (a.medianBest ?? Infinity) - (b.medianBest ?? Infinity));
}

// ── per-query head-to-head ────────────────────────────────────────────────

export interface HeadToHeadRow {
  id: string;
  query: string;
  /** The home institution's best placement (surface + url + position). */
  home: GroupPlacement;
  /** Best rival group label + position, or null if no rival appeared. */
  bestRival: { label: string; position: number } | null;
  /** "home" | "rival" | "tie" | "none" */
  winner: "home" | "rival" | "tie" | "none";
}

function findGroup(groups: RankGroup[], key: string): RankGroup | undefined {
  return groups.find((g) => g.key === key);
}

/** One row per query: home group vs its best rival group. */
export function headToHead(
  snapshot: RankSnapshot,
  groups: RankGroup[],
  homeKey: string,
  segment: QuerySegment = "all",
): HeadToHeadRow[] {
  const home = findGroup(groups, homeKey);
  const rivals = groups.filter((g) => g.key !== homeKey);
  const rows = snapshot.rows.filter((r) => queryInSegment(r, segment));
  return rows.map((row) => {
    const homePlace = home ? bestPlacement(row, home.targetKeys) : { position: null, targetKey: null, url: null };
    let bestRival: { label: string; position: number } | null = null;
    for (const g of rivals) {
      const pos = bestPlacement(row, g.targetKeys).position;
      if (pos === null) continue;
      if (!bestRival || pos < bestRival.position) bestRival = { label: g.label, position: pos };
    }
    let winner: HeadToHeadRow["winner"] = "none";
    if (homePlace.position !== null || bestRival) {
      if (homePlace.position === null) winner = "rival";
      else if (!bestRival) winner = "home";
      else if (homePlace.position < bestRival.position) winner = "home";
      else if (homePlace.position > bestRival.position) winner = "rival";
      else winner = "tie";
    }
    return { id: row.id, query: row.query, home: homePlace, bestRival, winner };
  });
}

/** Queries where a rival ranks top-`threshold` but home does not — the gap list. */
export function gapList(
  snapshot: RankSnapshot,
  groups: RankGroup[],
  homeKey: string,
  segment: QuerySegment = "all",
  threshold = 10,
): HeadToHeadRow[] {
  return headToHead(snapshot, groups, homeKey, segment).filter(
    (r) =>
      r.bestRival !== null &&
      r.bestRival.position <= threshold &&
      (r.home.position === null || r.home.position > threshold),
  );
}

// ── matched named-researcher cohort ───────────────────────────────────────

export interface MatchedEntry {
  institution: string;
  query: string;
  hIndex?: number;
  academicAge?: number;
  position: number | null;
  targetKey: string | null;
  url: string | null;
}

export interface MatchedCohort {
  matchGroup: string;
  entries: MatchedEntry[];
}

/**
 * Group the matched name queries by `matchGroup` (a flagship topic) and, for
 * each, list every institution's researcher with eminence covariates and the
 * surface that actually ranked. The eminence-controlled platform read.
 */
export function matchedCohorts(snapshot: RankSnapshot, groups: RankGroup[]): MatchedCohort[] {
  const byGroup = new Map<string, MatchedEntry[]>();
  for (const row of snapshot.rows) {
    if (!queryInSegment(row, "matched")) continue;
    const mg = row.matchGroup as string;
    // Attribute the row to whichever group owns a placed target (else first hit).
    const place =
      groups
        .map((g) => ({ g, p: bestPlacement(row, g.targetKeys) }))
        .filter((x) => x.p.position !== null)
        .sort((a, b) => (a.p.position as number) - (b.p.position as number))[0] ?? null;
    const entry: MatchedEntry = {
      institution: place?.g.label ?? (row.label ?? row.query),
      query: row.query,
      hIndex: row.hIndex,
      academicAge: row.academicAge,
      position: place?.p.position ?? null,
      targetKey: place?.p.targetKey ?? null,
      url: place?.p.url ?? null,
    };
    const arr = byGroup.get(mg) ?? [];
    arr.push(entry);
    byGroup.set(mg, arr);
  }
  return [...byGroup.entries()].map(([matchGroup, entries]) => ({ matchGroup, entries }));
}

// ── rendering ─────────────────────────────────────────────────────────────

function fmt(n: number | null): string {
  return n === null ? "—" : String(n);
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((100 * n) / d)}%`;
}

/** A standings leaderboard table (institutions or platforms). */
export function toStandingsMarkdown(standings: GroupStanding[], title: string): string {
  const lines = [`### ${title}`, "", "| Group | Top-3 | Top-10 | Appeared | Median best | Wins | Sole wins |", "|---|---|---|---|---|---|---|"];
  for (const s of standings) {
    lines.push(
      `| ${s.label} | ${pct(s.top3, s.queries)} | ${pct(s.top10, s.queries)} | ${pct(s.appeared, s.queries)} | ${fmt(s.medianBest)} | ${s.wins} | ${s.soleWins} |`,
    );
  }
  return lines.join("\n");
}

/** Per-query head-to-head: home best surface/url vs best rival + winner. */
export function toHeadToHeadMarkdown(rows: HeadToHeadRow[], homeLabel: string, limit = 40): string {
  const lines = [
    `### Head-to-head (${homeLabel} vs best rival)`,
    "",
    `| Query | ${homeLabel} | (surface) | Best rival | Winner |`,
    "|---|---|---|---|---|",
  ];
  for (const r of rows.slice(0, limit)) {
    const rival = r.bestRival ? `${r.bestRival.label} @ ${r.bestRival.position}` : "—";
    lines.push(
      `| ${r.query} | ${fmt(r.home.position)} | ${r.home.targetKey ?? "—"} | ${rival} | ${r.winner} |`,
    );
  }
  if (rows.length > limit) lines.push("", `_…and ${rows.length - limit} more (full matrix in CSV)._`);
  return lines.join("\n");
}

/** Matched-cohort panel: per flagship topic, researchers side by side. */
export function toMatchedMarkdown(cohorts: MatchedCohort[]): string {
  const lines: string[] = ["### Matched cohort (eminence-controlled)"];
  for (const c of cohorts) {
    lines.push("", `**${c.matchGroup}**`, "", "| Institution | h-index | Academic age | Surface | Position |", "|---|---|---|---|---|");
    for (const e of c.entries.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))) {
      lines.push(
        `| ${e.institution} | ${e.hIndex ?? "—"} | ${e.academicAge ?? "—"} | ${e.targetKey ?? "—"} | ${fmt(e.position)} |`,
      );
    }
  }
  return lines.join("\n");
}

/** Full institution × query matrix as CSV (the wide head-to-head). */
export function toMatrixCsv(snapshot: RankSnapshot, groups: RankGroup[], segment: QuerySegment = "all"): string {
  const rows = snapshot.rows.filter((r) => queryInSegment(r, segment));
  const header = ["id", "query", "type", ...groups.map((g) => g.label)];
  const csvCell = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    const cells = [row.id, row.query, row.type, ...groups.map((g) => bestPlacement(row, g.targetKeys).position ?? "")];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
