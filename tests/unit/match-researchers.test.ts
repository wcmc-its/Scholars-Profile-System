/**
 * GrantRecs Phase 2, Task 7 — reverse matcher ("Find researchers for this
 * opportunity") combination core. Given per-topic ranked scholars (from the
 * existing getTopScholarsForTopic-style aggregation), combine across the
 * opportunity's topics weighted by each topic's score, keeping `topicFit` and
 * `stageAppeal` as DISTINCT axes (symmetric with the forward matcher; spec §7.4).
 * Pure — no DB.
 */
import { describe, expect, it } from "vitest";

import { rankResearchers, type TopicResult } from "@/lib/api/match-researchers";

const TOPICS: TopicResult[] = [
  {
    topicId: "implementation_science",
    topicWeight: 0.97,
    scholars: [
      { cwid: "aaa", slug: "a", variantBScore: 10 },
      { cwid: "bbb", slug: "b", variantBScore: 4 },
    ],
  },
  {
    topicId: "biostatistics",
    topicWeight: 0.41,
    scholars: [
      { cwid: "bbb", slug: "b", variantBScore: 8 },
      { cwid: "ccc", slug: "c", variantBScore: 6 },
    ],
  },
];

describe("rankResearchers — weighted topic union", () => {
  it("combines per-topic scores weighted by topic score; primary-topic expert wins", () => {
    const ranked = rankResearchers(TOPICS, {});
    // aaa: 0.97*10 = 9.7 ; bbb: 0.97*4 + 0.41*8 = 3.88+3.28 = 7.16 ; ccc: 0.41*6 = 2.46
    expect(ranked.map((r) => r.cwid)).toEqual(["aaa", "bbb", "ccc"]);
    expect(ranked[0].axes.topicFit).toBeCloseTo(9.7);
  });

  it("records per-topic contributions", () => {
    const bbb = rankResearchers(TOPICS, {}).find((r) => r.cwid === "bbb")!;
    expect(bbb.topicContributions).toEqual([
      { topicId: "implementation_science", contribution: expect.closeTo(3.88), pubCount: 0, minYear: null },
      { topicId: "biostatistics", contribution: expect.closeTo(3.28), pubCount: 0, minYear: null },
    ]);
  });

  it("carries per-topic pubCount/minYear evidence and the career-stage bucket through to the result", () => {
    const topics: TopicResult[] = [
      {
        topicId: "implementation_science",
        topicWeight: 1,
        scholars: [{ cwid: "aaa", slug: "a", variantBScore: 5, pubCount: 18, minYear: 2021 }],
      },
    ];
    const [r] = rankResearchers(topics, {
      appealByStage: { early: 1 },
      stageByCwid: new Map([["aaa", "early"]]),
    });
    expect(r.careerStage).toBe("early");
    expect(r.topicContributions[0]).toMatchObject({ pubCount: 18, minYear: 2021 });
  });

  it("defaults careerStage to null when the scholar's stage is unknown", () => {
    const [r] = rankResearchers(TOPICS, {});
    expect(r.careerStage).toBeNull();
  });

  it("keeps stageAppeal distinct; default (lens off) ranks by topicFit only", () => {
    const ranked = rankResearchers(TOPICS, {
      appealByStage: { grad: 0, postdoc: 0, early: 1, mid: 0.2, senior: 0 },
      stageByCwid: new Map([
        ["aaa", "senior"],
        ["bbb", "early"],
        ["ccc", "mid"],
      ]),
    });
    expect(ranked.map((r) => r.cwid)).toEqual(["aaa", "bbb", "ccc"]); // unchanged — lens off
    expect(ranked.find((r) => r.cwid === "aaa")!.axes.stageAppeal).toBe(0); // senior appeal 0
    expect(ranked.find((r) => r.cwid === "bbb")!.axes.stageAppeal).toBe(1); // early appeal 1
  });

  it("stageLens on re-ranks toward stage-appropriate scholars without altering axes", () => {
    const opts = {
      appealByStage: { grad: 0, postdoc: 0, early: 1, mid: 0.2, senior: 0 },
      stageByCwid: new Map<string, "grad" | "postdoc" | "early" | "mid" | "senior">([
        ["aaa", "senior"],
        ["bbb", "early"],
        ["ccc", "mid"],
      ]),
    };
    const off = rankResearchers(TOPICS, opts);
    const on = rankResearchers(TOPICS, { ...opts, stageLens: true });
    // bbb (early, appeal 1) overtakes aaa (senior, appeal 0) under the lens.
    expect(on[0].cwid).toBe("bbb");
    // axes identical between runs; only defaultScore/order moves.
    const offB = off.find((r) => r.cwid === "bbb")!;
    const onB = on.find((r) => r.cwid === "bbb")!;
    expect(onB.axes).toEqual(offB.axes);
  });

  it("sort:'stage' orders by stageAppeal independently of topicFit", () => {
    const ranked = rankResearchers(TOPICS, {
      sort: "stage",
      appealByStage: { grad: 0, postdoc: 0, early: 1, mid: 0.5, senior: 0 },
      stageByCwid: new Map([
        ["aaa", "senior"],
        ["bbb", "early"],
        ["ccc", "mid"],
      ]),
    });
    expect(ranked[0].cwid).toBe("bbb"); // highest stageAppeal
  });

  it("respects limit", () => {
    expect(rankResearchers(TOPICS, { limit: 2 })).toHaveLength(2);
  });
});
