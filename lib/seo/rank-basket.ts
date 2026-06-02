/**
 * Types + pure transforms for the Google-rank baseline tracker.
 *
 * Flow (see `docs/seo-rank-tracking.md`):
 *   build-basket.ts  → data/seo/rank-basket.json   (the query set; committed)
 *   track-rank.ts    → data/seo/snapshots/rank-<date>.json  (SerpAPI output; gitignored)
 *   diff-rank.ts     → before/after comparison (markdown + CSV)
 *
 * The whole point is a defensible before/after: capture a snapshot on the
 * legacy VIVO domain BEFORE cutover, then re-run on `scholars.weill.cornell.edu`
 * AFTER, and diff. The topical queries (sourced from the ReciterAI taxonomy)
 * are the interesting ones — branded "<name> weill cornell" queries rank #1
 * either way, so the story lives in non-branded topical movement.
 */

import type { AiOverviewStatus, DomainPlacement } from "./serpapi";

// "topical" = bare-topic / brand-control queries (the cutover instrument);
// "expert" = funder-style "{topic} researcher/expert" (the rival sweep);
// "branded" = "<name>" name queries (cutover control + matched head-to-head).
export type QueryType = "topical" | "branded" | "expert";

/** One query in the basket. */
export interface BasketQuery {
  /** Stable id used to join across snapshots, e.g. "topic:cancer_genomics:plain". */
  id: string;
  /** The literal Google query string. */
  query: string;
  type: QueryType;
  /** Source ReciterAI topic id, for topical/expert queries (lets reports group by topic). */
  topicId?: string;
  /** Human label (topic label or scholar name) for report readability. */
  label?: string;
  /** Scholar cwid/slug for branded queries (lets us sanity-check the expected target URL). */
  cwid?: string;
  slug?: string;
  /** True for the curated flagship expert queries (segments the flagship leaderboard). */
  flagship?: boolean;
  /** Matched-cohort id (e.g. a flagship topic) grouping one researcher per institution. */
  matchGroup?: string;
  /** Eminence covariates for matched researchers (single source — see eminenceSource). */
  hIndex?: number;
  academicAge?: number;
  /** Provenance of hIndex/academicAge, e.g. "openalex". */
  eminenceSource?: string;
}

/** A named tracking target. A property may answer to several host aliases. */
export interface BasketTarget {
  /** Short key used in snapshots/diffs, e.g. "new" or "ucsf". */
  key: string;
  /** Human label for reports, e.g. "Scholars (new)". */
  label: string;
  /** One or more hosts treated as aliases of the same property. */
  hosts: string[];
  /** Institution this surface belongs to (groups e.g. wcm-new + wcm-vivo as "WCM"). */
  institution?: string;
  /** Platform software, for the platform rollup (e.g. "Elsevier Pure", "VIVO"). */
  platform?: string;
  /**
   * "research-profiles" (the apples-to-apples leaderboard) vs "clinical"
   * (weillcornell.org — diagnostic only, excluded from the platform leaderboard).
   */
  surfaceType?: "research-profiles" | "clinical";
  /** Restrict matches to URLs whose path starts with this (Penn: "/apps/faculty/"). */
  pathPrefix?: string;
}

export interface Basket {
  /** ISO timestamp the basket was generated. */
  generatedAt: string;
  /** Provenance note. */
  source: string;
  /** Targets to locate in each SERP. */
  targets: BasketTarget[];
  /** SerpAPI search options to use for every query (country/language/etc.). */
  searchDefaults?: {
    country?: string;
    language?: string;
    googleDomain?: string;
    num?: number;
    location?: string;
  };
  queries: BasketQuery[];
}

/** Per-(query, target) placement recorded in a snapshot. */
export interface SnapshotPlacement extends DomainPlacement {
  targetKey: string;
}

export interface SnapshotRow {
  id: string;
  query: string;
  type: QueryType;
  topicId?: string;
  label?: string;
  /** Carried through from the basket so single-snapshot reports can segment. */
  flagship?: boolean;
  matchGroup?: string;
  hIndex?: number;
  academicAge?: number;
  placements: SnapshotPlacement[];
  /**
   * Google AI Overview citation placement, captured from the SAME SerpAPI
   * response as the organic results (zero extra search; #594 §2). Additive —
   * `diffSnapshots`/standings read named fields and ignore this. `status` is
   * block-level (absent | page_token_only | parsed); `placements` is per target.
   */
  aiOverview?: {
    status: AiOverviewStatus;
    placements: { targetKey: string; citationIndex: number | null; url: string | null }[];
  };
}

export interface RankSnapshot {
  /** ISO timestamp the snapshot run started. */
  capturedAt: string;
  /** The basket file this run consumed (path, for provenance). */
  basketSource: string;
  /** Echo of the targets, so a diff can label columns without the basket. */
  targets: BasketTarget[];
  /** Search options actually used. */
  searchDefaults?: Basket["searchDefaults"];
  rows: SnapshotRow[];
}

/** One row of a before/after diff for a single (query, target). */
export interface DiffRow {
  id: string;
  query: string;
  type: QueryType;
  topicId?: string;
  label?: string;
  targetKey: string;
  beforePosition: number | null;
  afterPosition: number | null;
  /**
   * before - after, so a POSITIVE delta is an improvement (moved up the page).
   * null when either side is missing a position (entered/left the window).
   */
  delta: number | null;
  /** Classification for human-readable summaries. */
  movement: "improved" | "declined" | "unchanged" | "entered" | "dropped" | "absent";
}

function classifyMovement(before: number | null, after: number | null): DiffRow["movement"] {
  if (before === null && after === null) return "absent";
  if (before === null && after !== null) return "entered";
  if (before !== null && after === null) return "dropped";
  if (before === after) return "unchanged";
  return (after as number) < (before as number) ? "improved" : "declined";
}

function placement(row: SnapshotRow | undefined, targetKey: string): number | null {
  const p = row?.placements.find((x) => x.targetKey === targetKey);
  return p ? p.position : null;
}

/**
 * Diff two snapshots, one row per (query, target). Joins on query id, so a
 * basket that changed between runs simply yields fewer comparable rows (queries
 * present in only one snapshot are skipped — reported by the caller).
 */
export function diffSnapshots(before: RankSnapshot, after: RankSnapshot): DiffRow[] {
  const beforeById = new Map(before.rows.map((r) => [r.id, r]));
  const targetKeys = after.targets.map((t) => t.key);
  const rows: DiffRow[] = [];

  for (const a of after.rows) {
    const b = beforeById.get(a.id);
    if (!b) continue; // query not in the before basket — not comparable
    for (const key of targetKeys) {
      const beforePos = placement(b, key);
      const afterPos = placement(a, key);
      const delta =
        beforePos !== null && afterPos !== null ? beforePos - afterPos : null;
      rows.push({
        id: a.id,
        query: a.query,
        type: a.type,
        topicId: a.topicId,
        label: a.label,
        targetKey: key,
        beforePosition: beforePos,
        afterPosition: afterPos,
        delta,
        movement: classifyMovement(beforePos, afterPos),
      });
    }
  }
  return rows;
}

export interface DiffSummary {
  targetKey: string;
  type: QueryType | "all";
  count: number;
  improved: number;
  declined: number;
  unchanged: number;
  entered: number;
  dropped: number;
  absent: number;
  /** Mean position among queries ranked in BOTH snapshots (comparable set). */
  avgBefore: number | null;
  avgAfter: number | null;
  /** Mean delta among the comparable set (positive = improvement). */
  avgDelta: number | null;
  /** How many comparable queries moved onto page 1 (top 10). */
  ontoPageOne: number;
}

function mean(nums: number[]): number | null {
  return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

/**
 * Aggregate diff rows by target and query type (plus an "all" rollup per
 * target). The comparable-set averages only count queries with a position on
 * both sides, which is the honest way to report "we moved from avg 8.1 → 4.3".
 */
export function summarize(rows: DiffRow[]): DiffSummary[] {
  const targetKeys = [...new Set(rows.map((r) => r.targetKey))];
  const types: (QueryType | "all")[] = ["all", "topical", "branded", "expert"];
  const out: DiffSummary[] = [];

  for (const targetKey of targetKeys) {
    for (const type of types) {
      const subset = rows.filter(
        (r) => r.targetKey === targetKey && (type === "all" || r.type === type),
      );
      if (subset.length === 0) continue;
      const comparable = subset.filter(
        (r) => r.beforePosition !== null && r.afterPosition !== null,
      );
      out.push({
        targetKey,
        type,
        count: subset.length,
        improved: subset.filter((r) => r.movement === "improved").length,
        declined: subset.filter((r) => r.movement === "declined").length,
        unchanged: subset.filter((r) => r.movement === "unchanged").length,
        entered: subset.filter((r) => r.movement === "entered").length,
        dropped: subset.filter((r) => r.movement === "dropped").length,
        absent: subset.filter((r) => r.movement === "absent").length,
        avgBefore: mean(comparable.map((r) => r.beforePosition as number)),
        avgAfter: mean(comparable.map((r) => r.afterPosition as number)),
        avgDelta: mean(comparable.map((r) => r.delta as number)),
        ontoPageOne: comparable.filter(
          (r) => (r.beforePosition as number) > 10 && (r.afterPosition as number) <= 10,
        ).length,
      });
    }
  }
  return out;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render the per-(query, target) diff rows as CSV. */
export function toCsv(rows: DiffRow[]): string {
  const header = [
    "id",
    "type",
    "topicId",
    "label",
    "query",
    "target",
    "beforePosition",
    "afterPosition",
    "delta",
    "movement",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.type,
        r.topicId ?? "",
        r.label ?? "",
        r.query,
        r.targetKey,
        r.beforePosition ?? "",
        r.afterPosition ?? "",
        r.delta ?? "",
        r.movement,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function fmtPos(n: number | null): string {
  return n === null ? "—" : String(n);
}

function fmtAvg(n: number | null): string {
  return n === null ? "—" : n.toFixed(1);
}

/** Render a human-readable markdown report (summary table + biggest movers). */
export function toMarkdownReport(
  before: RankSnapshot,
  after: RankSnapshot,
  rows: DiffRow[],
): string {
  const summaries = summarize(rows);
  const targetLabel = new Map(after.targets.map((t) => [t.key, t.label]));
  const lines: string[] = [];

  lines.push(`# Google-rank diff — ${before.capturedAt} → ${after.capturedAt}`);
  lines.push("");
  lines.push(
    "Positive delta = improvement (moved up the page). Averages count only queries ranked in both snapshots.",
  );
  lines.push("");
  lines.push("| Target | Query set | Comparable avg before | avg after | avg Δ | Improved | Declined | Onto page 1 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    lines.push(
      `| ${targetLabel.get(s.targetKey) ?? s.targetKey} | ${s.type} | ${fmtAvg(s.avgBefore)} | ${fmtAvg(s.avgAfter)} | ${fmtAvg(s.avgDelta)} | ${s.improved} | ${s.declined} | ${s.ontoPageOne} |`,
    );
  }
  lines.push("");

  // Biggest movers (by absolute delta), topical first since that's the story.
  const movers = rows
    .filter((r) => r.delta !== null && r.delta !== 0)
    .sort((a, b) => Math.abs(b.delta as number) - Math.abs(a.delta as number))
    .slice(0, 25);
  if (movers.length) {
    lines.push("## Biggest movers");
    lines.push("");
    lines.push("| Query | Type | Target | Before | After | Δ |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of movers) {
      lines.push(
        `| ${r.query} | ${r.type} | ${targetLabel.get(r.targetKey) ?? r.targetKey} | ${fmtPos(r.beforePosition)} | ${fmtPos(r.afterPosition)} | ${(r.delta as number) > 0 ? "+" : ""}${r.delta} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
