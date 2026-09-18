/**
 * Query-string contract shared by the `/edit/reports/7` page and its
 * `.xlsx` download route (`/api/edit/reports/mentored-publications`) — one
 * parser so the link the page renders and the params the route accepts can
 * never disagree:
 *   - `years`   graduation years, comma-separated and/or repeated
 *               (`years=2024,2025` from a link, `years=2024&years=2025` from
 *               the page's checkbox group); `years=all` = every year; absent
 *               → the caller's default: the two most recent years in scope;
 *   - `program` one of `MENTORED_PUBS_SCOPES`, or `all` / absent;
 *   - `tail`    integer 0..MAX_TAIL, default DEFAULT_TAIL.
 * Malformed input is an error (the route 400s; the page falls back to its
 * defaults) rather than a silent coercion. Pure — no DB, safe anywhere.
 */
import { DEFAULT_TAIL, MAX_TAIL } from "@/lib/edit/mentored-publications-report";
import { MENTORED_PUBS_SCOPES, type MentoredPubsScope } from "@/lib/edit/report-access";

export type MentoredPubsParams = {
  /** Explicit graduation years; `[]` = every year (`years=all`); null =
   *  not given, the caller applies its default. */
  years: number[] | null;
  /** A single program bucket, or null for "every scope the caller holds". */
  program: MentoredPubsScope | null;
  tail: number;
};

export type ParsedMentoredPubsParams =
  | { ok: true; value: MentoredPubsParams }
  | { ok: false; error: "invalid_years" | "invalid_program" | "invalid_tail" };

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

  let years: number[] | null = null;
  const yearTokens = getAll("years")
    .flatMap((v) => v.split(","))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (yearTokens.some((t) => t.toLowerCase() === "all")) {
    years = [];
  } else if (yearTokens.length > 0) {
    const out = new Set<number>();
    for (const t of yearTokens) {
      if (!/^\d{4}$/.test(t)) return { ok: false, error: "invalid_years" };
      const n = Number(t);
      if (n < YEAR_MIN || n > YEAR_MAX) return { ok: false, error: "invalid_years" };
      out.add(n);
    }
    years = [...out].sort((a, b) => a - b);
  }

  let program: MentoredPubsScope | null = null;
  const rawProgram = get("program")?.trim().toLowerCase();
  if (rawProgram && rawProgram !== "all") {
    if (!(MENTORED_PUBS_SCOPES as readonly string[]).includes(rawProgram)) {
      return { ok: false, error: "invalid_program" };
    }
    program = rawProgram as MentoredPubsScope;
  }

  let tail = DEFAULT_TAIL;
  const rawTail = get("tail")?.trim();
  if (rawTail !== undefined && rawTail !== "") {
    if (!/^\d$/.test(rawTail)) return { ok: false, error: "invalid_tail" };
    tail = Number(rawTail);
    if (tail > MAX_TAIL) return { ok: false, error: "invalid_tail" };
  }

  return { ok: true, value: { years, program, tail } };
}

/** The query string the page's links and the download button carry — the
 *  inverse of `parseMentoredPubsParams`, so a round-trip is lossless. */
export function mentoredPubsQueryString(p: MentoredPubsParams): string {
  const sp = new URLSearchParams();
  if (p.years !== null) sp.set("years", p.years.length > 0 ? p.years.join(",") : "all");
  sp.set("program", p.program ?? "all");
  sp.set("tail", String(p.tail));
  return sp.toString();
}
