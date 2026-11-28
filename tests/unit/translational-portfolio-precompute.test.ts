/**
 * etl:translational-portfolio: the nightly fill of report 26's scoped row set.
 * It keeps report 26's predicates (confirmed, research articles, displayed
 * stage), and it refuses to commit an empty or more than half shrunk fill.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {}, disconnect: async () => {} }));

import { fill, FILL_SQL, MIN_KEEP, shrinkRefusal } from "@/etl/translational-portfolio/index";

describe("shrinkRefusal", () => {
  it("passes a first fill and a fill that keeps at least half", () => {
    expect(shrinkRefusal(0, 1000, false)).toBeNull();
    expect(shrinkRefusal(1000, 1000 * MIN_KEEP, false)).toBeNull();
    expect(shrinkRefusal(1000, 1200, false)).toBeNull();
  });
  it("refuses an empty fill and one under half, unless --allow-shrink", () => {
    expect(shrinkRefusal(0, 0, false)).toMatch(/0 rows/);
    expect(shrinkRefusal(1000, 499, false)).toMatch(/under 50%/);
    expect(shrinkRefusal(1000, 0, true)).toBeNull();
    expect(shrinkRefusal(1000, 10, true)).toBeNull();
  });
});

describe("fill", () => {
  const tx = (current: number, inserted: number) => {
    const sql: string[] = [];
    return {
      sql,
      t: {
        $queryRaw: vi.fn(async () => [{ n: BigInt(current) }]),
        $executeRaw: vi.fn(async (q: { sql?: string } | TemplateStringsArray) => {
          const text = "sql" in q && q.sql ? q.sql : (q as TemplateStringsArray).join("?");
          sql.push(text);
          return text.includes("INSERT") ? inserted : current;
        }),
      },
    };
  };
  it("deletes, then inserts, and returns the new count", async () => {
    const { t, sql } = tx(1000, 1100);
    await expect(fill(t as never, false)).resolves.toBe(1100);
    expect(sql[0]).toMatch(/^DELETE FROM translational_portfolio_author_pub/);
    expect(sql[1]).toContain("INSERT INTO translational_portfolio_author_pub");
  });
  it("throws inside the transaction (so it rolls back) on a refused fill", async () => {
    await expect(fill(tx(1000, 400).t as never, false)).rejects.toThrow(/refusing/);
    await expect(fill(tx(1000, 400).t as never, true)).resolves.toBe(400);
  });
});

describe("FILL_SQL", () => {
  it("copies confirmed authorships of research articles with the displayed stage", () => {
    const text = FILL_SQL.sql.replace(/\s+/g, " ");
    expect(text).toContain("pa.is_confirmed = 1");
    expect(text).toContain("p.publication_type IN (?)");
    expect(text).toContain("p.translational_stage_confidence <> 'low'");
    expect(text).toContain("MAX(pa.is_first), MAX(pa.is_last)");
    expect(FILL_SQL.values).toEqual(["T0", "T1", "T2", "T3-4", "Academic Article"]);
  });
});
