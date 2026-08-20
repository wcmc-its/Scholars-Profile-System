/**
 * GrantRecs Phase 2, Task 3 — GRANT# → opportunity ETL block wiring. Guards the
 * paged scan + idempotent upsert + non-research skip with a faked DocumentClient
 * and writer (the parse/coerce logic is covered by grant-opportunity-mapper).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FRESHNESS_METRIC_NAME,
  FRESHNESS_METRIC_NAMESPACE,
  emitOpportunityCorpusFreshnessMetric,
  projectGrantOpportunities,
} from "@/etl/dynamodb/grant-opportunity-etl";

function grant(id: string, over: Record<string, unknown> = {}) {
  return {
    PK: `GRANT#${id}`,
    SK: "META",
    opportunity_id: id,
    source: "grants_gov",
    source_url: "https://x",
    sponsor: "NIH",
    title: "T",
    synopsis: "S",
    status: "open",
    eligibility_raw: "Institutions of Higher Education",
    cfda_list: ["93.310"],
    topic_vector: [{ topic_id: "a", score: 0.9, rationale: "" }],
    appeal_by_stage: { grad: 0, postdoc: 0, early: 1, mid: 0.5, senior: 0 },
    is_research: true,
    taxonomy_version: "taxonomy_v2",
    ingested_at: "2026-06-19T12:00:00Z",
    ...over,
  };
}

const NOW = new Date("2026-06-20T00:00:00Z");

describe("projectGrantOpportunities", () => {
  it("scans across pages and upserts one row per kept item, keyed on opportunityId", async () => {
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ Items: [grant("grants_gov:1")], LastEvaluatedKey: { k: 1 } })
        .mockResolvedValueOnce({ Items: [grant("grants_gov:2")] }),
    };
    const upsert = vi.fn().mockResolvedValue({});
    const writer = { opportunity: { upsert } };

    const res = await projectGrantOpportunities(ddb, writer, { table: "reciterai", now: NOW });

    expect(ddb.send).toHaveBeenCalledTimes(2); // two pages
    expect(res).toMatchObject({ scanned: 2, upserted: 2 });
    expect(upsert).toHaveBeenCalledTimes(2);
    const firstArg = upsert.mock.calls[0][0] as { where: { opportunityId: string }; create: Record<string, unknown> };
    expect(firstArg.where).toEqual({ opportunityId: "grants_gov:1" });
    expect(firstArg.create.lastRefreshedAt).toBe(NOW);
  });

  it("skips non-research items and does not upsert them", async () => {
    const ddb = {
      send: vi.fn().mockResolvedValueOnce({
        Items: [grant("grants_gov:1"), grant("grants_gov:2", { is_research: false })],
      }),
    };
    const upsert = vi.fn().mockResolvedValue({});

    const res = await projectGrantOpportunities(ddb, { opportunity: { upsert } }, { table: "reciterai", now: NOW });

    expect(res.upserted).toBe(1);
    expect(res.skipped.nonResearch).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("emitOpportunityCorpusFreshnessMetric", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // NOW is 2026-06-20T00:00:00Z; ages below are exact day counts from it.
  const groupRow = (source: string, ingestedAt: Date | null) => ({
    source,
    _max: { ingestedAt },
  });

  it("emits one corpus-wide datapoint (min of per-source MAX ages) plus one per source", async () => {
    vi.stubEnv("SCHOLARS_ENV", "staging");
    const groupBy = vi.fn().mockResolvedValue([
      groupRow("grants_gov", new Date("2026-06-10T00:00:00Z")), // 10d old
      groupRow("nih_guide", new Date("2026-05-21T00:00:00Z")), // 30d old
      groupRow("epoch_only", new Date(0)), // epoch fallback -- huge age, per-source only
    ]);
    const send = vi.fn().mockResolvedValue({});

    await emitOpportunityCorpusFreshnessMetric(
      { opportunity: { groupBy } },
      { now: NOW, cloudwatch: { send } },
    );

    expect(groupBy).toHaveBeenCalledWith({ by: ["source"], _max: { ingestedAt: true } });
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.Namespace).toBe(FRESHNESS_METRIC_NAMESPACE);
    const data = input.MetricData as Array<{
      MetricName: string;
      Dimensions: Array<{ Name: string; Value: string }>;
      Value: number;
    }>;
    expect(data).toHaveLength(4); // corpus + 3 sources
    for (const d of data) expect(d.MetricName).toBe(FRESHNESS_METRIC_NAME);
    // Corpus-wide = age of the NEWEST ingest anywhere (10d), NOT dragged to
    // the epoch source's ~55y -- per-source MAX + min-over-sources is the
    // epoch-fallback-safe shape.
    const corpus = data.find((d) => d.Dimensions.length === 1);
    expect(corpus?.Dimensions).toEqual([{ Name: "Env", Value: "staging" }]);
    expect(corpus?.Value).toBeCloseTo(10, 6);
    const bySource = Object.fromEntries(
      data
        .filter((d) => d.Dimensions.length === 2)
        .map((d) => [d.Dimensions.find((x) => x.Name === "Source")?.Value, d.Value]),
    );
    expect(bySource.grants_gov).toBeCloseTo(10, 6);
    expect(bySource.nih_guide).toBeCloseTo(30, 6);
    expect(bySource.epoch_only).toBeGreaterThan(20000); // ~56 years
  });

  it("skips silently when SCHOLARS_ENV is unset (local prototype run)", async () => {
    vi.stubEnv("SCHOLARS_ENV", "");
    const groupBy = vi.fn();
    const send = vi.fn();

    await emitOpportunityCorpusFreshnessMetric(
      { opportunity: { groupBy } },
      { now: NOW, cloudwatch: { send } },
    );

    expect(groupBy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("never throws: a groupBy failure logs a warning and the ETL continues", async () => {
    vi.stubEnv("SCHOLARS_ENV", "staging");
    const groupBy = vi.fn().mockRejectedValue(new Error("db went away"));
    const send = vi.fn();
    const log = vi.fn();

    await expect(
      emitOpportunityCorpusFreshnessMetric(
        { opportunity: { groupBy } },
        { now: NOW, cloudwatch: { send }, log },
      ),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
  });

  it("never throws: a PutMetricData failure logs a warning and the ETL continues", async () => {
    vi.stubEnv("SCHOLARS_ENV", "staging");
    const groupBy = vi
      .fn()
      .mockResolvedValue([groupRow("grants_gov", new Date("2026-06-10T00:00:00Z"))]);
    const send = vi.fn().mockRejectedValue(new Error("cloudwatch down"));
    const log = vi.fn();

    await expect(
      emitOpportunityCorpusFreshnessMetric(
        { opportunity: { groupBy } },
        { now: NOW, cloudwatch: { send }, log },
      ),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
  });

  it("emits nothing on an empty table", async () => {
    vi.stubEnv("SCHOLARS_ENV", "staging");
    const groupBy = vi.fn().mockResolvedValue([]);
    const send = vi.fn();

    await emitOpportunityCorpusFreshnessMetric(
      { opportunity: { groupBy } },
      { now: NOW, cloudwatch: { send } },
    );

    expect(send).not.toHaveBeenCalled();
  });
});
