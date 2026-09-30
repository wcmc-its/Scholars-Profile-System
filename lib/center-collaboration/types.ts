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
  /**
   * The node's colour-GROUP key (matches a `CollabProgram.code`), or `null` =
   * the unclassified group. Named for the center's programs; the department
   * network reuses it for the member's division code (naming debt — the whole
   * graph layer is group-agnostic, so a rename is cosmetic).
   */
  programCode: string | null;
  /**
   * Total confirmed publications — for the node tooltip ("N publications"),
   * NOT the node size. Node size is derived client-side from within-center
   * co-authorship over the current filtered view (see `computeCoPubCounts`).
   */
  pubCount: number;
}

/**
 * A relationship GROUP: a set of member indices that co-occur on one shared
 * object (a paper, or a grant award) plus a representative year. The pure edge
 * builders in `graph.ts` are group-agnostic — they consume `CollabGroup[]`, so
 * the same people/program/rollup machinery serves both the publication axis
 * (`CollabPaper`) and the grant-co-investigator axis (`CollabAward`, #1137 Phase 2).
 */
export interface CollabGroup {
  /** Indices into `nodes` (length ≥ 2, deduped, ascending). */
  m: number[];
  /** Representative year for the (optional) year filter; `null` = undated. */
  year: number | null;
}

/**
 * One co-authored paper. The browser builds both the people-edge set and the
 * program-rollup edge set from these, applying year/threshold filters live — so
 * the server stays filter-agnostic and the standalone export embeds exactly this.
 */
export interface CollabPaper extends CollabGroup {
  pmid: string;
}

/**
 * One shared grant award (#1137 Phase 2): the set of members who appear on the
 * same sponsor `awardNumber`. Edges are inferred by grouping per-investigator
 * `Grant` rows on the shared award key — there is no native multi-PI edge. The
 * grant-visibility suppression gate is applied server-side BEFORE grouping, so a
 * suppressed grant can never form an edge.
 */
export interface CollabAward extends CollabGroup {
  /** Shared award key (sponsor `awardNumber`). */
  awardId: string;
  /** `year` (from `CollabGroup`) = earliest project start year across grouped rows. */
  /** Latest project end year across grouped rows (for active + year-overlap). */
  endYear: number | null;
  /** True when ≥1 grouped row is still active (`endDate ≥ today`). */
  active: boolean;
  /**
   * True when this is an umbrella / infrastructure award — a center/training
   * mechanism (P30/P50/U54/UL1…) or a member count above the umbrella floor (the
   * §4 clique problem). Excluded by default, surfaced as a count, never silent.
   */
  umbrella: boolean;
}

/** The full on-demand graph payload for one center. */
export interface CenterCollaborationPayload {
  center: { code: string; name: string };
  /** Legend: programs that have ≥1 active member, in sortOrder, + Unclassified. */
  programs: CollabProgram[];
  nodes: CollabNode[];
  papers: CollabPaper[];
  /**
   * Grant co-investigator groups (#1137 Phase 2). Empty `[]` unless the grant-axis
   * sub-flag is on; the loader applies the grant-suppression gate before building.
   */
  awards: CollabAward[];
  /** Whether the grant axis is enabled — drives the axis toggle in the component. */
  grantAxis: boolean;
  /** ISO timestamp the payload was built (stamped by the route). */
  generatedAt: string;
}

/**
 * The unit-agnostic payload the shared network component consumes — a center's
 * payload minus its `center` header. The department loader returns exactly this
 * (its `programs` legend holds divisions; `CollabNode.programCode` holds the
 * member's division code).
 */
export type UnitCollaborationPayload = Omit<CenterCollaborationPayload, "center">;

/**
 * UI wording for the unit's colour groups, so one network component serves a
 * center (programs) and a department (divisions).
 */
export interface CollabVocab {
  /** Singular group noun, lower-case: "program" / "division". */
  group: string;
  /** Plural group noun, lower-case: "programs" / "divisions". */
  groups: string;
  /** The "show every group" picker chip: "All programs" / "All divisions". */
  allGroups: string;
  /** The unit noun, lower-case: "center" / "department". */
  unitNoun: string;
  /** Plural member noun for the footer count: "members". */
  memberNoun: string;
  /** Label for the null-group legend entry / tooltip fallback. */
  unclassifiedLabel?: string;
}
