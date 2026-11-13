import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bucketMonthlyAvailability,
  computeAvailabilityPercent,
  computeWindowUptimePercent,
  fetchAlarmFiringTimes,
  fetchDailyAlbPoints,
  loadServiceHealthUncached,
  summarizeServiceHealth,
  type DailyAlbPoint,
  type ServiceHealthData,
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

describe("computeWindowUptimePercent", () => {
  it("aggregates only the days inside [since, until]", () => {
    const daily: DailyAlbPoint[] = [
      day("2026-06-01", 1_000, 0, 100), // before the window -- must be excluded
      day("2026-06-02", 1_000, 0, 0),
      day("2026-06-03", 1_000, 0, 0),
      day("2026-06-04", 1_000, 0, 500), // after the window -- must be excluded
    ];
    expect(computeWindowUptimePercent(daily, "2026-06-02", "2026-06-03")).toBe(100);
    expect(computeWindowUptimePercent(daily, "2026-06-01", "2026-06-04")).toBeCloseTo(85, 5);
  });

  it("is null when no day of the series falls in the window", () => {
    expect(computeWindowUptimePercent([day("2026-07-01", 10)], "2026-05-22", "2026-06-30")).toBe(
      null,
    );
  });
});

describe("summarizeServiceHealth", () => {
  // Fetched 2026-11-13 12:00Z: alarm history retained from 2026-10-14 12:00Z.
  const data: ServiceHealthData = {
    daily: [
      day("2026-08-20", 1_000, 0, 1_000), // a bad day ~3 months back
      day("2026-10-20", 1_000, 0, 10),
      day("2026-11-10", 1_000, 0, 0),
      day("2026-11-12", 1_000, 0, 0),
    ],
    alarmFiringTimes: ["2026-10-20T03:00:00.000Z", "2026-11-10T05:00:00.000Z"],
    alarmHistoryFrom: "2026-10-14T12:00:00.000Z",
  };

  it("windows uptime and alarm firings to the selected range (7 vs 30 vs 90 differ)", () => {
    const d7 = summarizeServiceHealth(data, { since: "2026-11-06", until: "2026-11-12" });
    const d30 = summarizeServiceHealth(data, { since: "2026-10-14", until: "2026-11-12" });
    const d90 = summarizeServiceHealth(data, { since: "2026-08-15", until: "2026-11-12" });

    expect(d7.uptimePercent).toBe(100);
    expect(d7.alarmFirings).toBe(1);
    expect(d7.alarmCoverage).toBe("full");

    expect(d30.uptimePercent).toBeCloseTo((1 - 10 / 3_000) * 100, 5);
    expect(d30.alarmFirings).toBe(2);
    expect(d30.alarmCoverage).toBe("full"); // starts exactly 30 days back

    expect(d90.uptimePercent).toBeCloseTo((1 - 1_010 / 4_000) * 100, 5);
    expect(d90.alarmFirings).toBe(2);
    expect(d90.alarmCoverage).toBe("partial");
    expect(d90.alarmSince).toBe("2026-10-14");
  });

  it("has no alarm count for a window entirely older than the retained history", () => {
    const old = summarizeServiceHealth(data, { since: "2026-08-01", until: "2026-08-31" });
    expect(old.alarmFirings).toBe(null);
    expect(old.alarmCoverage).toBe("none");
    expect(old.uptimePercent).toBe(0);
  });

  it("excludes a firing after the window's last day", () => {
    const s = summarizeServiceHealth(
      { ...data, alarmFiringTimes: ["2026-11-13T01:00:00.000Z"] },
      { since: "2026-11-06", until: "2026-11-12" },
    );
    expect(s.alarmFirings).toBe(0);
  });

  it("keeps the monthly trend independent of the window", () => {
    const s = summarizeServiceHealth(data, { since: "2026-11-06", until: "2026-11-12" });
    expect(s.monthly.map((m) => m.month)).toEqual(["2026-08", "2026-10", "2026-11"]);
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

describe("fetchAlarmFiringTimes", () => {
  it("returns the timestamps of state transitions INTO ALARM only", async () => {
    const send = vi.fn().mockResolvedValue({
      AlarmHistoryItems: [
        {
          HistorySummary: "Alarm updated from OK to ALARM",
          Timestamp: new Date("2026-08-02T01:00:00Z"),
        },
        {
          HistorySummary: "Alarm updated from ALARM to OK",
          Timestamp: new Date("2026-08-02T02:00:00Z"),
        },
        {
          HistorySummary: "Alarm updated from INSUFFICIENT_DATA to ALARM",
          Timestamp: new Date("2026-08-05T00:30:00Z"),
        },
      ],
    });
    const times = await fetchAlarmFiringTimes(
      { send },
      "sps-app-unavailable-staging",
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-31T00:00:00Z"),
    );
    expect(times).toEqual(["2026-08-02T01:00:00.000Z", "2026-08-05T00:30:00.000Z"]);
    expect(send.mock.calls[0][0].input).toMatchObject({
      AlarmName: "sps-app-unavailable-staging",
      AlarmTypes: ["CompositeAlarm"],
    });
  });

  it("propagates a CloudWatch send() rejection rather than resolving to 0", async () => {
    const send = vi.fn().mockRejectedValue(new Error("access_denied"));
    await expect(
      fetchAlarmFiringTimes({ send }, "sps-app-unavailable-staging", new Date(), new Date()),
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
        return Promise.resolve({
          AlarmHistoryItems: [
            { HistorySummary: "OK to ALARM", Timestamp: new Date("2026-08-30T04:00:00Z") },
          ],
        });
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
    expect(summary.alarmFiringTimes).toEqual(["2026-08-30T04:00:00.000Z"]);
    expect(summary.alarmHistoryFrom).toBe("2026-08-01T12:00:00.000Z");
    expect(summary.daily.find((d) => d.date === "2026-08-30")?.requestCount).toBe(1_000);
    // The alarm-history lookback is the 30-day retention, not the dashboard range.
    const alarmCall = send.mock.calls.find(
      ([cmd]) => cmd.constructor.name === "DescribeAlarmHistoryCommand",
    )![0];
    expect(alarmCall.input.StartDate.toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });
});
