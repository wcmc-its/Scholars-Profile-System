/**
 * Pure helpers behind `GET /api/edit/feedback/export` (docs/feedback-badge-spec.md
 * § CSV export endpoint): the allowlist check, the `?from&to&pageRoute`
 * filter parse, and the RFC 4180 CSV of every `feedback_submission` column.
 *
 * Kept free of the DB and the request so the gate, the date window and the
 * quoting are unit-testable on their own.
 */
import type { FeedbackSubmission } from "@/lib/generated/prisma/client";

/** Default window when no `from`/`to` is given. */
export const FEEDBACK_EXPORT_DEFAULT_DAYS = 30;
/** Hard ceiling on one export; the CSV ends with a marker line when reached. */
export const FEEDBACK_EXPORT_LIMIT = 100_000;

/**
 * True when `cwid` is on `FEEDBACK_EXPORT_ALLOWLIST` (comma-separated, trimmed,
 * case-insensitive). Empty or unset means nobody: the IRB protocol, not the
 * superuser tier, decides who may read raw responses.
 */
export function isFeedbackExportAllowlisted(cwid: string, raw: string | undefined): boolean {
  if (!cwid || !raw) return false;
  const want = cwid.trim().toLowerCase();
  return raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .some((c) => c.length > 0 && c === want);
}

export type FeedbackExportFilters = {
  /** Inclusive first day, YYYY-MM-DD. */
  from: string;
  /** Inclusive last day, YYYY-MM-DD. */
  to: string;
  pageRoute: string | null;
  /** UTC midnight starting `from`. */
  start: Date;
  /** UTC midnight AFTER `to` (exclusive bound). */
  endExclusive: Date;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" → its UTC midnight, or null if not a real calendar day. */
function parseDay(v: string): Date | null {
  if (!DAY.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
}

/**
 * Parse the export filters. Days are UTC calendar days.
 * ponytail: UTC, not Eastern, day bounds — a submission between 19:00 and
 * 24:00 ET lands on the next UTC day. Fine for an analyst CSV; switch to
 * Eastern bounds if anyone reconciles counts against the console.
 * Returns `{ error, field }` for a malformed or reversed window.
 */
export function parseFeedbackExportFilters(
  sp: URLSearchParams,
  now: Date = new Date(),
): FeedbackExportFilters | { error: string; field: string } {
  const todayIso = now.toISOString().slice(0, 10);
  const rawTo = sp.get("to");
  const end = rawTo ? parseDay(rawTo) : parseDay(todayIso);
  if (!end) return { error: "invalid_to", field: "to" };
  const rawFrom = sp.get("from");
  const start = rawFrom
    ? parseDay(rawFrom)
    : new Date(end.getTime() - (FEEDBACK_EXPORT_DEFAULT_DAYS - 1) * 86_400_000);
  if (!start) return { error: "invalid_from", field: "from" };
  if (start.getTime() > end.getTime()) return { error: "from_after_to", field: "from" };
  const pageRoute = sp.get("pageRoute");
  if (pageRoute !== null && (pageRoute.length === 0 || pageRoute.length > 255)) {
    return { error: "invalid_page_route", field: "pageRoute" };
  }
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    pageRoute,
    start,
    endExclusive: new Date(end.getTime() + 86_400_000),
  };
}

/** DB column name → model field, in table order. Every column is exported. */
export const FEEDBACK_EXPORT_COLUMNS: ReadonlyArray<readonly [string, keyof FeedbackSubmission]> = [
  ["id", "id"],
  ["submitted_at", "submittedAt"],
  ["mode", "mode"],
  ["page_url", "pageUrl"],
  ["page_route", "pageRoute"],
  ["cwid", "cwid"],
  ["purpose", "purpose"],
  ["purpose_other", "purposeOther"],
  ["task_success", "taskSuccess"],
  ["task_failure_intent", "taskFailureIntent"],
  ["usefulness", "usefulness"],
  ["what_helped", "whatHelped"],
  ["what_missing", "whatMissing"],
  ["accuracy", "accuracy"],
  ["one_change", "oneChange"],
  ["would_use_again", "wouldUseAgain"],
  ["role", "role"],
  ["role_other", "roleOther"],
  ["consent", "consent"],
  ["consent_version", "consentVersion"],
  ["contact_email", "contactEmail"],
  ["followup_optin", "followupOptin"],
];

/**
 * One RFC 4180 cell. Free text comes from the public, so a value a
 * spreadsheet would run as a formula (leading = + - @, tab, CR) is prefixed
 * with `'` (OWASP CSV-injection guidance) before quoting.
 */
export function feedbackCsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The whole CSV: a header of DB column names, one line per submission. */
export function feedbackToCsv(rows: readonly FeedbackSubmission[], truncated: boolean): string {
  const lines = [FEEDBACK_EXPORT_COLUMNS.map(([col]) => col).join(",")];
  for (const r of rows) lines.push(FEEDBACK_EXPORT_COLUMNS.map(([, f]) => feedbackCsvCell(r[f])).join(","));
  if (truncated) lines.push(`# truncated at ${FEEDBACK_EXPORT_LIMIT} rows; narrow from/to`);
  return lines.join("\r\n");
}
