import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRosterProminenceVolume,
  planRosterProminence,
  type StoredProminence,
} from "@/etl/roster-prominence/plan";
import {
  computeProminence,
  LEADERSHIP_TIER,
  type ProminenceClient,
  type ProminenceEntry,
} from "@/lib/api/prominence";

const NONE = LEADERSHIP_TIER.none;
const entry = (prominence: number, leadershipTier: number = NONE): ProminenceEntry => ({
  prominence,
  leadershipTier,
  leadershipLabel: null,
});
const held = (cwid: string, p: number | null, tier: number | null = NONE): StoredProminence => ({
  cwid,
  rosterProminence: p,
  rosterLeadershipTier: tier,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("planRosterProminence", () => {
  it("writes only changed rows and clears scholars no longer scored", () => {
    const stored = [held("a", 1), held("b", 2), held("c", 3, 4), held("gone", 5)];
    const computed = new Map([
      ["a", entry(1)],
      ["b", entry(2.5)],
      ["c", entry(3, 6)],
    ]);
    expect(planRosterProminence(stored, computed)).toEqual([
      { cwid: "b", rosterProminence: 2.5, rosterLeadershipTier: NONE },
      { cwid: "c", rosterProminence: 3, rosterLeadershipTier: 6 },
      { cwid: "gone", rosterProminence: null, rosterLeadershipTier: null },
    ]);
  });

  it("scores a never-scored scholar (NULL → value), including a real zero", () => {
    expect(planRosterProminence([held("z", null, null)], new Map([["z", entry(0)]]))).toEqual([
      { cwid: "z", rosterProminence: 0, rosterLeadershipTier: NONE },
    ]);
  });
});

describe("assertRosterProminenceVolume", () => {
  const roster = (n: number, p = 2, tier: number = NONE) =>
    Array.from({ length: n }, (_, i) => held(`s${i}`, p, tier));
  const scores = (n: number, p = 2, tier: number = NONE) =>
    new Map(Array.from({ length: n }, (_, i) => [`s${i}`, entry(p, tier)] as const));

  it("passes a first run (nothing stored) and a steady night", () => {
    expect(() =>
      assertRosterProminenceVolume(
        roster(10).map((s) => held(s.cwid, null, null)),
        scores(10),
      ),
    ).not.toThrow();
    expect(() => assertRosterProminenceVolume(roster(100), scores(95))).not.toThrow();
  });

  it("refuses a short scholar read", () => {
    expect(() => assertRosterProminenceVolume(roster(100), scores(70))).toThrow(
      /roster-prominence:scholars/,
    );
  });

  it("refuses when the leadership tiers thin out", () => {
    expect(() => assertRosterProminenceVolume(roster(100, 2, 4), scores(100, 2, NONE))).toThrow(
      /roster-prominence:leaders/,
    );
  });

  it("refuses when many scores fall (thin grant/pub inputs, or a weight tuned down)", () => {
    expect(() => assertRosterProminenceVolume(roster(100, 3), scores(100, 2))).toThrow(
      /roster-prominence:score-drops/,
    );
    // A small fall below the epsilon is ordinary drift.
    expect(() => assertRosterProminenceVolume(roster(100, 3), scores(100, 2.6))).not.toThrow();
  });

  it("honours ETL_GUARD_BYPASS for the named guard", () => {
    vi.stubEnv("ETL_GUARD_BYPASS", "roster-prominence:score-drops");
    expect(() => assertRosterProminenceVolume(roster(100, 3), scores(100, 2))).not.toThrow();
  });
});

describe('computeProminence(client, "all")', () => {
  it("reads the whole non-deleted roster with no cwid IN clause", async () => {
    const calls: unknown[] = [];
    const rec = <T>(result: T) =>
      vi.fn(async (args: unknown) => {
        calls.push(args);
        return result;
      });
    const client = {
      scholar: {
        findMany: rec([
          {
            cwid: "a",
            hIndex: 10,
            scoredPubCount: 20,
            roleCategory: "full_time_faculty",
            primaryTitle: null,
            department: null,
          },
        ]),
      },
      orgUnitRoleAssignment: { findMany: rec([]) },
      grant: { groupBy: rec([]) },
    } as unknown as ProminenceClient;

    const out = await computeProminence(client, "all");
    expect(out.get("a")?.prominence).toBeCloseTo(Math.log1p(20) + 0.5 * Math.log1p(10) + 1.0);
    expect((calls[0] as { where: unknown }).where).toEqual({ deletedAt: null });
    for (const c of calls) expect(JSON.stringify(c)).not.toContain('"cwid":{"in"');
  });
});
