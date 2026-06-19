/**
 * Pure graph helpers for the Cancer Center collaboration network (#1137).
 *
 * DB-free and deterministic — shared by the client component, the standalone-HTML
 * export, and the unit tests. The browser calls these on every control change to
 * rebuild the vis-network DataSets from the immutable payload (`papers` + `nodes`).
 * Server stays filter-agnostic; all year/threshold/rollup logic lives here.
 *
 * The edge builders are GROUP-AGNOSTIC: they consume `CollabGroup[]` (member
 * indices + a year), so the same machinery serves the publication axis (papers)
 * and the grant co-investigator axis (awards, #1137 Phase 2 — see `grants.ts`).
 *
 * See `docs/cancer-center-collaboration-network-spec.md` §5.1, §13.1–13.3.
 */
import type { CollabGroup, CollabProgram } from "./types";

/**
 * Okabe-Ito colorblind-safe qualitative palette. Programs take slots in
 * `CenterProgram.sortOrder` order (assigned upstream), so a color is stable
 * across label changes. Colorblind-safe + print-legible — required for a public
 * tab that is also exported into slides. The last two slots (light yellow, black)
 * are deliberate last-resorts for the unlikely >6-program center.
 */
export const OKABE_ITO = [
  "#0072B2", // blue
  "#D55E00", // vermillion
  "#009E73", // bluish green
  "#CC79A7", // reddish purple
  "#E69F00", // orange
  "#56B4E9", // sky blue
  "#F0E442", // yellow (last resort)
  "#000000", // black (last resort)
] as const;

/** Neutral gray for the synthetic "Unclassified" (null-program) group. */
export const UNCLASSIFIED_COLOR = "#9AA0A6";
export const UNCLASSIFIED_LABEL = "Unclassified";
/** Stable key for the null/Unclassified program in rollup edge maps. */
export const UNCLASSIFIED_KEY = "__unclassified__";

/**
 * Assign a color to each program by position. Inputs MUST already be in
 * `sortOrder` order. The null/Unclassified program is always gray and does not
 * consume a palette slot, so coloring is unaffected by whether it is present.
 */
export function assignProgramColors(
  programs: Array<{ code: string | null; label: string }>,
): CollabProgram[] {
  let slot = 0;
  return programs.map((p) => {
    if (p.code === null) {
      return { code: null, label: p.label, color: UNCLASSIFIED_COLOR };
    }
    const color = OKABE_ITO[slot % OKABE_ITO.length];
    slot += 1;
    return { code: p.code, label: p.label, color };
  });
}

export interface EdgeBuildOptions {
  /**
   * Inclusive year range `[min, max]`; a `null` bound is open. Omit entirely to
   * include every paper (papers with a `null` year are kept only when no range
   * is supplied — once the slider is touched they cannot be placed).
   */
  yearRange?: [number | null, number | null];
  /**
   * Skip papers with more than this many in-center members from PEOPLE-edge and
   * node-size building (a 30-author consortium paper would otherwise emit 435
   * edges and dominate). Still surfaced by the UI as an "omitted" count, never
   * silently. Default 25. Does NOT apply to program rollup (≤ #programs edges).
   */
  maxMembersPerPaper?: number;
  /**
   * Newman fractional `1/(k-1)` weighting (k = paper member count) for edge
   * STRENGTH, so big papers don't dominate the physics/width. Raw co-pub COUNT
   * is always tracked separately for the threshold + tooltip. Default false.
   */
  newman?: boolean;
  /**
   * Keep only WITHIN-program collaborations: drop any people-edge whose two
   * members are in different programs, and size each node by its within-program
   * co-authorship. Cuts the cross-program hairball into clean per-program
   * clusters (cross-program structure lives in the Programs rollup view).
   * Requires `programOf`. Default false.
   */
  withinProgramOnly?: boolean;
  /** Program code (or null) for a node index — needed by `withinProgramOnly`. */
  programOf?: (idx: number) => string | null;
}

const DEFAULT_CAP = 25;

/** Whether a group's representative year falls inside the (optional) year range. */
export function paperInYear(
  p: CollabGroup,
  range?: [number | null, number | null],
): boolean {
  if (!range) return true;
  const [lo, hi] = range;
  if (lo == null && hi == null) return true;
  if (p.year == null) return false; // can't place a null-year paper under a filter
  if (lo != null && p.year < lo) return false;
  if (hi != null && p.year > hi) return false;
  return true;
}

export interface PeopleEdge {
  /** Lower node index. */
  a: number;
  /** Higher node index (`a < b`). */
  b: number;
  /** Raw shared-paper count (integer) — drives the min-co-pubs threshold + tooltip. */
  weight: number;
  /** Possibly-fractional weight (Newman) — drives edge width + physics. */
  strength: number;
}

/**
 * Build the undirected people-edge set: one edge per pair of members who share
 * ≥1 (filtered, uncapped) paper, weighted by shared-paper count.
 */
export function buildPeopleEdges(
  papers: CollabGroup[],
  opts: EdgeBuildOptions = {},
): PeopleEdge[] {
  const cap = opts.maxMembersPerPaper ?? DEFAULT_CAP;
  const within = opts.withinProgramOnly && opts.programOf ? opts.programOf : null;
  const map = new Map<string, PeopleEdge>();
  for (const p of papers) {
    const m = p.m;
    if (m.length < 2 || m.length > cap) continue;
    if (!paperInYear(p, opts.yearRange)) continue;
    const inc = opts.newman ? 1 / (m.length - 1) : 1;
    for (let i = 0; i < m.length; i++) {
      for (let j = i + 1; j < m.length; j++) {
        const a = Math.min(m[i], m[j]);
        const b = Math.max(m[i], m[j]);
        if (a === b) continue; // defensive: a node shouldn't appear twice on a paper
        if (within && programKey(within(a)) !== programKey(within(b))) continue;
        const key = `${a}-${b}`;
        let e = map.get(key);
        if (!e) {
          e = { a, b, weight: 0, strength: 0 };
          map.set(key, e);
        }
        e.weight += 1;
        e.strength += inc;
      }
    }
  }
  return [...map.values()];
}

export interface ProgramEdge {
  /** Program key (code or `UNCLASSIFIED_KEY`), `a <= b` lexically. */
  a: string;
  b: string;
  /** Distinct cross-program co-authored papers. */
  weight: number;
}

/** Stable program key for rollup maps. */
export function programKey(code: string | null): string {
  return code ?? UNCLASSIFIED_KEY;
}

/**
 * Roll the people graph up to programs: each cross-program edge weight = the
 * number of distinct papers whose author set spans those two programs. Also
 * returns per-program INTERNAL counts (papers entirely within one program), used
 * to size the program nodes. No member cap here — at most C(#programs, 2) edges.
 */
export function buildProgramEdges(
  papers: CollabGroup[],
  nodeProgram: (idx: number) => string | null,
  opts: EdgeBuildOptions = {},
): { edges: ProgramEdge[]; internal: Map<string, number> } {
  const edgeMap = new Map<string, ProgramEdge>();
  const internal = new Map<string, number>();
  for (const p of papers) {
    if (p.m.length < 2) continue;
    if (!paperInYear(p, opts.yearRange)) continue;
    const progs = new Set<string>();
    for (const idx of p.m) progs.add(programKey(nodeProgram(idx)));
    const arr = [...progs];
    if (arr.length === 1) {
      internal.set(arr[0], (internal.get(arr[0]) ?? 0) + 1);
      continue;
    }
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i] < arr[j] ? arr[i] : arr[j];
        const b = arr[i] < arr[j] ? arr[j] : arr[i];
        const key = `${a}|${b}`;
        let e = edgeMap.get(key);
        if (!e) {
          e = { a, b, weight: 0 };
          edgeMap.set(key, e);
        }
        e.weight += 1;
      }
    }
  }
  return { edges: [...edgeMap.values()], internal };
}

/**
 * Within-center co-publication count per node over the filtered view — the node
 * SIZE metric (§13.1). A node's count = the number of (filtered, uncapped)
 * papers on which it shares authorship with ≥1 other member. Zero = unconnected
 * (eligible for the "hide unconnected" toggle, §13.3).
 */
export function computeCoPubCounts(
  papers: CollabGroup[],
  nodeCount: number,
  opts: EdgeBuildOptions = {},
): number[] {
  const cap = opts.maxMembersPerPaper ?? DEFAULT_CAP;
  const within = opts.withinProgramOnly && opts.programOf ? opts.programOf : null;
  const counts = new Array<number>(nodeCount).fill(0);
  for (const p of papers) {
    if (p.m.length < 2 || p.m.length > cap) continue;
    if (!paperInYear(p, opts.yearRange)) continue;
    if (within) {
      // Count this paper for a member only if a same-program co-member is on it.
      const perProgram = new Map<string, number>();
      for (const idx of p.m) perProgram.set(programKey(within(idx)), (perProgram.get(programKey(within(idx))) ?? 0) + 1);
      for (const idx of p.m) {
        if (idx < 0 || idx >= nodeCount) continue;
        if ((perProgram.get(programKey(within(idx))) ?? 0) >= 2) counts[idx] += 1;
      }
    } else {
      for (const idx of p.m) {
        if (idx >= 0 && idx < nodeCount) counts[idx] += 1;
      }
    }
  }
  return counts;
}

/** Count of filtered papers above the member cap (surfaced, never silent). */
export function countOmittedHyperauthored(
  papers: CollabGroup[],
  opts: EdgeBuildOptions = {},
): number {
  const cap = opts.maxMembersPerPaper ?? DEFAULT_CAP;
  let n = 0;
  for (const p of papers) {
    if (p.m.length > cap && paperInYear(p, opts.yearRange)) n += 1;
  }
  return n;
}

/**
 * Area-proportional node radius from the within-center co-pub count, with a
 * floor so isolated/low-collaboration members stay visible and clickable.
 */
export function nodeRadius(
  coPubCount: number,
  opts: { rMin?: number; k?: number; rMax?: number } = {},
): number {
  const rMin = opts.rMin ?? 6;
  const k = opts.k ?? 3;
  const rMax = opts.rMax ?? 40;
  return Math.min(rMax, rMin + k * Math.sqrt(Math.max(0, coPubCount)));
}

/** Min/max publication year across the co-authored papers (for the slider bounds). */
export function yearExtent(papers: CollabGroup[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of papers) {
    if (p.year == null) continue;
    if (p.year < lo) lo = p.year;
    if (p.year > hi) hi = p.year;
  }
  if (!isFinite(lo) || !isFinite(hi)) return null;
  return [lo, hi];
}
