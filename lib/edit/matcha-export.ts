/**
 * Sponsor-match export: the officer's working list, as a spreadsheet.
 *
 * `.xlsx`, written on the server (`POST /api/edit/matcha/export`, `lib/edit/matcha-xlsx.ts`).
 * The CSV it replaced opened as mojibake in Mac Excel (UTF-8 with no BOM is read as Mac Roman).
 * This module stays client-safe: the panel builds `MatchaExportRow`s from what it already holds
 * and posts them; ExcelJS never reaches the browser bundle.
 *
 * FORMULA INJECTION IS A REAL RISK HERE, not a theoretical one. The concept terms in these
 * rows are derived from a PASTED SPONSOR EMAIL — untrusted text that reaches a spreadsheet a
 * fundraising officer will open. The workbook writes every cell as a string value (never a
 * formula) and still applies the OWASP guard (`guardFormula`) to a leading `=`, `+`, `-` or `@`.
 *
 * WHAT IS DELIBERATELY NOT A COLUMN: `fusedScore`. It is a query-scaled RRF sum that is not
 * comparable across searches and means nothing on its own, and the UI ⇄ ranker contract keeps
 * it out of the DOM on purpose (`sponsor-match-contract.ts`). Exporting it would launder the
 * number the contract withholds into a spreadsheet cell that looks authoritative. The `Fit`
 * column carries the TIER LABEL instead — the sanctioned abstraction.
 */
import {
  briefAngle,
  briefSourceLabel,
  briefTopics,
  briefWhy,
  type BriefWire,
} from "@/lib/edit/matcha-brief-types";

/** One exported row. Every field is already on the wire or derived client-side from it —
 *  this export adds no new data requirement to the ranker. */
export type MatchaExportRow = {
  /** The FIT rank, taken before filtering — so a filtered export still says "#7 overall",
   *  matching what the row shows on screen. Never the position within the filtered subset. */
  rank: number;
  cwid: string;
  name: string;
  title: string | null;
  department: string | null;
  /** The tier LABEL ("Strong fit"), never the fused score. */
  fit: string;
  /** The concepts this person actually ranked under. */
  matchedConcepts: readonly string[];
  technologyCount: number;
  /** #1654 — display label ("Early career"), or "" when the measure is absent. Empty means
   *  UNKNOWN, never "no stage": a blank cell is the honest rendering of a missing signal. */
  careerStage: string;
  /** #1654 — "Yes" / "No" / "" (absent). Same rule: blank is unknown, not "not a clinician". */
  clinician: string;
  /** ED person type as its display label ("Postdoc"), or "" when absent. Blank is unknown. */
  personType: string;
  /** Researcher type label ("Physician-scientist"), or "" when absent. Blank is unknown. */
  researcherType: string;
  /** Research kind labels joined with "; " ("Laboratory research; Clinical research"),
   *  "None evident" when computed and empty, or "" when absent. Blank is unknown. */
  researchKind: string;
  /** Absolute profile URL, so the cell is clickable when pasted anywhere. */
  profileUrl: string;
  /** Grant Matcha — "Yes"/"No" against the opportunity's STATED career-stage rule, the same
   *  predicate the results gate applies. The export deliberately carries the PRE-gate set (an
   *  officer's outreach list), so this column is what keeps the file from silently contradicting
   *  the page that produced it. Only written when `buildMatchaRows` is asked for the column —
   *  `/edit/matcha` states no rule, and its file must not grow a column of blanks. */
  eligible?: string;
  /** Matcha Phase 3 — Why this PI (the officer's edit when present). Written only when
   *  `buildMatchaRows` is asked for the brief columns; "" when the row has no brief. */
  briefWhy?: string;
  /** Matcha Phase 3 — the partnership angle (the officer's edit when present); "" when none, and
   *  the `NO_LAB_ANGLE` sentence when the draft found no laboratory angle. */
  briefAngle?: string;
  /** Matcha Phase 3 — discussion topics with their source labels, edited text when present. */
  briefTopics?: string;
};

/**
 * The brief's exported cells, from a wire brief. The NOTE IS NEVER READ HERE: it is shared
 * with anyone who opens the search and is labelled "Never exported" in the UI, so this function
 * is the one place an export could leak it, and it takes only the fields it writes.
 */
export function briefExportFields(brief: Pick<BriefWire, "generated" | "edited"> | undefined): {
  briefWhy: string;
  briefAngle: string;
  briefTopics: string;
} {
  if (!brief) return { briefWhy: "", briefAngle: "", briefTopics: "" };
  return {
    briefWhy: briefWhy(brief),
    briefAngle: briefAngle(brief),
    briefTopics: briefTopics(brief)
      .map((t) =>
        t.sources.length > 0
          ? `${t.text} [${t.sources.map(briefSourceLabel).join("; ")}]`
          : `${t.text} [unsourced]`,
      )
      .join(" | "),
  };
}

const HEADERS = [
  "Rank",
  "CWID",
  "Name",
  "Title",
  "Department",
  "Fit",
  "Matched concepts",
  "Person type",
  "Career stage",
  "Clinician",
  "Researcher type",
  "Research kind",
  "CTL technologies",
  "Profile URL",
] as const;

/** Column headers that hold long prose: the workbook caps and wraps these. */
export const MATCHA_LONG_TEXT_HEADERS: ReadonlySet<string> = new Set([
  "Matched concepts",
  "Why this PI",
  "Partnership angle",
  "Discussion topics",
]);

export type MatchaExportOpts = { eligibility?: boolean; brief?: boolean };
export type MatchaExportTable = {
  header: string[];
  body: (string | number)[][];
};

export function buildMatchaRows(
  rows: readonly MatchaExportRow[],
  /** `eligibility: true` (Grant Matcha) appends the `Eligible` column — an OPTION, not inferred
   *  from the rows, so an empty grant-path export still writes the header the full one would.
   *  `brief: true` (MATCHA_BRIEF) appends the three brief columns, same rule. */
  opts: MatchaExportOpts = {},
): MatchaExportTable {
  return {
    header: [
      ...HEADERS,
      ...(opts.eligibility ? ["Eligible"] : []),
      ...(opts.brief ? ["Why this PI", "Partnership angle", "Discussion topics"] : []),
    ],
    body: rows.map((r) => [
      r.rank,
      r.cwid,
      r.name,
      r.title ?? "",
      r.department ?? "",
      r.fit,
      r.matchedConcepts.join("; "),
      r.personType,
      r.careerStage,
      r.clinician,
      r.researcherType,
      r.researchKind,
      r.technologyCount,
      r.profileUrl,
      ...(opts.eligibility ? [r.eligible ?? ""] : []),
      ...(opts.brief ? [r.briefWhy ?? "", r.briefAngle ?? "", r.briefTopics ?? ""] : []),
    ]),
  };
}

/** `matcha-<title>-<date>.xlsx`, with `-shortlist` before the date for the shortlist file:
 *  the two files share columns but not meaning, so they must not share a name. Shared by the
 *  route's Content-Disposition and the panel's download name. */
export function matchaExportFilename(
  title: string | null | undefined,
  shortlist: boolean,
  date: Date,
): string {
  const slug =
    (title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60)
      .replace(/^-+|-+$/g, "") || "researchers";
  return `matcha-${slug}${shortlist ? "-shortlist" : ""}-${date.toISOString().slice(0, 10)}.xlsx`;
}
