/**
 * Sponsor-match CSV export — the officer's working list, as a spreadsheet.
 *
 * CSV, not .xlsx, and that is a decision rather than a shortcut: no spreadsheet library is a
 * dependency and `lib/csv.ts` documents the org's reason for keeping it that way (ExcelJS
 * pulls ~1MB of zip/stream code Scholars does not need). The mockup's stated reason for
 * wanting .xlsx was "linked names" — the `Profile URL` column delivers that, and Excel,
 * Sheets and Numbers all open UTF-8 CSV natively.
 *
 * FORMULA INJECTION IS A REAL RISK HERE, not a theoretical one. The concept terms in these
 * rows are derived from a PASTED SPONSOR EMAIL — untrusted text that reaches a spreadsheet a
 * fundraising officer will open. `toCsv` applies the OWASP CSV-injection guard (a leading
 * `=`, `+`, `-` or `@` is neutralised), which is the reason to route through it rather than
 * join strings by hand.
 *
 * WHAT IS DELIBERATELY NOT A COLUMN: `fusedScore`. It is a query-scaled RRF sum that is not
 * comparable across searches and means nothing on its own, and the UI ⇄ ranker contract keeps
 * it out of the DOM on purpose (`sponsor-match-contract.ts`). Exporting it would launder the
 * number the contract withholds into a spreadsheet cell that looks authoritative. The `Fit`
 * column carries the TIER LABEL instead — the sanctioned abstraction.
 *
 * Career stage / clinician / seniority are absent because the spine has no producer for them
 * (`measures` is optional and unset). Absent ≠ zero: no column beats a column of blanks that
 * reads as "none of these people are clinicians".
 */
import { toCsv } from "@/lib/csv";

/** One exported row. Every field is already on the wire or derived client-side from it —
 *  this export adds no new data requirement to the ranker. */
export type SponsorMatchCsvRow = {
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
  /** Absolute profile URL, so the cell is clickable when pasted anywhere. */
  profileUrl: string;
};

const HEADERS = [
  "Rank",
  "CWID",
  "Name",
  "Title",
  "Department",
  "Fit",
  "Matched concepts",
  "Career stage",
  "Clinician",
  "CTL technologies",
  "Profile URL",
] as const;

export function buildSponsorMatchCsv(rows: readonly SponsorMatchCsvRow[]): string {
  return toCsv(
    HEADERS,
    rows.map((r) => [
      r.rank,
      r.cwid,
      r.name,
      r.title ?? "",
      r.department ?? "",
      r.fit,
      r.matchedConcepts.join("; "),
      r.careerStage,
      r.clinician,
      r.technologyCount,
      r.profileUrl,
    ]),
  );
}
