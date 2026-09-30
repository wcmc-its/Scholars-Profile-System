/**
 * Query-string contract shared by the `/edit/reports/7` page and its
 * `.xlsx` download route (`/api/edit/reports/mentored-publications`) — one
 * parser so the link the page renders and the params the route accepts can
 * never disagree:
 *   - `years`   graduation years, comma-separated and/or repeated
 *               (`years=2024,2025` from a link, `years=2024&years=2025` from
 *               the page's checkbox group); the token `unknown` = learners
 *               with no graduation year (`null` in the parsed list);
 *               `years=all` = every year; absent → the caller's default
 *               (`defaultMentoredPubsYears`);
 *   - `mtype`   which types of mentorship (`MENTORSHIP_TYPE_KEYS`), comma-
 *               separated and/or repeated like `years`; absent → the caller's
 *               default (`defaultMentorshipTypes`). Not `type`/`types`: `type`
 *               is the shared PERSON-type param (`lib/edit/person-filter.ts`).
 *               LEGACY: `types=` (this param's old name) is read when `mtype`
 *               is absent; a pre-types link's
 *               `program=<scope>` reads as that scope's roster type
 *               (`ROSTER_TYPE_BY_SCOPE`); `program=all` or an unknown program
 *               reads as absent — an old link never 400s;
 *   - `tail`    integer 0..MAX_TAIL, default DEFAULT_TAIL;
 *   - `pubs`    which publication set: `mentored` (co-pubs with an AOC mentor,
 *               the default) or `all` (every publication of the learner, from
 *               the `aoc_mentee_publication` bridge); the route honours it too;
 *   - `view`    which in-page view: `summary` (default) or `publications`
 *               (one row per publication, most recent first). Page-only — the
 *               route accepts and ignores it so one link shape serves both;
 *   - `grad_from` / `grad_to` / `grad_unknown`  what the rail's graduation-
 *               year RANGE control submits (two selects + "Include learners
 *               with no graduation year"). Read only when `years` is absent,
 *               and folded into the same `years` list (every year from..to,
 *               plus `null` when `grad_unknown` is set), so every link the
 *               page writes still speaks `years=` and an old `years=` link
 *               (a non-contiguous list included) keeps its exact meaning;
 *   - `grad_exact` the rail's hidden echo of a GAPPY selection (e.g.
 *               `2019,2027` from an old `years=` link): while `grad_from` /
 *               `grad_to` still equal its first / last year (the selects
 *               untouched), the list is kept exactly as given (plus `null`
 *               when `grad_unknown` is set) instead of widening to every
 *               year between — so changing any OTHER rail control keeps the
 *               link's meaning; once either select moves, the range wins.
 *               Server-side, so it holds without JS too;
 *   - `window`  per-PUBLICATION program-window facet: `yes` / `no` /
 *               `unknown`, comma-separated and/or repeated; absent = any;
 *   - `position` the learner's byline position on the publication: `first` /
 *               `last` / `middle`, same list shape; absent = any. Not report
 *               8's `pos` (single-valued, a different vocabulary);
 *   - `pubyear` publication years, same list shape; absent = any;
 *   - `mentor`  mentor CWIDs, same list shape; absent = any;
 *   - `withpubs` `1` = hide learners with no publications (after the other
 *               filters); absent = show every learner;
 *   - `q`       the "Find a learner or mentor" box. Page-only and client-side
 *               (it narrows the Learners table, never the counts or the
 *               download); carried so a shared link reopens with it.
 * The five facets (`window` … `withpubs`) are applied after the loader by
 * `applyMentoredPubsFacets` (`mentored-publications-facets.ts`), on the page
 * and in the download alike. None of them existed before the 2026-09-24
 * redesign, so an older link carries none and reads exactly as it did.
 * Malformed input is an error (the route 400s; the page falls back to its
 * defaults) rather than a silent coercion. Pure — no DB, safe anywhere.
 */
import { DEFAULT_TAIL, MAX_TAIL } from "@/lib/edit/mentored-publications-report";
import {
  MENTORSHIP_TYPE_KEYS,
  ROSTER_TYPE_BY_SCOPE,
  type MentorshipTypeKey,
} from "@/lib/edit/mentorship-type";

export const MENTORED_PUBS_MODES = ["mentored", "all"] as const;
export type MentoredPubsMode = (typeof MENTORED_PUBS_MODES)[number];

export const MENTORED_PUBS_VIEWS = ["summary", "publications"] as const;
export type MentoredPubsView = (typeof MENTORED_PUBS_VIEWS)[number];

/** The per-publication "In window" facet's values, in display order. */
export const MENTORED_PUBS_WINDOWS = ["yes", "no", "unknown"] as const;
export type MentoredPubsWindow = (typeof MENTORED_PUBS_WINDOWS)[number];

/** The learner's byline position on a publication, in display order. */
export const MENTORED_PUBS_POSITIONS = ["first", "last", "middle"] as const;
export type MentoredPubsPosition = (typeof MENTORED_PUBS_POSITIONS)[number];

export type MentoredPubsParams = {
  /** Explicit graduation years, `null` in the list = "unknown grad year";
   *  `[]` = every year (`years=all`); null = not given, the caller applies
   *  its default. */
  years: Array<number | null> | null;
  /** The types of mentorship kept, in `MENTORSHIP_TYPE_KEYS` order; null =
   *  not given, the caller applies its default (`resolveMentorshipTypes`). */
  types: MentorshipTypeKey[] | null;
  tail: number;
  pubs: MentoredPubsMode;
  view: MentoredPubsView;
  /** Per-publication window facet; `[]` = any. */
  window: MentoredPubsWindow[];
  /** Learner byline position facet; `[]` = any. */
  position: MentoredPubsPosition[];
  /** Publication years, ascending; `[]` = any. */
  pubYears: number[];
  /** Mentor CWIDs (lower-cased), sorted; `[]` = any. */
  mentors: string[];
  /** Hide learners with no publications (after the other filters). */
  withPubs: boolean;
  /** The client-side "Find a learner or mentor" text (page-only). */
  q: string;
};

/** Everything unset — the parser's result for an empty query string. */
export const MENTORED_PUBS_DEFAULT_PARAMS: MentoredPubsParams = {
  years: null,
  types: null,
  tail: DEFAULT_TAIL,
  pubs: "mentored",
  view: "summary",
  window: [],
  position: [],
  pubYears: [],
  mentors: [],
  withPubs: false,
  q: "",
};

/** Whether any of the post-load facets (`window` … `withpubs`) is set. */
export function hasMentoredPubsFacets(
  p: Pick<MentoredPubsParams, "window" | "position" | "pubYears" | "mentors" | "withPubs">,
): boolean {
  return (
    p.window.length > 0 || p.position.length > 0 || p.pubYears.length > 0 || p.mentors.length > 0 || p.withPubs
  );
}

export type ParsedMentoredPubsParams =
  | { ok: true; value: MentoredPubsParams }
  | {
      ok: false;
      error:
        | "invalid_years"
        | "invalid_types"
        | "invalid_tail"
        | "invalid_pubs"
        | "invalid_view"
        | "invalid_window"
        | "invalid_position"
        | "invalid_pubyear"
        | "invalid_mentor";
    };

const YEAR_MIN = 1900;
const YEAR_MAX = 2100;
/** A CWID-shaped token: letters and digits (plus `.`/`_`/`-`), at most 32. */
const CWID_TOKEN = /^[a-z0-9._-]{1,32}$/;

/** A four-digit year inside the sane window, else null. */
function yearToken(t: string): number | null {
  if (!/^\d{4}$/.test(t)) return null;
  const n = Number(t);
  return n < YEAR_MIN || n > YEAR_MAX ? null : n;
}

function first(v: string | string[] | undefined | null): string | undefined {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function all(v: string | string[] | undefined | null): string[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseMentoredPubsParams(
  raw: Record<string, string | string[] | undefined> | URLSearchParams,
): ParsedMentoredPubsParams {
  const get = (k: string) =>
    raw instanceof URLSearchParams ? (raw.get(k) ?? undefined) : first(raw[k]);
  const getAll = (k: string) => (raw instanceof URLSearchParams ? raw.getAll(k) : all(raw[k]));

  let years: Array<number | null> | null = null;
  const yearTokens = getAll("years")
    .flatMap((v) => v.split(","))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (yearTokens.some((t) => t.toLowerCase() === "all")) {
    years = [];
  } else if (yearTokens.length > 0) {
    const out = new Set<number>();
    let unknown = false;
    for (const t of yearTokens) {
      if (t.toLowerCase() === "unknown") {
        unknown = true;
        continue;
      }
      if (!/^\d{4}$/.test(t)) return { ok: false, error: "invalid_years" };
      const n = Number(t);
      if (n < YEAR_MIN || n > YEAR_MAX) return { ok: false, error: "invalid_years" };
      out.add(n);
    }
    years = [...out].sort((a, b) => a - b);
    if (unknown) years.push(null);
  } else {
    // The rail's range control (module doc): folded into the same list.
    const rawFrom = get("grad_from")?.trim() || undefined;
    const rawTo = get("grad_to")?.trim() || undefined;
    const withUnknown = (get("grad_unknown")?.trim() ?? "") !== "";
    const exact: number[] = [];
    for (const t of (get("grad_exact") ?? "").split(",").map((v) => v.trim()).filter(Boolean)) {
      const y = yearToken(t);
      if (y === null) return { ok: false, error: "invalid_years" };
      exact.push(y);
    }
    exact.sort((a, b) => a - b);
    if (exact.length > 0 && rawFrom === String(exact[0]) && rawTo === String(exact[exact.length - 1])) {
      years = [...new Set(exact)];
      if (withUnknown) years.push(null);
    } else if (rawFrom !== undefined || rawTo !== undefined) {
      const a = yearToken(rawFrom ?? rawTo!);
      const b = yearToken(rawTo ?? rawFrom!);
      if (a === null || b === null) return { ok: false, error: "invalid_years" };
      years = [];
      for (let y = Math.min(a, b); y <= Math.max(a, b); y++) years.push(y);
      if (withUnknown) years.push(null);
    } else if (withUnknown) {
      years = [null];
    }
  }

  let types: MentorshipTypeKey[] | null = null;
  const mtype = getAll("mtype");
  const typeTokens = (mtype.length > 0 ? mtype : getAll("types")) // legacy name
    .flatMap((v) => v.split(","))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (typeTokens.length > 0) {
    const out = new Set<string>();
    for (const t of typeTokens) {
      if (!(MENTORSHIP_TYPE_KEYS as readonly string[]).includes(t))
        return { ok: false, error: "invalid_types" };
      out.add(t);
    }
    types = MENTORSHIP_TYPE_KEYS.filter((k) => out.has(k));
  } else {
    // Legacy `program=<scope>` (the select this filter replaced): that
    // scope's roster type; `all` / unknown → not given.
    const legacy = ROSTER_TYPE_BY_SCOPE[get("program")?.trim().toLowerCase() ?? ""];
    if (legacy) types = [legacy];
  }

  let tail = DEFAULT_TAIL;
  const rawTail = get("tail")?.trim();
  if (rawTail !== undefined && rawTail !== "") {
    if (!/^\d$/.test(rawTail)) return { ok: false, error: "invalid_tail" };
    tail = Number(rawTail);
    if (tail > MAX_TAIL) return { ok: false, error: "invalid_tail" };
  }

  let pubs: MentoredPubsMode = "mentored";
  const rawPubs = get("pubs")?.trim().toLowerCase();
  if (rawPubs !== undefined && rawPubs !== "") {
    if (!(MENTORED_PUBS_MODES as readonly string[]).includes(rawPubs)) {
      return { ok: false, error: "invalid_pubs" };
    }
    pubs = rawPubs as MentoredPubsMode;
  }

  let view: MentoredPubsView = "summary";
  const rawView = get("view")?.trim().toLowerCase();
  if (rawView !== undefined && rawView !== "") {
    if (!(MENTORED_PUBS_VIEWS as readonly string[]).includes(rawView)) {
      return { ok: false, error: "invalid_view" };
    }
    view = rawView as MentoredPubsView;
  }

  // The post-load facets: comma-separated and/or repeated, like `years`.
  const tokens = (k: string) =>
    getAll(k)
      .flatMap((v) => v.split(","))
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
  const vocab = <T extends string>(k: string, allowed: readonly T[]): T[] | null => {
    const got = new Set(tokens(k));
    for (const t of got) if (!(allowed as readonly string[]).includes(t)) return null;
    return allowed.filter((a) => got.has(a));
  };
  const window = vocab("window", MENTORED_PUBS_WINDOWS);
  if (window === null) return { ok: false, error: "invalid_window" };
  const position = vocab("position", MENTORED_PUBS_POSITIONS);
  if (position === null) return { ok: false, error: "invalid_position" };
  const pubYearSet = new Set<number>();
  for (const t of tokens("pubyear")) {
    const y = yearToken(t);
    if (y === null) return { ok: false, error: "invalid_pubyear" };
    pubYearSet.add(y);
  }
  const mentorSet = new Set<string>();
  for (const t of tokens("mentor")) {
    if (!CWID_TOKEN.test(t)) return { ok: false, error: "invalid_mentor" };
    mentorSet.add(t);
  }
  const rawWithPubs = get("withpubs")?.trim().toLowerCase() ?? "";
  const withPubs = rawWithPubs !== "" && rawWithPubs !== "0";
  const q = (get("q") ?? "").trim().slice(0, 200);

  return {
    ok: true,
    value: {
      years,
      types,
      tail,
      pubs,
      view,
      window,
      position,
      pubYears: [...pubYearSet].sort((a, b) => a - b),
      mentors: [...mentorSet].sort(),
      withPubs,
      q,
    },
  };
}

/** The query string the page's links and the download button carry — the
 *  inverse of `parseMentoredPubsParams`, so a round-trip is lossless. `mtype`
 *  and `pubs` are written whenever known (the download link must carry
 *  them; the page always resolves both); the facets only when set, so a
 *  link with none reads exactly as it did before they existed; `view` and
 *  `q` only when not the default, so the download link (built with both at
 *  their defaults) stays page-state-free. `program`, `types` and the
 *  `grad_*` range fields (`grad_exact` included) are never written — read-only input shapes. */
export function mentoredPubsQueryString(p: MentoredPubsParams): string {
  const sp = new URLSearchParams();
  if (p.years !== null) {
    sp.set("years", p.years.length > 0 ? p.years.map((y) => y ?? "unknown").join(",") : "all");
  }
  if (p.types !== null) sp.set("mtype", p.types.join(","));
  sp.set("tail", String(p.tail));
  sp.set("pubs", p.pubs);
  if (p.window.length > 0) sp.set("window", p.window.join(","));
  if (p.position.length > 0) sp.set("position", p.position.join(","));
  if (p.pubYears.length > 0) sp.set("pubyear", p.pubYears.join(","));
  if (p.mentors.length > 0) sp.set("mentor", p.mentors.join(","));
  if (p.withPubs) sp.set("withpubs", "1");
  if (p.view !== "summary") sp.set("view", p.view);
  if (p.q) sp.set("q", p.q);
  return sp.toString();
}

/** Whether a known-year selection skips a year that EXISTS: some year in
 *  `choices` between its first and last is not selected. Without `choices`,
 *  every whole number between counts. A selection that skips only years no
 *  learner graduated in is a plain range — picking that range reproduces it. */
export function isGappyYearSelection(
  selected: ReadonlyArray<number>,
  choices?: ReadonlyArray<number | null>,
): boolean {
  if (selected.length < 2) return false;
  const sorted = [...selected].sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  const picked = new Set(sorted);
  if (choices === undefined) return sorted.some((y, i) => i > 0 && y !== sorted[i - 1] + 1);
  return choices.some((y) => y !== null && y > lo && y < hi && !picked.has(y));
}

/** A graduation-year selection as the rail summary and chip read it:
 *  `[]` → "All years"; a run with no gap (`isGappyYearSelection` against
 *  `choices`, the years that exist) → "2026–2027"; otherwise the years
 *  listed; `null` (no graduation year) → "+ unknown", or "No graduation
 *  year" alone. */
export function gradYearsLabel(
  years: ReadonlyArray<number | null>,
  choices?: ReadonlyArray<number | null>,
): string {
  if (years.length === 0) return "All years";
  const known = years.filter((y): y is number => y !== null).sort((a, b) => a - b);
  const unknown = years.includes(null);
  if (known.length === 0) return "No graduation year";
  const contiguous = !isGappyYearSelection(known, choices);
  const span =
    known.length === 1
      ? String(known[0])
      : contiguous
        ? `${known[0]}–${known[known.length - 1]}`
        : known.join(", ");
  return unknown ? `${span} + unknown` : span;
}
