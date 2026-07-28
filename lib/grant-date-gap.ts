/**
 * #2020 — lifecycle + reporting shape for InfoEd awards with no project period.
 *
 * Pure: no DB, no fetch. `etl/infoed` owns the I/O; this owns the decisions, so
 * the rules that make the worklist trustworthy are unit-testable in isolation.
 *
 * The governing rule is that a RePORTER backfill makes a grant VISIBLE but does
 * NOT make the source correct. If a backfill closed the gap, InfoEd would stay
 * wrong forever and the ~124 active non-NIH awards RePORTER cannot reach would
 * never be fixed by anyone. So `backfilled` is an OPEN state, not a terminal one.
 */

/** Lifecycle states. `resolved` and `dismissed` are terminal-ish: `resolved`
 *  can reopen if InfoEd loses the dates again, `dismissed` never reopens. */
export type GapStatus = "open" | "backfilled" | "resolved" | "dismissed";

export const GAP_STATUSES: readonly GapStatus[] = [
  "open",
  "backfilled",
  "resolved",
  "dismissed",
] as const;

/** Which side of the period InfoEd is missing. */
export type MissingField = "start" | "end" | "both";

export function missingField(
  beginDate: Date | null,
  endDate: Date | null,
): MissingField | null {
  if (beginDate === null && endDate === null) return "both";
  if (beginDate === null) return "start";
  if (endDate === null) return "end";
  return null;
}

/**
 * Next lifecycle state for one award on this run.
 *
 * `existing` is the stored status, or null on first sight.
 */
export function nextGapStatus(
  existing: GapStatus | null,
  input: { stillUndated: boolean; backfilled: boolean },
): GapStatus {
  // Dismissed is a human judgement that this award legitimately has no period.
  // Never re-nag, even if it is still undated — that is the entire point of
  // recording the dismissal, and the reason the recipient keeps reading the list.
  if (existing === "dismissed") return "dismissed";

  // InfoEd now supplies a period. This is the only success condition, and only
  // the source can produce it.
  if (!input.stillUndated) return "resolved";

  // Still undated. Backfilled means the grant renders off a derived period —
  // better for the faculty member, no better for the data.
  return input.backfilled ? "backfilled" : "open";
}

/** Statuses that still need OSRA action. `backfilled` is included on purpose. */
export function isActionable(status: GapStatus): boolean {
  return status === "open" || status === "backfilled";
}

/** One row of the OSRA-facing report. */
export interface GapReportRow {
  cwid: string;
  scholarName: string;
  accountNumber: string;
  awardNumber: string | null;
  sponsor: string | null;
  projectStatus: string;
  programType: string;
  unitName: string | null;
  missingField: string;
  status: GapStatus;
  backfillSource: string | null;
  firstSeenAt: Date;
  daysOpen: number;
}

const CSV_HEADERS = [
  "cwid",
  "scholar_name",
  "account_number",
  "award_number",
  "sponsor",
  "project_status",
  "program_type",
  "unit_name",
  "missing_field",
  "gap_status",
  "backfill_source",
  "first_seen",
  "days_open",
] as const;

/** RFC 4180 quoting. Award numbers and unit names contain commas, and a
 *  sponsor name can contain a double quote — an unquoted dump silently
 *  corrupts the recipient's spreadsheet, which is worse than no report. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function daysOpen(firstSeenAt: Date, now: Date): number {
  const ms = now.getTime() - firstSeenAt.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}

/** The full CSV, header included. Sorted worst-first: active awards before
 *  expired, then longest-open, so the top of the file is the work that matters. */
export function toCsv(rows: GapReportRow[]): string {
  const rank = (s: string) =>
    s === "Active Award" ? 0 : s === "In Process" ? 1 : 2;
  const sorted = [...rows].sort(
    (a, b) =>
      rank(a.projectStatus) - rank(b.projectStatus) ||
      b.daysOpen - a.daysOpen ||
      a.accountNumber.localeCompare(b.accountNumber),
  );
  const lines = [CSV_HEADERS.join(",")];
  for (const r of sorted) {
    lines.push(
      [
        r.cwid,
        r.scholarName,
        r.accountNumber,
        r.awardNumber,
        r.sponsor,
        r.projectStatus,
        r.programType,
        r.unitName,
        r.missingField,
        r.status,
        r.backfillSource,
        r.firstSeenAt.toISOString().slice(0, 10),
        r.daysOpen,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}
