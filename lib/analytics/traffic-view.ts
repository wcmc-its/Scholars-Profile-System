/**
 * The Usage dashboard's traffic view model, and the pure helpers that shape it:
 * Athena rows -> {@link TrafficOverview}, the week / month periods a range
 * splits into, and per-period sums. No server imports, so the client islands
 * (grain toggle, chips) and the Excel builder share one implementation.
 *
 * Weeks start on Monday, like Athena's `date_trunc('week', …)`. A period is
 * clipped to the range, so a range that starts mid-week opens with a short
 * week and its label says so ("Oct 21–25").
 */
import {
  REFERRER_CATEGORIES,
  type ReferrerCategory,
  isReferrerCategory,
} from "@/lib/analytics/referrer-category";

/** A result row keyed by column alias (Athena returns every cell as a string). */
export type Row = Record<string, string>;

export type Grain = "week" | "month";

export type TrafficKpi = {
  hits: number;
  pageviews: number;
  /** Average of the per-day visitor estimates (days with a row). */
  visitorsAvg: number;
  /** Days the visitor average covers. */
  visitorDays: number;
  /** Average of the per-day engaged-visitor estimates (days with a row);
   *  null when no day in range has one (before the rollup wrote them). */
  engagedAvg: number | null;
  /** Days the engaged average covers. */
  engagedDays: number;
};
export type SourceDay = { dt: string; category: ReferrerCategory; visits: number };
export type AiDay = { dt: string; referral: number; fetch: number; crawler: number };
export type VendorCount = { vendor: string; count: number };

export type TrafficOverview = {
  /** The requested window (inclusive). */
  since: string;
  until: string;
  /** First day daily_traffic holds at all; null before the first rollup. */
  firstDt: string | null;
  kpi: TrafficKpi;
  sourcesDaily: SourceDay[];
  referrers: {
    /** Every external referral, '(other)' included. */
    total: number;
    /** Referrals folded into the daily '(other)' row (past the top 5,000). */
    other: number;
    /** Referrals whose referrer names the site only, not a page. */
    siteOnly: number;
  };
  aiDaily: AiDay[];
  vendors: VendorCount[];
};

export type TrafficOverviewRows = {
  kpi: Row[];
  sourcesDaily: Row[];
  referrerTotals: Row[];
  aiDaily: Row[];
  vendors: Row[];
  firstDt: Row[];
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an Athena numeric cell to a finite number, else 0. */
export function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function shapeTrafficOverview(
  rows: TrafficOverviewRows,
  window: { since: string; until: string },
): TrafficOverview {
  const kpiRow = (k: string) => rows.kpi.find((r) => r.kind === k);
  const visitors = kpiRow("visitors");
  const visitorDays = num(visitors?.days);
  const engaged = kpiRow("engaged_visitors");
  const engagedDays = num(engaged?.days);
  const aiByDt = new Map<string, AiDay>();
  for (const r of rows.aiDaily) {
    const dt = r.dt ?? "";
    if (!ISO.test(dt)) continue;
    const series = r.series;
    if (series !== "referral" && series !== "fetch" && series !== "crawler") continue;
    const day = aiByDt.get(dt) ?? { dt, referral: 0, fetch: 0, crawler: 0 };
    day[series] += num(r.cnt);
    aiByDt.set(dt, day);
  }
  const totals = rows.referrerTotals[0] ?? {};
  const first = rows.firstDt[0]?.first_dt ?? "";
  return {
    since: window.since,
    until: window.until,
    firstDt: ISO.test(first) ? first : null,
    kpi: {
      hits: num(kpiRow("hits")?.cnt),
      pageviews: num(kpiRow("pageviews")?.cnt),
      visitorsAvg: visitorDays > 0 ? Math.round(num(visitors?.cnt) / visitorDays) : 0,
      visitorDays,
      engagedAvg: engagedDays > 0 ? Math.round(num(engaged?.cnt) / engagedDays) : null,
      engagedDays,
    },
    sourcesDaily: rows.sourcesDaily.flatMap((r) =>
      ISO.test(r.dt ?? "") && isReferrerCategory(r.category ?? "")
        ? [{ dt: r.dt, category: r.category as ReferrerCategory, visits: num(r.visits) }]
        : [],
    ),
    referrers: {
      total: num(totals.total),
      other: num(totals.other),
      siteOnly: num(totals.site_only),
    },
    aiDaily: [...aiByDt.values()].sort((a, b) => a.dt.localeCompare(b.dt)),
    vendors: rows.vendors
      .map((r) => ({ vendor: r.vendor ?? "", count: num(r.cnt) }))
      .filter((v) => v.vendor !== ""),
  };
}

const DAY_MS = 86_400_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parts = (d: string) => d.split("-").map(Number) as [number, number, number];

export type Period = {
  /** The period's first day before clipping (a Monday, or the 1st). */
  key: string;
  /** Clipped bounds, inclusive. */
  start: string;
  end: string;
  /** "Nov 9–15", "Oct 26–Nov 1", "October", "November 1–15". */
  label: string;
};

function weekLabel(start: string, end: string): string {
  const [, m1, d1] = parts(start);
  const [, m2, d2] = parts(end);
  if (start === end) return `${MON[m1 - 1]} ${d1}`;
  return m1 === m2 ? `${MON[m1 - 1]} ${d1}–${d2}` : `${MON[m1 - 1]} ${d1}–${MON[m2 - 1]} ${d2}`;
}

function monthLabelFor(start: string, end: string, withYear: boolean): string {
  const [y, m, d1] = parts(start);
  const [, , d2] = parts(end);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const year = withYear ? ` ${y}` : "";
  if (d1 === 1 && d2 === lastDay) return `${MONTH[m - 1]}${year}`;
  const span = d1 === d2 ? `${d1}` : `${d1}–${d2}`;
  return `${MONTH[m - 1]} ${span}${withYear ? `, ${y}` : ""}`;
}

/** Upper bound on periods, so a bad bound can't spin (about six years of weeks). */
const MAX_PERIODS = 320;

/** The weeks (Monday start) or months covering `[since, until]`, clipped to it. */
export function trafficPeriods(since: string, until: string, grain: Grain): Period[] {
  if (!ISO.test(since) || !ISO.test(until) || since > until) return [];
  const out: Period[] = [];
  const withYear = since.slice(0, 4) !== until.slice(0, 4);
  let t = ms(since);
  const endT = ms(until);
  while (t <= endT && out.length < MAX_PERIODS) {
    const d = new Date(t);
    let keyT: number;
    let nextT: number;
    if (grain === "week") {
      keyT = t - ((d.getUTCDay() + 6) % 7) * DAY_MS;
      nextT = keyT + 7 * DAY_MS;
    } else {
      keyT = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      nextT = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    const start = iso(t);
    const end = iso(Math.min(nextT - DAY_MS, endT));
    out.push({
      key: iso(keyT),
      start,
      end,
      label: grain === "week" ? weekLabel(start, end) : monthLabelFor(start, end, withYear),
    });
    t = nextT;
  }
  return out;
}

/** The index of the period holding `dt`, or -1. */
export function periodIndexOf(periods: readonly Period[], dt: string): number {
  for (let i = 0; i < periods.length; i++) {
    if (dt >= periods[i].start && dt <= periods[i].end) return i;
  }
  return -1;
}

/** Referred visits per category per period (every category, zeros included). */
export function bucketSources(
  days: readonly SourceDay[],
  periods: readonly Period[],
): Record<ReferrerCategory, number[]> {
  const out = Object.fromEntries(
    REFERRER_CATEGORIES.map((c) => [c, periods.map(() => 0)]),
  ) as Record<ReferrerCategory, number[]>;
  for (const d of days) {
    const i = periodIndexOf(periods, d.dt);
    if (i >= 0) out[d.category][i] += d.visits;
  }
  return out;
}

export type AiSeries = { referral: number[]; fetch: number[]; crawler: number[] };

export function bucketAi(days: readonly AiDay[], periods: readonly Period[]): AiSeries {
  const out: AiSeries = {
    referral: periods.map(() => 0),
    fetch: periods.map(() => 0),
    crawler: periods.map(() => 0),
  };
  for (const d of days) {
    const i = periodIndexOf(periods, d.dt);
    if (i < 0) continue;
    out.referral[i] += d.referral;
    out.fetch[i] += d.fetch;
    out.crawler[i] += d.crawler;
  }
  return out;
}

/** The first day the traffic charts cover: the range start, or the first rollup day if later. */
export function trafficStart(o: Pick<TrafficOverview, "since" | "firstDt">): string {
  return o.firstDt && o.firstDt > o.since ? o.firstDt : o.since;
}

/** 11,300,000 -> "11.3M", 4,450,000 -> "4.45M", 27,400 -> "27k", 8,512 -> "8,512". */
export function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}

/** A share as a one-decimal percent ("12.3%"); "0%" for an empty total. */
export function sharePct(part: number, whole: number): string {
  return whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "0%";
}

/** Shape of one list row as the route returns it. */
export type TrafficListRow = { label: string; category?: ReferrerCategory; visits: number };
export type TrafficListPage = { rows: TrafficListRow[]; total: number };

/** Referrer list rows (ref, category, visits, total) -> a list page. */
export function shapeReferrerList(rows: Row[]): TrafficListPage {
  return {
    rows: rows.map((r) => ({
      label: r.ref ?? "",
      category: isReferrerCategory(r.category ?? "") ? (r.category as ReferrerCategory) : "Other",
      visits: num(r.visits),
    })),
    total: num(rows[0]?.total),
  };
}

/** Page list rows (page, visits, total) -> a list page. */
export function shapePageList(rows: Row[]): TrafficListPage {
  return {
    rows: rows.map((r) => ({ label: r.page ?? "", visits: num(r.visits) })),
    total: num(rows[0]?.total),
  };
}
