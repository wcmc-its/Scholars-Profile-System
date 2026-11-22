/**
 * lib/api/usage-edge — the edge web ACL's daily decisions from CloudWatch:
 * the env's ACL name, the metric query (namespace, dimensions, metrics, daily
 * Sum, the range's UTC days), daily bucketing, and the fail-soft read that is
 * never cached. CloudWatch is a mocked client; next/cache is a tiny in-memory
 * cache with Next's semantics (a rejection propagates and stores nothing).
 */
import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  send: vi.fn(),
  clientConfigs: [] as unknown[],
  store: new Map<string, unknown>(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[]) => async () => {
    const key = JSON.stringify(keyParts);
    if (h.store.has(key)) return h.store.get(key);
    const value = await fn();
    h.store.set(key, value);
    return value;
  },
}));
vi.mock("@aws-sdk/client-cloudwatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-cloudwatch")>()),
  CloudWatchClient: class {
    send = h.send;
    constructor(config: unknown) {
      h.clientConfigs.push(config);
    }
  },
}));

import {
  edgeWebAclName,
  fetchEdgeDays,
  loadEdgeDaysUncached,
  loadEdgeDecisions,
} from "@/lib/api/usage-edge";

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** One GetMetricData page: id -> [[day, value], ...]. */
function page(series: Record<string, Array<[string, number]>>, NextToken?: string) {
  return {
    MetricDataResults: Object.entries(series).map(([Id, points]) => ({
      Id,
      StatusCode: "Complete",
      Timestamps: points.map(([d]) => utc(d)),
      Values: points.map(([, v]) => v),
    })),
    NextToken,
  };
}

const W = { since: "2026-11-19", until: "2026-11-21" };

beforeEach(() => {
  h.send.mockReset();
  h.clientConfigs.length = 0;
  h.store.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("edgeWebAclName", () => {
  it("names the env's edge web ACL and refuses to guess one", () => {
    expect(edgeWebAclName("prod")).toBe("sps-edge-prod-wcm-only");
    expect(edgeWebAclName("staging")).toBe("sps-edge-staging-wcm-only");
    expect(() => edgeWebAclName(undefined)).toThrow("unknown_sps_env");
    expect(() => edgeWebAclName("dev")).toThrow("unknown_sps_env");
  });
});

describe("fetchEdgeDays", () => {
  it("asks for the ACL's daily Sum of allowed, blocked, challenge and CAPTCHA over the range", async () => {
    h.send.mockResolvedValue(page({}));
    await fetchEdgeDays({ send: h.send }, "sps-edge-prod-wcm-only", W);
    const cmd = h.send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(GetMetricDataCommand);
    const input = cmd.input;
    // The range's UTC days, end exclusive (the day after `until`).
    expect(input.StartTime).toEqual(utc("2026-11-19"));
    expect(input.EndTime).toEqual(utc("2026-11-22"));
    const queries = input.MetricDataQueries as Array<{
      Id: string;
      MetricStat: {
        Metric: { Namespace: string; MetricName: string; Dimensions: unknown };
        Period: number;
        Stat: string;
      };
    }>;
    expect(queries.map((q) => [q.Id, q.MetricStat.Metric.MetricName])).toEqual([
      ["allowed", "AllowedRequests"],
      ["blocked", "BlockedRequests"],
      ["challenge", "ChallengeRequests"],
      ["captcha", "CaptchaRequests"],
    ]);
    for (const q of queries) {
      expect(q.MetricStat.Metric.Namespace).toBe("AWS/WAFV2");
      expect(q.MetricStat.Metric.Dimensions).toEqual([
        { Name: "WebACL", Value: "sps-edge-prod-wcm-only" },
        { Name: "Rule", Value: "ALL" },
      ]);
      expect(q.MetricStat.Period).toBe(86_400);
      expect(q.MetricStat.Stat).toBe("Sum");
    }
  });

  it("buckets by UTC day across pages, sums challenge + CAPTCHA, and fills missing days with 0", async () => {
    h.send
      .mockResolvedValueOnce(
        page(
          {
            allowed: [["2026-11-19", 1000]],
            blocked: [["2026-11-19", 5]],
            challenge: [["2026-11-19", 40]],
            captcha: [["2026-11-19", 2]],
          },
          "next-page",
        ),
      )
      .mockResolvedValueOnce(
        page({
          allowed: [["2026-11-21", 3000]],
          blocked: [["2026-11-21", 7]],
          challenge: [["2026-11-21", 400]],
        }),
      );
    const days = await fetchEdgeDays({ send: h.send }, "sps-edge-prod-wcm-only", W);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][0].input.NextToken).toBe("next-page");
    expect(days).toEqual([
      { dt: "2026-11-19", allowed: 1000, challenged: 42, blocked: 5 },
      { dt: "2026-11-20", allowed: 0, challenged: 0, blocked: 0 },
      { dt: "2026-11-21", allowed: 3000, challenged: 400, blocked: 7 },
    ]);
  });

  it("throws on a Forbidden result rather than reading it as a quiet day", async () => {
    h.send.mockResolvedValue({
      MetricDataResults: [{ Id: "allowed", StatusCode: "Forbidden", Timestamps: [], Values: [] }],
    });
    await expect(fetchEdgeDays({ send: h.send }, "sps-edge-prod-wcm-only", W)).rejects.toThrow(
      "cloudwatch_Forbidden",
    );
  });

  it("rejects a malformed or reversed window before calling CloudWatch", async () => {
    await expect(
      fetchEdgeDays({ send: h.send }, "x", { since: "2026-11-21", until: "2026-11-19" }),
    ).rejects.toThrow("invalid_window");
    await expect(
      fetchEdgeDays({ send: h.send }, "x", { since: "bad", until: "2026-11-19" }),
    ).rejects.toThrow("invalid_window");
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("loadEdgeDaysUncached", () => {
  it("reads the SPS_ENV web ACL from us-east-1, where CloudFront WAF metrics live", async () => {
    vi.stubEnv("SPS_ENV", "staging");
    h.send.mockResolvedValue(page({}));
    await loadEdgeDaysUncached(W);
    expect(h.clientConfigs).toEqual([{ region: "us-east-1" }]);
    const dims = h.send.mock.calls[0][0].input.MetricDataQueries[0].MetricStat.Metric.Dimensions;
    expect(dims[0]).toEqual({ Name: "WebACL", Value: "sps-edge-staging-wcm-only" });
  });
});

describe("loadEdgeDecisions", () => {
  it("returns an unavailable result on a CloudWatch error and never caches it", async () => {
    vi.stubEnv("SPS_ENV", "prod");
    h.send.mockRejectedValueOnce(new Error("throttled"));
    expect(await loadEdgeDecisions(W)).toEqual({ status: "unavailable" });
    expect(h.store.size).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("usage_edge_read_failed"));

    // The next request reads CloudWatch again instead of a stored failure...
    h.send.mockResolvedValueOnce(page({ allowed: [["2026-11-20", 9]] }));
    const ok = await loadEdgeDecisions(W);
    expect(ok.status).toBe("ok");
    expect(ok.status === "ok" && ok.days.map((d) => d.allowed)).toEqual([0, 9, 0]);
    expect(h.send).toHaveBeenCalledTimes(2);

    // ...and a good read is cached for the window.
    expect(await loadEdgeDecisions(W)).toEqual(ok);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("an unset SPS_ENV is unavailable, with no CloudWatch call and nothing cached", async () => {
    vi.stubEnv("SPS_ENV", "");
    expect(await loadEdgeDecisions(W)).toEqual({ status: "unavailable" });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.store.size).toBe(0);
  });
});
