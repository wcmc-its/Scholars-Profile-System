/**
 * NCI 2a AI-percent backfill: rows a reviewer saved before
 * `cancer_relevant_percent_ai` existed get their AI value from the earliest
 * `cancer_funding_override` audit row, so a pre-migration correction still
 * reads "Corrected" and still counts in review progress.
 */
import { describe, expect, it, vi } from "vitest";

import {
  planAiFills,
  runAiBackfill,
  type AiBackfillDb,
} from "@/scripts/backfills/2026-09-25-nci-2a-ai-percent-from-audit";
import { nci2aStatus } from "@/lib/edit/nci-2a-report";

describe("planAiFills", () => {
  it("takes the earliest before-value carrying a percent, per award", () => {
    const fills = planAiFills(
      [
        { id: "corrected", cancerRelevantPercent: 65 },
        { id: "accepted", cancerRelevantPercent: 30 },
        { id: "alloc-first", cancerRelevantPercent: 20 },
        { id: "no-audit", cancerRelevantPercent: 50 },
        { id: "was-not-inferred", cancerRelevantPercent: 10 },
      ],
      [
        // Oldest first. A later edit's before-value is a human value: ignored.
        { targetEntityId: "corrected", beforeValues: '{"cancerRelevantPercent":40}' },
        { targetEntityId: "corrected", beforeValues: { cancerRelevantPercent: 55 } },
        { targetEntityId: "accepted", beforeValues: { cancerRelevantPercent: 30 } },
        // An allocations-only save first: no percent key, so it's skipped.
        { targetEntityId: "alloc-first", beforeValues: { allocations: [] } },
        { targetEntityId: "alloc-first", beforeValues: { cancerRelevantPercent: 25 } },
        // Null before = the row had no AI value; it stays NULL.
        { targetEntityId: "was-not-inferred", beforeValues: { cancerRelevantPercent: null } },
        { targetEntityId: "was-not-inferred", beforeValues: { cancerRelevantPercent: 5 } },
      ],
    );
    expect(fills).toEqual([
      { id: "corrected", ai: 40, current: 65 },
      { id: "accepted", ai: 30, current: 30 },
      { id: "alloc-first", ai: 25, current: 20 },
    ]);
  });

  it("the filled value turns a pre-migration correction back into Corrected", () => {
    const [fill] = planAiFills(
      [{ id: "x", cancerRelevantPercent: 65 }],
      [{ targetEntityId: "x", beforeValues: { cancerRelevantPercent: 40 } }],
    );
    const row = {
      cancerRelevantPercent: 65,
      cancerRelevantPercentSource: "human" as const,
      cancerRelevantPercentAi: null,
    };
    expect(nci2aStatus(row)).toBe("confirmed");
    expect(nci2aStatus({ ...row, cancerRelevantPercentAi: fill.ai })).toBe("corrected");
  });
});

function fakeDb(audit: Array<{ target_entity_id: string; before_values: unknown }>) {
  const findMany = vi.fn().mockResolvedValue([
    { id: "a", cancerRelevantPercent: "65.00" },
    { id: "b", cancerRelevantPercent: null },
  ]);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const $queryRaw = vi.fn().mockResolvedValue(audit);
  const client = { cancerCenterFundingAward: { findMany, updateMany }, $queryRaw };
  return { client: client as unknown as AiBackfillDb, findMany, updateMany, $queryRaw };
}

describe("runAiBackfill", () => {
  const audit = [{ target_entity_id: "a", before_values: { cancerRelevantPercent: 40 } }];

  it("writes only the AI column, guarded on still-human and still-NULL", async () => {
    const f = fakeDb(audit);
    const res = await runAiBackfill(f.client, { dryRun: false }, () => {});
    expect(f.findMany).toHaveBeenCalledWith({
      where: { cancerRelevantPercentSource: "human", cancerRelevantPercentAi: null },
      select: { id: true, cancerRelevantPercent: true },
    });
    const sql = (f.$queryRaw.mock.calls[0][0] as { sql: string }).sql;
    expect(sql).toContain("action = 'cancer_funding_override'");
    expect(sql).toContain("ORDER BY ts ASC, id ASC");
    expect(f.updateMany).toHaveBeenCalledTimes(1);
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { id: "a", cancerRelevantPercentSource: "human", cancerRelevantPercentAi: null },
      data: { cancerRelevantPercentAi: 40 },
    });
    expect(res).toMatchObject({ humanWithoutAi: 2, written: 1, dryRun: false });
  });

  it("a dry run writes nothing", async () => {
    const f = fakeDb(audit);
    const res = await runAiBackfill(f.client, { dryRun: true }, () => {});
    expect(f.updateMany).not.toHaveBeenCalled();
    expect(res.fills).toEqual([{ id: "a", ai: 40, current: 65 }]);
    expect(res.written).toBe(0);
  });

  it("no human rows missing an AI value: no audit read at all", async () => {
    const f = fakeDb(audit);
    f.findMany.mockResolvedValue([]);
    await runAiBackfill(f.client, { dryRun: false }, () => {});
    expect(f.$queryRaw).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
  });
});
