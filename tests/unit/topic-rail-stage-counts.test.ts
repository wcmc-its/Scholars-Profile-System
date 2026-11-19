/**
 * getSubtopicRail under SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET: per-subarea and
 * per-topic counts for each shown stage, so the rail can follow the Stage pick.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const flag = { on: true };
vi.mock("@/lib/api/search-flags", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/search-flags")>()),
  resolveSearchPubsTranslationalStageFacet: () => flag.on,
}));

const rawSql: string[] = [];
vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findUnique: async () => ({ id: "cardio", label: "Cardio" }) },
    subtopic: {
      findMany: async () => [
        { id: "s1", label: "A", displayName: "A", shortDescription: null, description: null },
        { id: "s2", label: "B", displayName: "B", shortDescription: null, description: null },
      ],
    },
    publicationTopic: {
      groupBy: async () => [
        { primarySubtopicId: "s1", pmid: "1" },
        { primarySubtopicId: "s1", pmid: "2" },
        { primarySubtopicId: "s2", pmid: "3" },
        { primarySubtopicId: null, pmid: "4" },
      ],
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const { Prisma } = await import("@/lib/generated/prisma/client");
      const sql = Prisma.sql(strings, ...(values as never[])).sql;
      rawSql.push(sql);
      return sql.includes("AS sub")
        ? [
            { sub: "s1", st: "T0", n: BigInt(2) },
            { sub: "s2", st: "T2", n: BigInt(1) },
            { sub: "s1", st: "NA", n: BigInt(5) }, // not a shown stage
          ]
        : [
            { st: "T0", n: BigInt(3) },
            { st: "T2", n: BigInt(1) },
          ];
    },
  },
}));

import { getSubtopicRail } from "@/lib/api/topics";

describe("getSubtopicRail stage counts", () => {
  beforeEach(() => {
    rawSql.length = 0;
    flag.on = true;
  });

  it("returns per-subarea and topic totals for each shown stage", async () => {
    const rail = (await getSubtopicRail("cardio"))!;
    expect(rail.totalPubCount).toBe(4);
    expect(rail.stageTotalPubCounts).toEqual({ T0: 3, T2: 1 });
    const byId = Object.fromEntries(rail.subtopics.map((s) => [s.id, s.stagePubCounts]));
    expect(byId).toEqual({ s1: { T0: 2 }, s2: { T2: 1 } });
    // Low-confidence stages are not shown, so they are not counted.
    expect(rawSql.every((s) => s.includes("translational_stage_confidence <> 'low'"))).toBe(true);
  });

  it("flag off: no stage queries and no stage fields", async () => {
    flag.on = false;
    const rail = (await getSubtopicRail("cardio"))!;
    expect(rawSql).toHaveLength(0);
    expect(rail.stageTotalPubCounts).toBeUndefined();
    expect(rail.subtopics.every((s) => s.stagePubCounts === undefined)).toBe(true);
  });
});
