/**
 * CTL licensable-IP counts on ranked researchers — display data only.
 *
 * `technologyCount` feeds the ★ column on /edit/find-researchers. It must be
 * attached to every row and must NEVER move the ordering: the translational-IP
 * boost that once read it was removed 2026-07-09 (unmeasured mechanism list,
 * synthetic-corpus evidence).
 */
import { describe, expect, it } from "vitest";

import { rankResearchers, type TopicResult } from "@/lib/api/match-researchers";

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

describe("rankResearchers — technologyCount display data", () => {
  const results = topic({ alice: 10, bob: 9, carol: 8 });
  const techs = new Map([["carol", 3]]);

  it("attaches technologyCount to every row (0 for non-holders)", () => {
    const r = rankResearchers(results, { technologyCountByCwid: techs });
    expect(r.find((x) => x.cwid === "carol")?.technologyCount).toBe(3);
    expect(r.find((x) => x.cwid === "alice")?.technologyCount).toBe(0);
  });

  it("defaults to 0 when no counts are supplied", () => {
    const r = rankResearchers(results);
    expect(r.every((x) => x.technologyCount === 0)).toBe(true);
  });

  it("never moves the ordering — holding IP is not a ranking input", () => {
    const r = rankResearchers(results, { technologyCountByCwid: techs });
    expect(r.map((x) => x.cwid)).toEqual(["alice", "bob", "carol"]);
    const carol = r.find((x) => x.cwid === "carol")!;
    expect(carol.axes.topicFit).toBe(8);
    expect(carol.defaultScore).toBe(8);
  });
});
