import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRosterProminenceVolume,
  planRosterProminence,
  ROLE_TIERS,
  type StoredProminence,
} from "@/etl/roster-prominence/plan";
import {
  computeProminence,
  LEADERSHIP_TIER,
  scoreProminence,
  type ProminenceClient,
  type ProminenceEntry,
  type ProminenceInputs,
} from "@/lib/api/prominence";

const NONE = LEADERSHIP_TIER.none;
const entry = (prominence: number, leadershipTier: number = NONE): ProminenceEntry => ({
  prominence,
  leadershipTier,
  leadershipLabel: null,
  grantScore: 0,
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

  it("refuses when many scores fall (pubs wiped, or a weight tuned down)", () => {
    expect(() => assertRosterProminenceVolume(roster(100, 3), scores(100, 2))).toThrow(
      /roster-prominence:score-drops/,
    );
    // A small fall below every epsilon is ordinary drift.
    expect(() => assertRosterProminenceVolume(roster(100, 3), scores(100, 2.8))).not.toThrow();
  });

  it("honours ETL_GUARD_BYPASS for the named guards", () => {
    // A weight tuned down also reads as lost grants on scholars without any.
    vi.stubEnv("ETL_GUARD_BYPASS", "roster-prominence:score-drops,roster-prominence:grants");
    expect(() => assertRosterProminenceVolume(roster(100, 3), scores(100, 2))).not.toThrow();
  });
});

/**
 * A realistic mixed roster, scored by the real formula. Most of it is academic
 * rank or unranked; title-only leaders (deanery, endowed, program director, the
 * fractional vice chair at 8.5, chiefs with no role row) sit alongside the
 * role-backed chairs, center directors and chiefs; about one in seven holds a
 * PI grant. Each wipe test empties the role or grant inputs the way an emptied
 * source table would.
 */
type Person = ProminenceInputs & { cwid: string };

function population(): Person[] {
  const people: Person[] = [];
  const add = (prefix: string, n: number, over: (i: number) => Partial<Person>) => {
    for (let i = 0; i < n; i++) {
      const k = people.length;
      people.push({
        cwid: `${prefix}${i}`,
        scoredPubCount: (k * 7) % 60,
        hIndex: (k * 3) % 40,
        roleCategory: k % 3 === 0 ? "full_time_faculty" : "postdoc",
        primaryTitle: k % 5 === 0 ? "Instructor in Medicine" : "Assistant Professor of Medicine",
        chairLabel: null,
        isChief: false,
        isCenterDirector: false,
        department: null,
        // Half the holders have one non-NIH PI grant (0.35); the rest more.
        piCount: k % 7 !== 0 ? 0 : k % 2 ? 1 : 1 + (k % 4),
        nihPiCount: k % 7 !== 0 || k % 2 ? 0 : k % 3,
        ...over(i),
      });
    }
  };
  add("rank", 1200, (i) => (i % 4 === 0 ? { primaryTitle: "Attending Physician" } : {}));
  add("dean", 1, () => ({ primaryTitle: "Dean" }));
  add("assocdean", 6, () => ({ primaryTitle: "Associate Dean for Research" }));
  add("vicechair", 8, () => ({ primaryTitle: "Vice Chair for Research" }));
  add("endowed", 20, () => ({ primaryTitle: "Jane Doe Professor of Surgery" }));
  add("progdir", 10, () => ({ primaryTitle: "Director, Residency Program" }));
  // Role-backed leaders; some titles say so, some don't.
  add("chair", 25, (i) => ({
    chairLabel: "Chair",
    primaryTitle: i % 2 ? "Chair of Medicine" : "Professor of Medicine",
  }));
  add("centerdir", 8, (i) => ({
    isCenterDirector: true,
    primaryTitle: i % 2 ? "Director, Cancer Center" : "Professor of Medicine",
  }));
  add("chief", 40, (i) => ({
    isChief: true,
    primaryTitle: i % 2 ? "Chief of Cardiology" : "Professor of Medicine",
  }));
  // Title-only chiefs: no role row, so a role wipe leaves them where they are.
  add("titlechief", 15, () => ({ primaryTitle: "Chief, Section of Hepatology" }));
  return people;
}

const score = (people: readonly Person[]) =>
  new Map(people.map((p) => [p.cwid, scoreProminence(p)] as const));
const store = (people: readonly Person[]): StoredProminence[] =>
  [...score(people)].map(([cwid, e]) => held(cwid, e.prominence, e.leadershipTier));

describe("assertRosterProminenceVolume on a realistic roster", () => {
  const people = population();
  const stored = store(people);

  it("is a mixed population (fixture sanity)", () => {
    const tiers = stored.map((s) => s.rosterLeadershipTier);
    expect(tiers).toContain(LEADERSHIP_TIER.viceChair); // 8.5
    expect(tiers).toContain(LEADERSHIP_TIER.academic);
    expect(tiers).toContain(LEADERSHIP_TIER.endowed);
    expect(tiers).toContain(NONE);
    // Every tier below `none` — what the old leaders guard counted — is mostly
    // academic rank, which a role wipe never touches.
    const ranked = stored.filter((s) => s.rosterLeadershipTier! < NONE).length;
    const roleTier = stored.filter((s) => ROLE_TIERS.has(s.rosterLeadershipTier!)).length;
    expect(roleTier).toBeGreaterThan(80);
    expect(roleTier / ranked).toBeLessThan(0.3);
    const holders = [...score(people).values()].filter((e) => e.grantScore > 0).length;
    expect(holders).toBeGreaterThan(40);
    expect(holders / people.length).toBeLessThan(0.2);
  });

  it("passes an ordinary night: pubs accrue, a chair hands over, a grant ends", () => {
    const tonight = people.map((p, i) => ({
      ...p,
      scoredPubCount: (p.scoredPubCount ?? 0) + (i % 10 === 0 ? 1 : 0),
    }));
    tonight.find((p) => p.cwid === "chair0")!.chairLabel = null;
    tonight.find((p) => p.cwid === "rank1")!.chairLabel = "Chair";
    tonight.find((p) => p.piCount === 1 && p.nihPiCount === 0)!.piCount = 0;
    expect(() => assertRosterProminenceVolume(stored, score(tonight))).not.toThrow();
  });

  it("round-trips a fractional 8.5 tier without a write, outside the role cohort", () => {
    expect(stored.find((s) => s.cwid === "vicechair0")!.rosterLeadershipTier).toBe(8.5);
    expect(ROLE_TIERS.has(8.5)).toBe(false);
    expect(planRosterProminence(stored, score(people))).toEqual([]);
    // Every vice chair's title rewritten upstream: a title change, not a role wipe.
    const tonight = people.map((p) =>
      p.cwid.startsWith("vicechair") ? { ...p, primaryTitle: "Professor of Medicine" } : p,
    );
    expect(() => assertRosterProminenceVolume(stored, score(tonight))).not.toThrow();
  });

  it("trips leaders when org_unit_role_assignment is emptied", () => {
    const tonight = people.map((p) => ({
      ...p,
      chairLabel: null,
      isChief: false,
      isCenterDirector: false,
    }));
    expect(() => assertRosterProminenceVolume(stored, score(tonight))).toThrow(
      /roster-prominence:leaders/,
    );
  });

  it("trips leaders on a role wipe even when every chair/chief title keeps the tier", () => {
    // The title holds tier 4/6 on its own; only the lost chair/chief weight shows.
    const titled = people.map((p) =>
      p.chairLabel
        ? { ...p, primaryTitle: "Chair of Medicine" }
        : p.isChief
          ? { ...p, primaryTitle: "Chief of Cardiology" }
          : p,
    );
    const tonight = titled.map((p) => ({ ...p, chairLabel: null, isChief: false }));
    expect(() => assertRosterProminenceVolume(store(titled), score(tonight))).toThrow(
      /roster-prominence:leaders/,
    );
  });

  it("trips grants when the grant table is emptied, which score-drops misses", () => {
    const tonight = people.map((p) => ({ ...p, piCount: 0, nihPiCount: 0 }));
    expect(() => assertRosterProminenceVolume(stored, score(tonight))).toThrow(
      /roster-prominence:grants/,
    );
    vi.stubEnv("ETL_GUARD_BYPASS", "roster-prominence:grants");
    expect(() => assertRosterProminenceVolume(stored, score(tonight))).not.toThrow();
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
