/**
 * The `/edit/usage` date range: parses the `?range=` (and, for a custom range,
 * `?from=` / `?to=`) search params into an inclusive `[since, until]` window of
 * UTC calendar days over the `daily_usage` rollup. Pure (takes `today`), so it
 * unit-tests without a clock and can be imported by both the server page and
 * the client range picker.
 *
 * Every window ends YESTERDAY: the nightly rollup rolls the previous UTC day,
 * so today never has a partition yet. "Last N days" is therefore the N complete
 * days before today. A malformed or unknown param falls back to the default
 * (last 30 days) rather than erroring; a custom range is clamped to end no
 * later than yesterday and swapped if given backwards.
 */

/** The site's public launch (first full month of production traffic). Mirrors
 *  `LAUNCH_MONTH_START` in lib/api/service-health.ts, which starts the uptime
 *  trend at the same month. */
export const USAGE_LAUNCH_DATE = "2026-07-01";

export type UsageRangeKey = "7" | "30" | "90" | "launch" | "custom";

export const DEFAULT_USAGE_RANGE: UsageRangeKey = "30";

/** Dropdown options, in the mockup's order. `hint` is the muted right-hand text. */
export const USAGE_RANGE_OPTIONS: ReadonlyArray<{
  key: UsageRangeKey;
  label: string;
  hint?: string;
}> = [
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
  { key: "launch", label: "Since launch", hint: "Jul 2026" },
  { key: "custom", label: "Custom range…" },
];

export type UsageRange = {
  key: UsageRangeKey;
  /** First day in the window, inclusive (YYYY-MM-DD). */
  since: string;
  /** Last day in the window, inclusive (YYYY-MM-DD). */
  until: string;
  /** Calendar days in the window. */
  days: number;
  /** Dropdown label for the selected option ("Last 30 days", "Custom range"). */
  label: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A strict YYYY-MM-DD that is also a real calendar date (2026-02-30 is not). */
export function isRealIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** `iso` shifted by `delta` UTC days. */
export function addDays(iso: string, delta: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive day count of `[since, until]`. */
function spanDays(since: string, until: string): number {
  return (
    Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS) + 1
  );
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function labelFor(key: UsageRangeKey): string {
  return key === "custom"
    ? "Custom range"
    : (USAGE_RANGE_OPTIONS.find((o) => o.key === key)?.label ?? "Last 30 days");
}

function build(key: UsageRangeKey, since: string, until: string): UsageRange {
  return { key, since, until, days: spanDays(since, until), label: labelFor(key) };
}

/**
 * Resolve the page's search params to a window. `today` is the current UTC
 * calendar date (YYYY-MM-DD).
 */
export function resolveUsageRange(
  params: Record<string, string | string[] | undefined>,
  today: string,
): UsageRange {
  const yesterday = addDays(today, -1);
  const key = first(params.range);

  if (key === "7" || key === "30" || key === "90") {
    return build(key, addDays(today, -Number(key)), yesterday);
  }
  if (key === "launch") {
    // A clock before launch (a test, a misconfigured host) degrades to one day.
    const since = USAGE_LAUNCH_DATE <= yesterday ? USAGE_LAUNCH_DATE : yesterday;
    return build("launch", since, yesterday);
  }
  if (key === "custom") {
    const from = first(params.from);
    const to = first(params.to);
    if (from && to && isRealIsoDate(from) && isRealIsoDate(to)) {
      let [a, b] = from <= to ? [from, to] : [to, from];
      if (b > yesterday) b = yesterday;
      if (a > b) a = b;
      return build("custom", a, b);
    }
  }
  return build(DEFAULT_USAGE_RANGE, addDays(today, -Number(DEFAULT_USAGE_RANGE)), yesterday);
}

/** The query string that selects `key` (custom carries from/to). */
export function usageRangeHref(key: UsageRangeKey, from?: string, to?: string): string {
  if (key === "custom" && from && to) {
    return `/edit/usage?range=custom&from=${from}&to=${to}`;
  }
  return key === DEFAULT_USAGE_RANGE ? "/edit/usage" : `/edit/usage?range=${key}`;
}
