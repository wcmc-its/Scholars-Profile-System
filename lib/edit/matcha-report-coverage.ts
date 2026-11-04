/**
 * Matcha report v2: the pure half of the coverage table, the theme-output validator and the
 * shortlist's signal chips. No db, no LLM, no env: everything here is a function of the stored
 * result, the theme grouping and the PI's live records, so it is unit-tested directly.
 *
 * Client-safe by construction (no server-only imports), though only the server report uses it.
 */
import type { MatchaContribution } from "@/lib/api/matcha-contract";
import type { BriefRecords } from "@/lib/edit/matcha-brief-types";

/** A cell is PRIMARY when the PI's best rank under any concept in the theme is at most this. */
export const PRIMARY_RANK = 10;
/** The coverage table fits this many theme columns. */
export const MAX_THEMES = 6;
/** "Short, at most about 4 words": the validator allows a little slack. */
export const MAX_THEME_LABEL_WORDS = 6;
export const MAX_THEME_LABEL_CHARS = 60;
/** Signal chips per PI on the shortlist. */
export const MAX_SIGNAL_CHIPS = 2;

/** One theme: a short label and the concept terms (`MatchaConcept.term`) it groups. */
export type ReportTheme = { label: string; terms: string[] };

export type CoverageMark = "primary" | "related" | "none";

export type CoverageRow = { cwid: string; marks: CoverageMark[]; bestRanks: (number | null)[] };

export type CoverageGap = {
  label: string;
  /** The PI with a related mark and the best rank in this theme; null when nobody has one. */
  closestCwid: string | null;
};

export type Coverage = {
  rows: CoverageRow[];
  /** Per theme: the number of PIs with any mark, or "None". */
  totals: string[];
  gaps: CoverageGap[];
};

// ── Theme-output validator ───────────────────────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Check the model's grouping against the stored concept terms and canonicalise it. Returns the
 * themes with every term spelled exactly as the stored concept, or null when ANY rule fails:
 * 1 to `MAX_THEMES` themes, each with a non-empty short label and at least one term, no unknown
 * term, and every concept term in exactly one theme.
 */
export function validateThemes(
  raw: unknown,
  conceptTerms: readonly string[],
): ReportTheme[] | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { themes?: unknown }).themes;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_THEMES) return null;
  const canon = new Map(conceptTerms.map((t) => [norm(t), t]));
  if (canon.size === 0) return null;
  const seen = new Set<string>();
  const out: ReportTheme[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const { label, terms } = item as { label?: unknown; terms?: unknown };
    if (typeof label !== "string" || !Array.isArray(terms) || terms.length === 0) return null;
    const l = label.trim().replace(/\s+/g, " ");
    if (!l || l.length > MAX_THEME_LABEL_CHARS || l.split(" ").length > MAX_THEME_LABEL_WORDS) {
      return null;
    }
    const mapped: string[] = [];
    for (const t of terms) {
      if (typeof t !== "string") return null;
      const c = canon.get(norm(t));
      if (!c || seen.has(c)) return null; // unknown, or assigned twice
      seen.add(c);
      mapped.push(c);
    }
    out.push({ label: l, terms: mapped });
  }
  return seen.size === canon.size ? out : null;
}

// ── Coverage ─────────────────────────────────────────────────────────────────

/** The PI's best (lowest) rank over the theme's concepts, or null when they rank under none. */
export function bestRank(
  contributions: readonly MatchaContribution[],
  terms: readonly string[],
): number | null {
  const set = new Set(terms);
  let best: number | null = null;
  for (const c of contributions) {
    if (set.has(c.term) && Number.isFinite(c.rank) && (best === null || c.rank < best))
      best = c.rank;
  }
  return best;
}

export function coverageMark(rank: number | null): CoverageMark {
  if (rank === null) return "none";
  return rank <= PRIMARY_RANK ? "primary" : "related";
}

/**
 * The PI × theme grid, the totals row and the gaps, in the order given. A gap is a theme with no
 * primary cell; its closest PI is the related one with the best rank (ties go to the PI listed
 * first, i.e. the better-ranked PI in the report).
 */
export function computeCoverage(
  pis: readonly { cwid: string; contributions: readonly MatchaContribution[] }[],
  themes: readonly ReportTheme[],
): Coverage {
  const rows: CoverageRow[] = pis.map((pi) => {
    const bestRanks = themes.map((t) => bestRank(pi.contributions, t.terms));
    return { cwid: pi.cwid, bestRanks, marks: bestRanks.map(coverageMark) };
  });
  const totals = themes.map((_, j) => {
    const n = rows.filter((r) => r.marks[j] !== "none").length;
    return n === 0 ? "None" : String(n);
  });
  const gaps: CoverageGap[] = [];
  themes.forEach((t, j) => {
    if (rows.some((r) => r.marks[j] === "primary")) return;
    let closest: CoverageRow | null = null;
    for (const r of rows) {
      const rank = r.bestRanks[j];
      if (rank !== null && (closest === null || rank < closest.bestRanks[j]!)) closest = r;
    }
    gaps.push({ label: t.label, closestCwid: closest?.cwid ?? null });
  });
  return { rows, totals, gaps };
}

// ── Signal chips (deterministic, records only) ───────────────────────────────

/** NIH centre / programme mechanisms worth a chip, and how each reads. */
const CENTER_MECHANISMS: Record<string, string> = {
  P01: "P01 program project",
  P20: "P20 center",
  P2C: "P2C center",
  P30: "P30 center",
  P50: "P50 center",
  P60: "P60 center",
  U19: "U19 program",
  U2C: "U2C center",
  U54: "U54 center",
};

/**
 * At most `MAX_SIGNAL_CHIPS` chips from records the report already holds, strongest first: a
 * centre mechanism, a licensable technology, then the active award count ("3 active NIH awards"
 * when every award is NIH, which is when each carries a mechanism; "3 active awards" otherwise).
 */
export function signalChips(funding: BriefRecords["funding"], technologyCount: number): string[] {
  const chips: string[] = [];
  const center = funding
    .map((g) => (g.mechanism ? CENTER_MECHANISMS[g.mechanism.toUpperCase()] : undefined))
    .find((label): label is string => label !== undefined);
  if (center) chips.push(center);
  if (technologyCount > 0) chips.push("Licensable technology");
  const n = funding.length;
  if (n > 0) {
    const nih = funding.every((g) => g.mechanism != null && g.mechanism !== "");
    chips.push(`${n} active ${nih ? "NIH " : ""}award${n === 1 ? "" : "s"}`);
  }
  return chips.slice(0, MAX_SIGNAL_CHIPS);
}

// ── Words ────────────────────────────────────────────────────────────────────

const SMALL = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];

/** 0–59 in words ("eleven", "twenty-three"); anything larger stays a numeral. */
export function numberWord(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 60) return String(n);
  if (n < 20) return SMALL[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 === 0 ? t : `${t}-${SMALL[n % 10]}`;
}

export function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "A", "A and B", "A, B and C". */
export function joinWords(items: readonly string[], conj = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`;
}
