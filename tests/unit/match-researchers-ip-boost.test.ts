/**
 * Translational-IP boost — the flag + mechanism gate (`ipBoostFor`) and the
 * re-rank inside `rankResearchers`.
 *
 * The property that matters: the boost is applied BEFORE `limit`, so an
 * IP-holding scholar can ENTER the top-N, not merely reshuffle within it. A
 * post-hoc sort of the already-sliced list would pass a naive test and silently
 * fail in production, so the entry case is tested explicitly.
 */
import { afterEach, describe, expect, it } from "vitest";

import { ipBoostFor, rankResearchers, type TopicResult } from "@/lib/api/match-researchers";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

/** One topic carrying the given scholars at the given variant-B scores. */
function topic(scores: Record<string, number>): TopicResult[] {
  return [
    {
      topicId: "t1",
      topicWeight: 1,
      scholars: Object.entries(scores).map(([cwid, variantBScore]) => ({
        cwid,
        slug: cwid,
        preferredName: cwid.toUpperCase(),
        variantBScore,
        pubCount: 1,
        minYear: 2020,
      })),
    } as TopicResult,
  ];
}

describe("ipBoostFor — flag + mechanism gate", () => {
  it("is 0 when the flag is off, even on a translational mechanism", () => {
    delete process.env.GRANT_MATCHER_IP_SIGNAL;
    expect(ipBoostFor("R43")).toBe(0);
  });

  it.each([
    ["R01", "the workhorse investigator grant"],
    ["U01", "a general cooperative agreement — deliberately excluded"],
    ["K99", "a career-development award"],
  ])("is 0 on non-translational mechanism %s even when the flag is on (%s)", (mech) => {
    process.env.GRANT_MATCHER_IP_SIGNAL = "on";
    expect(ipBoostFor(mech)).toBe(0);
  });

  it("is 0 when the opportunity carries no mechanism at all", () => {
    process.env.GRANT_MATCHER_IP_SIGNAL = "on";
    expect(ipBoostFor(null)).toBe(0);
  });

  it.each(["R41", "R42", "R43", "R44", "UH2", "UH3"])(
    "boosts on translational mechanism %s when flagged on",
    (mech) => {
      process.env.GRANT_MATCHER_IP_SIGNAL = "on";
      expect(ipBoostFor(mech)).toBeCloseTo(0.15);
    },
  );

  it("is case-insensitive on the mechanism", () => {
    process.env.GRANT_MATCHER_IP_SIGNAL = "on";
    expect(ipBoostFor("r43")).toBeCloseTo(0.15);
  });

  it("honors GRANT_MATCHER_IP_BOOST, and ignores a nonsense value", () => {
    process.env.GRANT_MATCHER_IP_SIGNAL = "on";
    process.env.GRANT_MATCHER_IP_BOOST = "0.5";
    expect(ipBoostFor("R43")).toBeCloseTo(0.5);
    process.env.GRANT_MATCHER_IP_BOOST = "banana";
    expect(ipBoostFor("R43")).toBeCloseTo(0.15);
  });
});

describe("rankResearchers — IP re-rank", () => {
  const results = topic({ alice: 10, bob: 9, carol: 8 });
  const techs = new Map([["carol", 3]]);

  it("leaves ordering untouched when ipBoost is 0", () => {
    const r = rankResearchers(results, { technologyCountByCwid: techs, ipBoost: 0 });
    expect(r.map((x) => x.cwid)).toEqual(["alice", "bob", "carol"]);
    expect(r.every((x) => x.ipBoosted === false)).toBe(true);
  });

  it("attaches technologyCount even when the boost is off", () => {
    const r = rankResearchers(results, { technologyCountByCwid: techs, ipBoost: 0 });
    expect(r.find((x) => x.cwid === "carol")?.technologyCount).toBe(3);
    expect(r.find((x) => x.cwid === "alice")?.technologyCount).toBe(0);
  });

  it("promotes an IP holder past a non-holder when the boost is enough", () => {
    // carol 8 × 1.15 = 9.2 > bob 9, but < alice 10.
    const r = rankResearchers(results, { technologyCountByCwid: techs, ipBoost: 0.15 });
    expect(r.map((x) => x.cwid)).toEqual(["alice", "carol", "bob"]);
    expect(r.find((x) => x.cwid === "carol")?.ipBoosted).toBe(true);
    expect(r.find((x) => x.cwid === "bob")?.ipBoosted).toBe(false);
  });

  it("does NOT distort axes.topicFit — only defaultScore moves", () => {
    const r = rankResearchers(results, { technologyCountByCwid: techs, ipBoost: 0.15 });
    const carol = r.find((x) => x.cwid === "carol")!;
    expect(carol.axes.topicFit).toBe(8);
    expect(carol.defaultScore).toBeCloseTo(9.2);
  });

  it("lets a boosted scholar ENTER the top-N (boost precedes limit)", () => {
    // Without a boost the top 2 are alice, bob. carol must be able to displace bob.
    const unboosted = rankResearchers(results, { limit: 2 });
    expect(unboosted.map((x) => x.cwid)).toEqual(["alice", "bob"]);

    const boosted = rankResearchers(results, {
      technologyCountByCwid: techs,
      ipBoost: 0.15,
      limit: 2,
    });
    expect(boosted.map((x) => x.cwid)).toEqual(["alice", "carol"]);
  });

  it("is binary in the IP count — 12 inventions boost the same as 1", () => {
    const one = rankResearchers(results, {
      technologyCountByCwid: new Map([["carol", 1]]),
      ipBoost: 0.15,
    });
    const twelve = rankResearchers(results, {
      technologyCountByCwid: new Map([["carol", 12]]),
      ipBoost: 0.15,
    });
    const score = (rs: typeof one) => rs.find((x) => x.cwid === "carol")!.defaultScore;
    expect(score(one)).toBeCloseTo(score(twelve));
  });

  it("does not boost a scholar with zero technologies", () => {
    const r = rankResearchers(results, {
      technologyCountByCwid: new Map([["carol", 0]]),
      ipBoost: 0.15,
    });
    expect(r.map((x) => x.cwid)).toEqual(["alice", "bob", "carol"]);
  });
});
