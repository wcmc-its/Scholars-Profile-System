/**
 * GrantRecs Phase 2, Task 3 — GRANT# → opportunity ETL block wiring. Guards the
 * paged scan + idempotent upsert + non-research skip with a faked DocumentClient
 * and writer (the parse/coerce logic is covered by grant-opportunity-mapper).
 */
import { describe, expect, it, vi } from "vitest";

import { projectGrantOpportunities } from "@/etl/dynamodb/grant-opportunity-etl";

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
