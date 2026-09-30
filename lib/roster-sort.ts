/**
 * Unit Page v2 — roster toolbar sort + name/title filter, shared by the SSR
 * roster loaders (departments / divisions / centers), the uncacheable
 * `/api/units/[kind]/[code]/members` route, and the grouped center roster's
 * client-side filter. ONE comparator everywhere, so a page sliced on the server
 * and a section sorted in the browser order people the same way.
 *
 * Client-safe: imports only the dependency-free `@/lib/name-sort`. Never import
 * `@/lib/db` or anything under `lib/api/` from here — client components import
 * this module, and `next build` is the only gate that would catch the leak.
 */
import { extractLastNameSort } from "@/lib/name-sort";

export type RosterSort = "last" | "pubs" | "grants";

export const DEFAULT_ROSTER_SORT: RosterSort = "last";

/** Mock labels, in menu order ("Unit Page v2.dc.html" roster toolbar). */
export const ROSTER_SORT_OPTIONS: ReadonlyArray<{ value: RosterSort; label: string }> = [
  { value: "last", label: "Last name A–Z" },
  { value: "pubs", label: "Most publications" },
  { value: "grants", label: "Most grants" },
];

export function isRosterSort(value: unknown): value is RosterSort {
  return value === "last" || value === "pubs" || value === "grants";
}

/** Coerce a raw `?sort=` value. Anything unrecognised — including the
 *  Publications / Grants tabs' own `most_cited` / `end_date` values, which share
 *  the param name — falls back to the default. */
export function parseRosterSort(raw: string | null | undefined): RosterSort {
  return isRosterSort(raw) ? raw : DEFAULT_ROSTER_SORT;
}

/** Longest accepted `?q=` (after trim + whitespace collapse). */
export const ROSTER_QUERY_MAX = 100;

/** Trim, collapse internal whitespace, and cap at {@link ROSTER_QUERY_MAX}. */
export function normalizeRosterQuery(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").slice(0, ROSTER_QUERY_MAX);
}

/** Lowercase and strip combining diacritics, so "jose" matches "José". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Substring match of the (normalised) query against name + title, ignoring
 *  case and accents. An empty query matches everything. */
export function matchesRosterQuery(
  entry: { preferredName: string; primaryTitle?: string | null },
  q: string,
): boolean {
  const needle = fold(normalizeRosterQuery(q));
  if (!needle) return true;
  return fold(`${entry.preferredName ?? ""} ${entry.primaryTitle ?? ""}`).includes(needle);
}

export type RankableRosterEntry = {
  cwid: string;
  preferredName: string;
  primaryTitle?: string | null;
  pubCount: number;
  grantCount: number;
  /** Precomputed `extractLastNameSort(preferredName)`; derived when absent. */
  lastKey?: string;
};

const lastKeyOf = (e: RankableRosterEntry): string =>
  e.lastKey ?? extractLastNameSort(e.preferredName ?? "");

function compareLast(a: RankableRosterEntry, b: RankableRosterEntry): number {
  return (
    lastKeyOf(a).localeCompare(lastKeyOf(b), "en", { sensitivity: "base" }) ||
    (a.preferredName ?? "").localeCompare(b.preferredName ?? "", "en", {
      sensitivity: "base",
    }) ||
    // Stable, total order so page slices never overlap or skip a row.
    (a.cwid < b.cwid ? -1 : a.cwid > b.cwid ? 1 : 0)
  );
}

/** `last`: surname A–Z. `pubs` / `grants`: count descending, surname tiebreak. */
export function compareRoster(
  a: RankableRosterEntry,
  b: RankableRosterEntry,
  sort: RosterSort,
): number {
  if (sort === "pubs") return b.pubCount - a.pubCount || compareLast(a, b);
  if (sort === "grants") return b.grantCount - a.grantCount || compareLast(a, b);
  return compareLast(a, b);
}

/** Filter by `q` (when given) and return a NEW array in `sort` order. */
export function rankRoster<T extends RankableRosterEntry>(
  entries: readonly T[],
  opts: { sort: RosterSort; q?: string },
): T[] {
  const q = opts.q ? normalizeRosterQuery(opts.q) : "";
  const kept = q ? entries.filter((e) => matchesRosterQuery(e, q)) : [...entries];
  return kept.sort((a, b) => compareRoster(a, b, opts.sort));
}

/**
 * Pin the division chief first — under the surname sort only (a count sort is
 * an explicit ranking). A chief outside `ranked` (filtered out) is not added.
 * Shared by the division SSR roster and the filtered route so both agree.
 */
export function pinDivisionChiefFirst<T extends { cwid: string; externalHit?: unknown }>(
  ranked: T[],
  chiefCwid: string | null,
  sort: RosterSort,
): T[] {
  if (!chiefCwid || sort !== "last") return ranked;
  const chiefIdx = ranked.findIndex((e) => e.cwid === chiefCwid && !e.externalHit);
  if (chiefIdx <= 0) return ranked;
  return [ranked[chiefIdx], ...ranked.slice(0, chiefIdx), ...ranked.slice(chiefIdx + 1)];
}
