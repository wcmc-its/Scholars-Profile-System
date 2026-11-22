/**
 * "Edge firewall decisions per day" on `/edit/usage`: what the CloudFront web
 * ACL `sps-edge-<env>-wcm-only` (cdk/lib/edge-stack.ts) allowed, challenged
 * and blocked on each UTC day of the page's range, from its AWS/WAFV2
 * CloudWatch metrics with Rule = ALL (the whole ACL's verdict, not one rule's).
 * Challenged = ChallengeRequests + CaptchaRequests. Requests the edge stopped
 * never reach the rollup's pageviews or visitors, so this is the only place
 * the dashboard shows them.
 *
 * CloudFront-scope WAF metrics are published only in us-east-1, whatever
 * region the app runs in. `<env>` is the app's SPS_ENV (wired on the app task
 * def in cdk/lib/app-stack.ts; SCHOLARS_ENV is ETL-only). The read rides the
 * task role's existing cloudwatch:GetMetricData grant
 * (TaskRoleCloudWatchReadPolicy, resource `*`).
 *
 * Cached 12h per env + range, like the other usage loaders. Any failure (a
 * CloudWatch error, a Forbidden / InternalError result, an unset or unknown
 * SPS_ENV) throws INSIDE the cached function, so it is never cached, and
 * `loadEdgeDecisions` turns it into an "unavailable" result outside the
 * cache: a cached all-zero series would read as "the edge stopped nothing".
 */
import { unstable_cache } from "next/cache";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";

import type { CloudWatchLikeClient } from "@/lib/api/service-health";

/** One UTC day of edge decisions. A day CloudWatch has no datapoint for is 0. */
export type EdgeDay = { dt: string; allowed: number; challenged: number; blocked: number };
export type EdgeDecisions = { status: "ok"; days: EdgeDay[] } | { status: "unavailable" };
/** The dashboard window (inclusive UTC days, YYYY-MM-DD). */
export type EdgeWindow = { since: string; until: string };

const NAMESPACE = "AWS/WAFV2";
const WAF_METRICS_REGION = "us-east-1";
const DAY_SECONDS = 86_400;
const DAY_MS = DAY_SECONDS * 1000;
/** Mirrors the other usage loaders' half-day TTL. */
const EDGE_CACHE_TTL_SECONDS = 43_200;
const CACHE_VERSION = "v1";
const ENVS = new Set(["prod", "staging"]);
/** Upper bound on days per read, so a bad bound can't spin (about three years). */
const MAX_DAYS = 1100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** GetMetricData query id -> WAF metric. `challenge` + `captcha` sum into `challenged`. */
const METRICS = {
  allowed: "AllowedRequests",
  blocked: "BlockedRequests",
  challenge: "ChallengeRequests",
  captcha: "CaptchaRequests",
} as const;
type QueryId = keyof typeof METRICS;

/** The env's edge web ACL name. Throws on an unset or unknown env (never guess one). */
export function edgeWebAclName(env: string | undefined): string {
  if (!env || !ENVS.has(env)) throw new Error(`unknown_sps_env: ${env ?? ""}`);
  return `sps-edge-${env}-wcm-only`;
}

/**
 * The web ACL's daily decisions over `[since, until]` (UTC days), one entry
 * per day, ascending. Throws on a CloudWatch error or a Forbidden /
 * InternalError result, so a failed read is never mistaken for a quiet day.
 */
export async function fetchEdgeDays(
  client: CloudWatchLikeClient,
  webAcl: string,
  w: EdgeWindow,
): Promise<EdgeDay[]> {
  if (!ISO.test(w.since) || !ISO.test(w.until) || w.since > w.until) {
    throw new Error(`invalid_window: ${w.since}..${w.until}`);
  }
  const start = Date.parse(`${w.since}T00:00:00Z`);
  const end = Date.parse(`${w.until}T00:00:00Z`) + DAY_MS; // exclusive
  if (!Number.isFinite(start) || !Number.isFinite(end) || (end - start) / DAY_MS > MAX_DAYS) {
    throw new Error(`invalid_window: ${w.since}..${w.until}`);
  }
  const dims = [
    { Name: "WebACL", Value: webAcl },
    { Name: "Rule", Value: "ALL" },
  ];
  const ids = Object.keys(METRICS) as QueryId[];
  const series = new Map(ids.map((id) => [id, new Map<string, number>()]));
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new GetMetricDataCommand({
        StartTime: new Date(start),
        EndTime: new Date(end),
        ScanBy: "TimestampAscending",
        NextToken: nextToken,
        MetricDataQueries: ids.map((id) => ({
          Id: id,
          MetricStat: {
            Metric: { Namespace: NAMESPACE, MetricName: METRICS[id], Dimensions: dims },
            Period: DAY_SECONDS,
            Stat: "Sum",
          },
          ReturnData: true,
        })),
      }),
    );
    for (const result of res.MetricDataResults ?? []) {
      if (result.StatusCode === "Forbidden" || result.StatusCode === "InternalError") {
        throw new Error(`cloudwatch_${result.StatusCode}: ${result.Id}`);
      }
      const byDay = series.get(result.Id);
      if (!byDay) continue;
      const timestamps: Date[] = result.Timestamps ?? [];
      const values: number[] = result.Values ?? [];
      timestamps.forEach((ts, i) => {
        const dt = new Date(ts).toISOString().slice(0, 10);
        byDay.set(dt, (byDay.get(dt) ?? 0) + (values[i] ?? 0));
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);

  const get = (id: QueryId, dt: string) => series.get(id)!.get(dt) ?? 0;
  const out: EdgeDay[] = [];
  for (let t = start; t < end; t += DAY_MS) {
    const dt = new Date(t).toISOString().slice(0, 10);
    out.push({
      dt,
      allowed: get("allowed", dt),
      challenged: get("challenge", dt) + get("captcha", dt),
      blocked: get("blocked", dt),
    });
  }
  return out;
}

/** Uncached read; throws on any failure. Injectable for tests. */
export async function loadEdgeDaysUncached(
  w: EdgeWindow,
  deps?: { client?: CloudWatchLikeClient; env?: string },
): Promise<EdgeDay[]> {
  const webAcl = edgeWebAclName(deps?.env ?? process.env.SPS_ENV);
  const client = deps?.client ?? new CloudWatchClient({ region: WAF_METRICS_REGION });
  return fetchEdgeDays(client, webAcl, w);
}

/**
 * The page's read: cached per env + window; never throws. A failure is logged
 * and returned as "unavailable", outside the cache, so the next request
 * retries instead of serving a stored empty for half a day.
 */
export async function loadEdgeDecisions(w: EdgeWindow): Promise<EdgeDecisions> {
  try {
    const days = await unstable_cache(
      () => loadEdgeDaysUncached(w),
      ["usage-edge", CACHE_VERSION, process.env.SPS_ENV ?? "", w.since, w.until],
      { revalidate: EDGE_CACHE_TTL_SECONDS, tags: ["usage-traffic"] },
    )();
    return { status: "ok", days };
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "usage_edge_read_failed",
        path: "/edit/usage",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { status: "unavailable" };
  }
}
