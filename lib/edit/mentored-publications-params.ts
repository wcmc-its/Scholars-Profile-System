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
 *               route accepts and ignores it so one link shape serves both.
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
};

export type ParsedMentoredPubsParams =
  | { ok: true; value: MentoredPubsParams }
  | {
      ok: false;
      error: "invalid_years" | "invalid_types" | "invalid_tail" | "invalid_pubs" | "invalid_view";
    };

const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

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

  return { ok: true, value: { years, types, tail, pubs, view } };
}

/** The query string the page's links and the download button carry — the
 *  inverse of `parseMentoredPubsParams`, so a round-trip is lossless. `mtype`
 *  and `pubs` are written whenever known (the download link must carry
 *  them; the page always resolves both); `view` only when it is not the
 *  default, so the download link stays view-free. `program` is never
 *  written, nor `types` — both are read-only legacy. */
export function mentoredPubsQueryString(p: MentoredPubsParams): string {
  const sp = new URLSearchParams();
  if (p.years !== null) {
    sp.set("years", p.years.length > 0 ? p.years.map((y) => y ?? "unknown").join(",") : "all");
  }
  if (p.types !== null) sp.set("mtype", p.types.join(","));
  sp.set("tail", String(p.tail));
  sp.set("pubs", p.pubs);
  if (p.view !== "summary") sp.set("view", p.view);
  return sp.toString();
}
