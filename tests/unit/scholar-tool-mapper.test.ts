/**
 * `etl/dynamodb/scholar-tool-mapper.ts` (#742 v3.1 C3). Pure rollup of ReciterAI
 * TOOL# items → scholar_tool rows: group by (cwid, tool), distinct-pmid count,
 * max confidence, representative context, FK-scope + field guards, top-N.
 */
import { describe, expect, it } from "vitest";

import { buildScholarToolWrites, type ToolRecordLike } from "@/etl/dynamodb/scholar-tool-mapper";

function tool(over: Partial<ToolRecordLike> & { PK: string }): ToolRecordLike {
  return {
    faculty_uid: "cwid_aog",
    pmid: "111",
    tool_category: "vector platform",
    context: "ctx",
    score: 0.5,
    ...over,
  };
}

describe("buildScholarToolWrites — grouping", () => {
  it("folds (tool × pmid × cwid) into one row per (cwid, tool)", () => {
    const { writes } = buildScholarToolWrites(
      [
        tool({ PK: "TOOL#AAV vectors", pmid: "111", context: "ctx1", score: 0.7 }),
        tool({ PK: "TOOL#AAV vectors", pmid: 222, context: "ctx2", score: 0.9 }),
        // duplicate pmid + a later null category/context must not override the first.
        tool({
          PK: "TOOL#AAV vectors",
          pmid: "111",
          tool_category: null,
          context: null,
          score: 0.5,
        }),
      ],
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes).toEqual([
      {
        cwid: "aog",
        toolName: "AAV vectors",
        category: "vector platform",
        pmidCount: 2, // 111 + 222 (distinct)
        maxConfidence: 0.9,
        sampleContext: "ctx1",
        pmids: ["111", "222"],
      },
    ]);
  });

  it("parses faculty_uid (cwid_X → X) and the TOOL# PK (TOOL#Name → Name)", () => {
    const { writes } = buildScholarToolWrites(
      [
        tool({
          PK: "TOOL#PET imaging",
          faculty_uid: "cwid_xyz9",
          pmid: "5",
          tool_category: "imaging",
        }),
      ],
      { ourCwidSet: new Set(["xyz9"]) },
    );
    expect(writes[0]).toMatchObject({ cwid: "xyz9", toolName: "PET imaging", category: "imaging" });
  });
});

describe("buildScholarToolWrites — guards", () => {
  it("skips items whose cwid is out of scope", () => {
    const res = buildScholarToolWrites([tool({ PK: "TOOL#X", faculty_uid: "cwid_stranger" })], {
      ourCwidSet: new Set(["aog"]),
    });
    expect(res.writes).toEqual([]);
    expect(res.skippedMissingCwid).toBe(1);
  });

  it("skips items with a non-TOOL# PK or a non-numeric pmid", () => {
    const res = buildScholarToolWrites(
      [
        tool({ PK: "NOTATOOL#X" }), // bad PK
        tool({ PK: "TOOL#X", pmid: "abc" }), // bad pmid
        tool({ PK: "TOOL#X", pmid: undefined }), // missing pmid
      ],
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.writes).toEqual([]);
    expect(res.skippedMissingFields).toBe(3);
  });
});

describe("buildScholarToolWrites — top-N per scholar", () => {
  it("keeps the top tools by (pmidCount, maxConfidence)", () => {
    const items: ToolRecordLike[] = [];
    // toolA: 3 pmids, toolB: 2 pmids, toolC: 1 pmid.
    for (const p of ["1", "2", "3"]) items.push(tool({ PK: "TOOL#toolA", pmid: p }));
    for (const p of ["1", "2"]) items.push(tool({ PK: "TOOL#toolB", pmid: p }));
    items.push(tool({ PK: "TOOL#toolC", pmid: "1" }));

    const { writes } = buildScholarToolWrites(items, {
      ourCwidSet: new Set(["aog"]),
      topNPerScholar: 2,
    });
    expect(writes.map((w) => w.toolName)).toEqual(["toolA", "toolB"]); // toolC dropped
    expect(writes.map((w) => w.pmidCount)).toEqual([3, 2]);
  });
});
