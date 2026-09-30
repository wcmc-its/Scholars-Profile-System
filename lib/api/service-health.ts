/**
 * The "Service health" section on `/edit/usage`: a 30-day uptime tile, an
 * availability-alarm-firings tile, and a monthly "Uptime since launch (July
 * 2026)" trend. Reads CloudWatch directly at runtime — never baked into the
 * image — using two task-def env vars the AppStack task definition sets from
 * live CDK references (cdk/lib/app-stack.ts, "Service-health section" block):
 *   - SPS_PUBLIC_ALB_FULL_NAME — the public ALB's AWS/ApplicationELB dimension
 *     name, for RequestCount / HTTPCode_ELB_5XX_Count / HTTPCode_Target_5XX_Count.
 *   - SPS_APP_UNAVAILABLE_ALARM — the `sps-app-unavailable-<env>` composite
 *     alarm this env pages on (built in observability-stack.ts), for the
 *     alarm-firings tile's state-transition history.
 * The matching read-only grant is TaskRoleCloudWatchReadPolicy in app-stack.ts.
 *
 * Availability = 1 - (HTTPCode_ELB_5XX_Count + HTTPCode_Target_5XX_Count) /
 * RequestCount, on daily (UTC calendar day) datapoints. This matches the
 * alarm semantics in docs/SLOs.md (its alarm #1, `sps-alb-5xx-rate-<env>`,
 * uses the same "5xx / RequestCount" shape); this tile additionally folds in
 * ELB-level 5xx (docs/SLOs.md's own alarm only counts Target_5XX) so an
 * ALB-side failure — not just an app-side one — counts against the tile. A
 * day/period CloudWatch has no 5xx datapoint for (no errors that period) is
 * treated as 0 — CloudWatch never emits an explicit 0, it just omits the
 * datapoint, so the daily series below always fills every UTC day in range
 * before the math runs.
 *
 * Every date computation here is UTC: "day" and "month" both mean UTC
 * calendar boundaries, matching how CloudWatch aligns a Period: 86400 metric
 * regardless of the query's StartTime/EndTime.
 *
 * Wrapped in `unstable_cache` (12h TTL, same as usage-summary.ts) — CloudWatch
 * is fast but this saves a round trip on every pageview. Any CloudWatch error
 * THROWS out of the uncached loader and is NEVER cached: a cached empty/zero
 * result would read as a fake outage (0% uptime) or a fake all-clear (no alarm
 * firings), which is worse than the page's own "unavailable" fallback.
 */
import { unstable_cache } from "next/cache";
import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

/** Rolling window the uptime + alarm-firings tiles cover. */
export const SERVICE_HEALTH_WINDOW_DAYS = 30;
/** Cache TTL — mirrors USAGE_CACHE_TTL_SECONDS in usage-summary.ts. */
const SERVICE_HEALTH_CACHE_TTL_SECONDS = 43_200; // 12h

/** First UTC calendar month of ALB metric history (empirically: the public
 *  ALB's CloudWatch history starts 2026-07-04; the trend starts at the
 *  calendar month regardless, so an early sparse July reads as low-traffic
 *  rather than being cut awkwardly mid-month). */
const LAUNCH_MONTH_START = "2026-07-01";
/** Cap once history is deeper than this. */
const MAX_TREND_MONTHS = 12;
/** A UTC calendar month/day under this many total requests is flagged
 *  low-traffic so a thin period can't read as an outage. */
const LOW_TRAFFIC_REQUEST_FLOOR = 1_000;

const METRIC_NAMESPACE = "AWS/ApplicationELB";
const DAILY_PERIOD_SECONDS = 86_400;

export type DailyAlbPoint = {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  elb5xx: number;
  target5xx: number;
  requestCount: number;
};

export type MonthlyAvailability = {
  /** UTC calendar month, YYYY-MM. */
  month: string;
  availabilityPercent: number;
  totalRequests: number;
  /** True when totalRequests is below LOW_TRAFFIC_REQUEST_FLOOR — the UI must
   *  render this month de-emphasized so it can't read as an outage. */
  lowTraffic: boolean;
};

export type ServiceHealthSummary = {
  windowDays: number;
  uptimePercent: number;
  alarmFirings: number;
  monthly: MonthlyAvailability[];
};

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`missing_env: ${name}`);
  return v;
}

/** UTC midnight for a given Date (or now). */
function utcMidnight(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addUtcDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAILY_PERIOD_SECONDS * 1000);
}

/**
 * 1 - (5xx)/requests, as a percent. A period with zero requests reports 100%
 * (no evidence of failure observed) — callers MUST consult the paired
 * `lowTraffic` flag before treating a zero/thin-traffic period as a genuine
 * healthy signal; the UI marks it "low traffic" rather than plotting it as a
 * clean 100%.
 */
export function computeAvailabilityPercent(
  elb5xx: number,
  target5xx: number,
  requestCount: number,
): number {
  if (requestCount <= 0) return 100;
  const failures = elb5xx + target5xx;
  return Math.max(0, Math.min(100, (1 - failures / requestCount) * 100));
}

/**
 * Pure aggregation: a UTC-daily ALB series -> UTC-calendar-month buckets,
 * ascending. Every month present in `daily` gets a bucket (including an
 * all-zero month, which still yields a 100%/low-traffic bucket rather than
 * being silently dropped) — the month boundary is purely `date.slice(0, 7)`,
 * so a run that crosses e.g. 2026-07-31 -> 2026-08-01 splits cleanly.
 */
export function bucketMonthlyAvailability(daily: DailyAlbPoint[]): MonthlyAvailability[] {
  const byMonth = new Map<string, { elb5xx: number; target5xx: number; requestCount: number }>();
  for (const d of daily) {
    const month = d.date.slice(0, 7);
    const acc = byMonth.get(month) ?? { elb5xx: 0, target5xx: 0, requestCount: 0 };
    acc.elb5xx += d.elb5xx;
    acc.target5xx += d.target5xx;
    acc.requestCount += d.requestCount;
    byMonth.set(month, acc);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, acc]) => ({
      month,
      availabilityPercent: computeAvailabilityPercent(acc.elb5xx, acc.target5xx, acc.requestCount),
      totalRequests: acc.requestCount,
      lowTraffic: acc.requestCount < LOW_TRAFFIC_REQUEST_FLOOR,
    }));
}

/** The 30-day tile: aggregates the trailing `windowDays` UTC days present in
 *  `daily` (the caller always fetches at least that many). */
export function computeTrailingUptimePercent(daily: DailyAlbPoint[], windowDays: number): number {
  const tail = daily.slice(-windowDays);
  const totals = tail.reduce(
    (acc, d) => ({
      elb5xx: acc.elb5xx + d.elb5xx,
      target5xx: acc.target5xx + d.target5xx,
      requestCount: acc.requestCount + d.requestCount,
    }),
    { elb5xx: 0, target5xx: 0, requestCount: 0 },
  );
  return computeAvailabilityPercent(totals.elb5xx, totals.target5xx, totals.requestCount);
}

/** Combines the daily series + alarm-firing count into the page view model. */
export function shapeServiceHealth(
  daily: DailyAlbPoint[],
  alarmFirings: number,
): ServiceHealthSummary {
  return {
    windowDays: SERVICE_HEALTH_WINDOW_DAYS,
    uptimePercent: computeTrailingUptimePercent(daily, SERVICE_HEALTH_WINDOW_DAYS),
    alarmFirings,
    monthly: bucketMonthlyAvailability(daily),
  };
}

/** Minimal CloudWatch surface (`any` cmd for assignability); injectable in tests —
 *  same shape as the ETL's MetricClient (etl/dynamodb/grant-opportunity-etl.ts). */
export type CloudWatchLikeClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (cmd: any) => Promise<any>;
};

function cloudWatchClient(): CloudWatchLikeClient {
  return new CloudWatchClient({
    region: process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
  });
}

/**
 * Fetch the public ALB's daily RequestCount / 5xx series over [startDate,
 * endDateExclusive) (UTC calendar days; endDateExclusive itself is NOT
 * included — callers pass "today's UTC midnight" so the always-partial
 * current day never skews a total). Missing datapoints (no errors, or no
 * traffic at all that day) fill as 0 so every day in range is represented.
 */
export async function fetchDailyAlbPoints(
  client: CloudWatchLikeClient,
  loadBalancerFullName: string,
  startDate: Date,
  endDateExclusive: Date,
): Promise<DailyAlbPoint[]> {
  const dims = [{ Name: "LoadBalancer", Value: loadBalancerFullName }];
  const query = (id: string, metricName: string) => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: METRIC_NAMESPACE, MetricName: metricName, Dimensions: dims },
      Period: DAILY_PERIOD_SECONDS,
      Stat: "Sum",
    },
    ReturnData: true,
  });

  const seriesById = new Map<string, Map<string, number>>([
    ["requests", new Map()],
    ["elb5xx", new Map()],
    ["target5xx", new Map()],
  ]);
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new GetMetricDataCommand({
        StartTime: startDate,
        EndTime: endDateExclusive,
        ScanBy: "TimestampAscending",
        NextToken: nextToken,
        MetricDataQueries: [
          query("requests", "RequestCount"),
          query("elb5xx", "HTTPCode_ELB_5XX_Count"),
          query("target5xx", "HTTPCode_Target_5XX_Count"),
        ],
      }),
    );
    for (const result of res.MetricDataResults ?? []) {
      const byDate = seriesById.get(result.Id);
      if (!byDate) continue;
      const timestamps: Date[] = result.Timestamps ?? [];
      const values: number[] = result.Values ?? [];
      timestamps.forEach((ts, i) => {
        byDate.set(toUtcDateString(new Date(ts)), values[i] ?? 0);
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);

  const requests = seriesById.get("requests")!;
  const elb5xxSeries = seriesById.get("elb5xx")!;
  const target5xxSeries = seriesById.get("target5xx")!;

  const out: DailyAlbPoint[] = [];
  for (let d = startDate; d.getTime() < endDateExclusive.getTime(); d = addUtcDays(d, 1)) {
    const key = toUtcDateString(d);
    out.push({
      date: key,
      requestCount: requests.get(key) ?? 0,
      elb5xx: elb5xxSeries.get(key) ?? 0,
      target5xx: target5xxSeries.get(key) ?? 0,
    });
  }
  return out;
}

/** True when an alarm-history item's summary records a transition INTO ALARM
 *  state (the shape CloudWatch emits, e.g. "Alarm updated from OK to ALARM"). */
function isTransitionToAlarm(summary: string | undefined): boolean {
  return typeof summary === "string" && /\bto ALARM\b/.test(summary);
}

/**
 * Count state-transition-to-ALARM history items for `alarmName` in
 * [startDate, endDate]. `sps-app-unavailable-<env>` is a COMPOSITE alarm, and
 * DescribeAlarmHistory only returns composite-alarm history when
 * `AlarmTypes` explicitly includes "CompositeAlarm" (by default it returns
 * metric alarms only) — see the matching IAM-grant comment in app-stack.ts
 * for the companion `*`-resource-scope requirement.
 */
export async function fetchAlarmFirings(
  client: CloudWatchLikeClient,
  alarmName: string,
  startDate: Date,
  endDate: Date,
): Promise<number> {
  let count = 0;
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new DescribeAlarmHistoryCommand({
        AlarmName: alarmName,
        AlarmTypes: ["CompositeAlarm"],
        HistoryItemType: "StateUpdate",
        StartDate: startDate,
        EndDate: endDate,
        NextToken: nextToken,
      }),
    );
    for (const item of res.AlarmHistoryItems ?? []) {
      if (isTransitionToAlarm(item.HistorySummary)) count++;
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return count;
}

/** UTC calendar-month start N months before `d`, clamped no earlier than `floor`. */
function monthsBackClamped(d: Date, months: number, floor: Date): Date {
  const back = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1));
  return back.getTime() > floor.getTime() ? back : floor;
}

/**
 * Uncached loader. Exported (unlike usage-summary.ts's private counterpart)
 * specifically so tests can inject a fake CloudWatch client and `now` and
 * assert a send() rejection propagates rather than resolving to an empty
 * summary — see tests/unit/service-health.test.ts.
 */
export async function loadServiceHealthUncached(deps?: {
  client?: CloudWatchLikeClient;
  now?: Date;
}): Promise<ServiceHealthSummary> {
  const albFullName = requiredEnv("SPS_PUBLIC_ALB_FULL_NAME");
  const alarmName = requiredEnv("SPS_APP_UNAVAILABLE_ALARM");
  const client = deps?.client ?? cloudWatchClient();

  const now = deps?.now ?? new Date();
  const todayMidnightUtc = utcMidnight(now);
  const launchStart = new Date(`${LAUNCH_MONTH_START}T00:00:00.000Z`);
  const rangeStart = monthsBackClamped(todayMidnightUtc, MAX_TREND_MONTHS, launchStart);

  const [daily, alarmFirings] = await Promise.all([
    fetchDailyAlbPoints(client, albFullName, rangeStart, todayMidnightUtc),
    fetchAlarmFirings(
      client,
      alarmName,
      new Date(now.getTime() - SERVICE_HEALTH_WINDOW_DAYS * DAILY_PERIOD_SECONDS * 1000),
      now,
    ),
  ]);

  return shapeServiceHealth(daily, alarmFirings);
}

/**
 * Cached loader for the page. 12h revalidate; a thrown CloudWatch error
 * propagates (never cached) so the page can fail this section soft — see the
 * module docblock.
 */
export const loadServiceHealth = unstable_cache(loadServiceHealthUncached, ["service-health"], {
  revalidate: SERVICE_HEALTH_CACHE_TTL_SECONDS,
  tags: ["service-health"],
});
