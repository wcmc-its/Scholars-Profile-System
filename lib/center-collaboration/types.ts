/**
 * Shared types for the Cancer Center collaboration network (#1137).
 *
 * This module is DB-free and safe to import from the client component and the
 * standalone-HTML export. The server loader (`lib/api/center-collaboration.ts`)
 * produces a `CenterCollaborationPayload`; the browser builds edges/rollups from
 * it (`graph.ts`). See `docs/cancer-center-collaboration-network-spec.md`.
 */

/** A center program — the node-color group. */
export interface CollabProgram {
  /** Program code, or `null` for the synthetic "Unclassified" group. */
  code: string | null;
  /** Display label (from `CenterProgram.label`, or "Unclassified"). */
  label: string;
  /** Assigned hex color (Okabe-Ito by `sortOrder`; gray for Unclassified). */
  color: string;
}

/** A graph node = one publicly-displayed, active center member. */
export interface CollabNode {
  /** Stable index into the payload `nodes` array — referenced by `CollabPaper.m`. */
  i: number;
  cwid: string;
  name: string;
  /** Profile slug for the outbound link; `null` if the scholar has no slug. */
  slug: string | null;
  /** Program code (matches a `CollabProgram.code`), or `null` = Unclassified. */
  programCode: string | null;
  /**
   * Total confirmed publications — for the node tooltip ("N publications"),
   * NOT the node size. Node size is derived client-side from within-center
   * co-authorship over the current filtered view (see `computeCoPubCounts`).
   */
  pubCount: number;
}

/**
 * One co-authored paper: the set of member indices on it (length ≥ 2) and its
 * year. The browser builds both the people-edge set and the program-rollup edge
 * set from these, applying year/threshold filters live — so the server stays
 * filter-agnostic and the standalone export embeds exactly this.
 */
export interface CollabPaper {
  pmid: string;
  year: number | null;
  /** Indices into `nodes` (length ≥ 2, deduped). */
  m: number[];
}

/** The full on-demand graph payload for one center. */
export interface CenterCollaborationPayload {
  center: { code: string; name: string };
  /** Legend: programs that have ≥1 active member, in sortOrder, + Unclassified. */
  programs: CollabProgram[];
  nodes: CollabNode[];
  papers: CollabPaper[];
  /** ISO timestamp the payload was built (stamped by the route). */
  generatedAt: string;
}
