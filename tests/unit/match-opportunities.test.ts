/**
 * GrantRecs Phase 2, Task 6 — forward matcher ("Grants for me") scoring core.
 * The matcher emits DISTINCT per-axis sub-scores (topic / stage / mesh /
 * deadline); `defaultScore` is one blend OVER them, not a replacement — so a
 * caller can sort per axis or re-weight without re-running the match (spec §7.3,
 * the distinct-axis decision). These are pure functions — no DB / OpenSearch.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEIGHTS,
  combineScore,
  deadlineProximity,
  meshOverlap,
  rankCandidates,
  scholarTopicRowWeight,
  topicAffinity,
  type OpportunityCandidate,
} from "@/lib/api/match-opportunities";

const NOW = new Date("2026-06-20T00:00:00Z");

describe("axis: topicAffinity (cosine)", () => {
  it("is 1 for identical single-topic vectors and 0 for disjoint", () => {
    expect(topicAffinity(new Map([["a", 1]]), new Map([["a", 1]]))).toBeCloseTo(1);
    expect(topicAffinity(new Map([["a", 1]]), new Map([["b", 1]]))).toBe(0);
  });
  it("rewards overlap weighted by score", () => {
    const vs = new Map([["a", 0.9], ["b", 0.1]]);
    const strong = topicAffinity(vs, new Map([["a", 1]]));
    const weak = topicAffinity(vs, new Map([["b", 1]]));
    expect(strong).toBeGreaterThan(weak);
  });
  it("is 0 when either vector is empty", () => {
    expect(topicAffinity(new Map(), new Map([["a", 1]]))).toBe(0);
  });
});

describe("axis: meshOverlap (Jaccard)", () => {
  it("computes intersection over union; 0 when either side empty", () => {
    expect(meshOverlap(["D1", "D2"], ["D2", "D3"])).toBeCloseTo(1 / 3);
    expect(meshOverlap([], ["D1"])).toBe(0);
  });
});

describe("axis: deadlineProximity", () => {
  it("is 0 for past, ~1 for imminent, lower for far-out, baseline for continuous", () => {
    expect(deadlineProximity(new Date("2026-06-01"), NOW)).toBe(0); // past
    expect(deadlineProximity(new Date("2026-07-01"), NOW)).toBe(1); // ~11 days
    const far = deadlineProximity(new Date("2027-06-01"), NOW); // ~346 days
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(1);
    expect(deadlineProximity(null, NOW)).toBe(0.5); // continuous baseline
  });
});

describe("combineScore — default blend over the axes", () => {
  it("stage multiplies topic so high-appeal-but-off-topic never floats up", () => {
    const onTopic = combineScore({ topicAffinity: 0.9, stageAppeal: 0.2, meshOverlap: 0, deadlineProximity: 0 });
    const offTopic = combineScore({ topicAffinity: 0.05, stageAppeal: 1.0, meshOverlap: 0, deadlineProximity: 0 });
    expect(onTopic).toBeGreaterThan(offTopic);
  });
  it("custom weights change the blend", () => {
    const axes = { topicAffinity: 0.5, stageAppeal: 1, meshOverlap: 1, deadlineProximity: 1 };
    const dflt = combineScore(axes);
    const meshHeavy = combineScore(axes, { ...DEFAULT_WEIGHTS, mesh: 4 });
    expect(meshHeavy).toBeGreaterThan(dflt);
  });
});

function candidate(over: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return {
    opportunityId: "grants_gov:1",
    title: "t",
    sponsor: "s",
    dueDate: new Date("2026-09-01"),
    status: "open",
    topicVector: [{ topic_id: "a", score: 0.9 }],
    appealByStage: { grad: 0.1, postdoc: 0.3, early: 0.9, mid: 0.7, senior: 0.4 },
    meshDescriptorUi: [],
    ...over,
  };
}

describe("rankCandidates — distinct axes + sortable", () => {
  const scholarVec = new Map([["a", 0.9], ["b", 0.2]]);

  it("returns each candidate's distinct axes plus a defaultScore", () => {
    const ranked = rankCandidates(scholarVec, "early", [], [candidate()], { now: NOW });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].axes).toMatchObject({
      topicAffinity: expect.any(Number),
      stageAppeal: 0.9,
      meshOverlap: 0,
      deadlineProximity: expect.any(Number),
    });
    expect(ranked[0].defaultScore).toBeGreaterThan(0);
  });

  it("default sort (fit) ranks the on-topic opp above an off-topic high-appeal one", () => {
    const onTopic = candidate({ opportunityId: "on", topicVector: [{ topic_id: "a", score: 1 }] });
    const offTopic = candidate({
      opportunityId: "off",
      topicVector: [{ topic_id: "z", score: 1 }],
      appealByStage: { grad: 1, postdoc: 1, early: 1, mid: 1, senior: 1 },
    });
    const ranked = rankCandidates(scholarVec, "early", [], [offTopic, onTopic], { now: NOW });
    expect(ranked[0].opportunityId).toBe("on");
  });

  it("sort:'deadline' reorders by deadlineProximity independently of fit", () => {
    const soon = candidate({ opportunityId: "soon", dueDate: new Date("2026-07-01"), topicVector: [{ topic_id: "b", score: 0.3 }] });
    const later = candidate({ opportunityId: "later", dueDate: new Date("2027-06-01"), topicVector: [{ topic_id: "a", score: 1 }] });
    const byFit = rankCandidates(scholarVec, "early", [], [soon, later], { now: NOW });
    const byDeadline = rankCandidates(scholarVec, "early", [], [soon, later], { now: NOW, sort: "deadline" });
    expect(byFit[0].opportunityId).toBe("later"); // better topic fit
    expect(byDeadline[0].opportunityId).toBe("soon"); // nearer deadline
  });

  it("sort:'stage' reorders by stageAppeal independently", () => {
    const earlyFit = candidate({ opportunityId: "early-appeal", appealByStage: { grad: 0, postdoc: 0, early: 1, mid: 0, senior: 0 }, topicVector: [{ topic_id: "a", score: 0.5 }] });
    const seniorFit = candidate({ opportunityId: "senior-appeal", appealByStage: { grad: 0, postdoc: 0, early: 0.1, mid: 0, senior: 1 }, topicVector: [{ topic_id: "a", score: 1 }] });
    const ranked = rankCandidates(scholarVec, "early", [], [seniorFit, earlyFit], { now: NOW, sort: "stage" });
    expect(ranked[0].opportunityId).toBe("early-appeal");
  });

  it("drops candidates below the topicAffinity floor", () => {
    const offTopic = candidate({ opportunityId: "off", topicVector: [{ topic_id: "zzz", score: 1 }] });
    const ranked = rankCandidates(scholarVec, "early", [], [offTopic], { now: NOW, topicFloor: 0.01 });
    expect(ranked).toHaveLength(0);
  });

  it("custom weights change defaultScore ordering but never the axes", () => {
    const a = candidate({ opportunityId: "a", topicVector: [{ topic_id: "a", score: 1 }], meshDescriptorUi: [] });
    const b = candidate({ opportunityId: "b", topicVector: [{ topic_id: "a", score: 0.8 }], meshDescriptorUi: ["D1"] });
    const base = rankCandidates(scholarVec, "early", ["D1"], [a, b], { now: NOW });
    const meshHeavy = rankCandidates(scholarVec, "early", ["D1"], [a, b], { now: NOW, weights: { ...DEFAULT_WEIGHTS, mesh: 5 } });
    // axes identical across runs (same inputs); only the blend/order can move
    const baseB = base.find((r) => r.opportunityId === "b")!;
    const heavyB = meshHeavy.find((r) => r.opportunityId === "b")!;
    expect(heavyB.axes).toEqual(baseB.axes);
    expect(meshHeavy[0].opportunityId).toBe("b"); // mesh-heavy promotes b
  });
});

describe("scholarTopicRowWeight (vector weighting §2.1/§2.4)", () => {
  it("full weight for a current first/last-author paper", () => {
    expect(scholarTopicRowWeight(2, 2026, "first", 2026)).toBeCloseTo(2);
    expect(scholarTopicRowWeight(2, 2026, "last", 2026)).toBeCloseTo(2);
  });
  it("halves at one recency half-life (5y) and quarters at two", () => {
    expect(scholarTopicRowWeight(1, 2021, "first", 2026)).toBeCloseTo(0.5);
    expect(scholarTopicRowWeight(1, 2016, "first", 2026)).toBeCloseTo(0.25);
  });
  it("down-weights penultimate / middle vs first / last", () => {
    expect(scholarTopicRowWeight(1, 2026, "penultimate", 2026)).toBeCloseTo(0.5);
    expect(scholarTopicRowWeight(1, 2026, "middle", 2026)).toBeCloseTo(0.25); // unknown → middle
    expect(scholarTopicRowWeight(1, 2026, null, 2026)).toBeCloseTo(0.25);
  });
  it("future-dated papers cap at full weight; non-positive base is zero", () => {
    expect(scholarTopicRowWeight(1, 2030, "first", 2026)).toBeCloseTo(1); // age floored at 0
    expect(scholarTopicRowWeight(0, 2026, "first", 2026)).toBe(0);
    expect(scholarTopicRowWeight(-3, 2026, "first", 2026)).toBe(0);
  });
});
