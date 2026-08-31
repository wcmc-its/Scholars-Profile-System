import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SERVICE_HEALTH_WINDOW_DAYS,
  bucketMonthlyAvailability,
  computeAvailabilityPercent,
  computeTrailingUptimePercent,
  fetchAlarmFirings,
  fetchDailyAlbPoints,
  loadServiceHealthUncached,
  shapeServiceHealth,
  type DailyAlbPoint,
} from "@/lib/api/service-health";

function day(date: string, requestCount: number, elb5xx = 0, target5xx = 0): DailyAlbPoint {
  return { date, requestCount, elb5xx, target5xx };
}

describe("computeAvailabilityPercent", () => {
  it("happy path: 1 - (5xx)/requests", () => {
    // 10 failures (4 ELB + 6 target) out of 10,000 requests -> 99.9%
    expect(computeAvailabilityPercent(4, 6, 10_000)).toBeCloseTo(99.9, 5);
  });

  it("treats missing 5xx datapoints (0) as no failures -> 100%", () => {
    expect(computeAvailabilityPercent(0, 0, 5_000)).toBe(100);
  });

  it("a zero-request period reports 100% (no evidence of failure)", () => {
    expect(computeAvailabilityPercent(0, 0, 0)).toBe(100);
    // even a nonsensical nonzero-5xx/zero-request input can't divide by zero
    expect(computeAvailabilityPercent(3, 1, 0)).toBe(100);
  });

  it("clamps to [0, 100] when failures exceed requests", () => {
    expect(computeAvailabilityPercent(50, 60, 100)).toBe(0);
  });
});

describe("bucketMonthlyAvailability", () => {
  it("buckets by UTC calendar month across a month boundary", () => {
    const daily: DailyAlbPoint[] = [
      day("2026-07-30", 1_000, 0, 5),
      day("2026-07-31", 1_000, 0, 5),
      day("2026-08-01", 1_000, 0, 0),
      day("2026-08-02", 1_000, 0, 0),
    ];
    const monthly = bucketMonthlyAvailability(daily);
    expect(monthly.map((m) => m.month)).toEqual(["2026-07", "2026-08"]);

    const july = monthly[0];
    expect(july.totalRequests).toBe(2_000);
    // 10 failures / 2000 requests = 99.5%
    expect(july.availabilityPercent).toBeCloseTo(99.5, 5);
    expect(july.lowTraffic).toBe(false);

    const august = monthly[1];
    expect(august.totalRequests).toBe(2_000);
    expect(august.availabilityPercent).toBe(100);
  });

  it("sorts months ascending regardless of input order", () => {
    const daily: DailyAlbPoint[] = [day("2026-08-01", 100), day("2026-07-01", 100)];
    expect(bucketMonthlyAvailability(daily).map((m) => m.month)).toEqual(["2026-07", "2026-08"]);
  });

  it("a zero-request month still yields a bucket, flagged low-traffic, not dropped", () => {
    const daily: DailyAlbPoint[] = [day("2026-07-01", 0), day("2026-07-02", 0)];
    const monthly = bucketMonthlyAvailability(daily);
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({
      month: "2026-07",
      totalRequests: 0,
      availabilityPercent: 100,
      lowTraffic: true,
    });
  });

  it("flags a month under the 1,000-request low-traffic floor even with a real 5xx", () => {
    const daily: DailyAlbPoint[] = [day("2026-07-01", 400, 0, 4)];
    const monthly = bucketMonthlyAvailability(daily);
    expect(monthly[0].lowTraffic).toBe(true);
    expect(monthly[0].totalRequests).toBe(400);
  });

  it("does not flag a month at or above the floor", () => {
    const daily: DailyAlbPoint[] = [day("2026-07-01", 1_000)];
    expect(bucketMonthlyAvailability(daily)[0].lowTraffic).toBe(false);
  });
});

describe("computeTrailingUptimePercent", () => {
  it("aggregates only the trailing windowDays entries", () => {
    const daily: DailyAlbPoint[] = [
      day("2026-06-01", 1_000, 0, 100), // outside the 2-day window -- must be excluded
      day("2026-06-02", 1_000, 0, 0),
      day("2026-06-03", 1_000, 0, 0),
    ];
    expect(computeTrailingUptimePercent(daily, 2)).toBe(100);
  });
});

describe("shapeServiceHealth", () => {
  it("combines the daily series and alarm count into the view model", () => {
    const daily: DailyAlbPoint[] = [day("2026-07-01", 1_000, 0, 1)];
    const summary = shapeServiceHealth(daily, 3);
    expect(summary.windowDays).toBe(SERVICE_HEALTH_WINDOW_DAYS);
    expect(summary.alarmFirings).toBe(3);
    expect(summary.monthly).toEqual([
      { month: "2026-07", availabilityPercent: 99.9, totalRequests: 1_000, lowTraffic: false },
    ]);
  });
});

describe("fetchDailyAlbPoints", () => {
  it("fills every UTC day in range, defaulting missing datapoints to 0", async () => {
    const send = vi.fn().mockResolvedValue({
      MetricDataResults: [
        {
          Id: "requests",
          Timestamps: [new Date("2026-07-01T00:00:00Z"), new Date("2026-07-02T00:00:00Z")],
          Values: [500, 700],
        },
        {
          Id: "elb5xx",
          Timestamps: [new Date("2026-07-02T00:00:00Z")], // no 07-01 datapoint at all
          Values: [2],
        },
        // target5xx: no MetricDataResults entry at all for this Id (no errors that window)
      ],
    });

    const points = await fetchDailyAlbPoints(
      { send },
      "app/full-name/id",
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-03T00:00:00Z"),
    );

    expect(points).toEqual([
      { date: "2026-07-01", requestCount: 500, elb5xx: 0, target5xx: 0 },
      { date: "2026-07-02", requestCount: 700, elb5xx: 2, target5xx: 0 },
    ]);
  });

  it("paginates on NextToken and merges results across pages", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        MetricDataResults: [
          { Id: "requests", Timestamps: [new Date("2026-07-01T00:00:00Z")], Values: [10] },
        ],
        NextToken: "page2",
      })
      .mockResolvedValueOnce({
        MetricDataResults: [
          { Id: "requests", Timestamps: [new Date("2026-07-02T00:00:00Z")], Values: [20] },
        ],
      });

    const points = await fetchDailyAlbPoints(
      { send },
      "app/full-name/id",
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-03T00:00:00Z"),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(points.map((p) => p.requestCount)).toEqual([10, 20]);
  });

  it("propagates a CloudWatch send() rejection rather than resolving empty", async () => {
    const send = vi.fn().mockRejectedValue(new Error("cloudwatch_throttled"));
    await expect(
      fetchDailyAlbPoints(
        { send },
        "app/full-name/id",
        new Date("2026-07-01T00:00:00Z"),
        new Date("2026-07-02T00:00:00Z"),
      ),
    ).rejects.toThrow("cloudwatch_throttled");
  });
});

describe("fetchAlarmFirings", () => {
  it("counts only state transitions INTO ALARM", async () => {
    const send = vi.fn().mockResolvedValue({
      AlarmHistoryItems: [
        { HistorySummary: "Alarm updated from OK to ALARM" },
        { HistorySummary: "Alarm updated from ALARM to OK" },
        { HistorySummary: "Alarm updated from INSUFFICIENT_DATA to ALARM" },
      ],
    });
    const count = await fetchAlarmFirings(
      { send },
      "sps-app-unavailable-staging",
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-31T00:00:00Z"),
    );
    expect(count).toBe(2);
    expect(send.mock.calls[0][0].input).toMatchObject({
      AlarmName: "sps-app-unavailable-staging",
      AlarmTypes: ["CompositeAlarm"],
    });
  });

  it("propagates a CloudWatch send() rejection rather than resolving to 0", async () => {
    const send = vi.fn().mockRejectedValue(new Error("access_denied"));
    await expect(
      fetchAlarmFirings({ send }, "sps-app-unavailable-staging", new Date(), new Date()),
    ).rejects.toThrow("access_denied");
  });
});

describe("loadServiceHealthUncached", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when the required env vars are missing (never a silent empty result)", async () => {
    vi.stubEnv("SPS_PUBLIC_ALB_FULL_NAME", "");
    vi.stubEnv("SPS_APP_UNAVAILABLE_ALARM", "");
    await expect(loadServiceHealthUncached({ client: { send: vi.fn() } })).rejects.toThrow(
      "missing_env",
    );
  });

  it("propagates a CloudWatch failure -- never caches/returns an empty summary", async () => {
    vi.stubEnv("SPS_PUBLIC_ALB_FULL_NAME", "app/full-name/id");
    vi.stubEnv("SPS_APP_UNAVAILABLE_ALARM", "sps-app-unavailable-staging");
    const send = vi.fn().mockRejectedValue(new Error("cloudwatch_down"));
    await expect(
      loadServiceHealthUncached({ client: { send }, now: new Date("2026-08-31T12:00:00Z") }),
    ).rejects.toThrow("cloudwatch_down");
  });

  it("on success, returns a shaped summary built from both CloudWatch calls", async () => {
    vi.stubEnv("SPS_PUBLIC_ALB_FULL_NAME", "app/full-name/id");
    vi.stubEnv("SPS_APP_UNAVAILABLE_ALARM", "sps-app-unavailable-staging");
    const send = vi.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "DescribeAlarmHistoryCommand") {
        return Promise.resolve({ AlarmHistoryItems: [{ HistorySummary: "OK to ALARM" }] });
      }
      return Promise.resolve({
        MetricDataResults: [
          { Id: "requests", Timestamps: [new Date("2026-08-30T00:00:00Z")], Values: [1_000] },
        ],
      });
    });

    const summary = await loadServiceHealthUncached({
      client: { send },
      now: new Date("2026-08-31T12:00:00Z"),
    });
    expect(summary.alarmFirings).toBe(1);
    expect(summary.monthly.find((m) => m.month === "2026-08")?.totalRequests).toBe(1_000);
  });
});
