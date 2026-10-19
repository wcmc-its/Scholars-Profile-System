import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { diffRejectedPairs } from "@/etl/reciter/rejected-pmids";

describe("#3071 ReCiter rejected-PMID mirror", () => {
  it("inserts only new pairs and deletes only vanished ones", () => {
    const existing = [
      { cwid: "t000001", pmid: "11" },
      { cwid: "t000001", pmid: "12" },
      { cwid: "t000002", pmid: "11" },
    ];
    const incoming = [
      { cwid: "t000001", pmid: "11" },
      { cwid: "t000002", pmid: "11" },
      { cwid: "t000002", pmid: "13" },
      { cwid: "t000002", pmid: "13" },
    ];
    const { add, remove } = diffRejectedPairs(existing, incoming);
    expect(add).toEqual([{ cwid: "t000002", pmid: "13" }]);
    expect(remove).toEqual([{ cwid: "t000001", pmid: "12" }]);
  });

  it("is a no-op on identical sets", () => {
    const rows = [{ cwid: "t000001", pmid: "11" }];
    expect(diffRejectedPairs(rows, rows)).toEqual({ add: [], remove: [] });
  });

  it("guards the source read before any write, and runs best-effort from etl/reciter", () => {
    const src = readFileSync(join(process.cwd(), "etl/reciter/rejected-pmids.ts"), "utf8");
    const guard = src.indexOf('assertSourceVolume("reciter:rejected-pmids"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("createMany"));
    expect(guard).toBeLessThan(src.indexOf("deleteMany"));
    expect(src).toContain('assertPruneVolume("reciter:rejected-pmids-prune"');
    const main = readFileSync(join(process.cwd(), "etl/reciter/index.ts"), "utf8");
    expect(main).toMatch(/try \{\s*await syncRejectedPmids\(cwidList\);\s*\} catch/);
  });
});
