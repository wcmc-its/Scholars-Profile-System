import { describe, expect, it } from "vitest";

import {
  AREA_SIGNAL_CAP,
  AREA_SIGNAL_WEIGHT,
  collapseGrantProjects,
  scoreAreaSignals,
  signalRecencyWeight,
  type GrantProjectRow,
} from "@/lib/ranking";

const NOW = new Date("2026-10-15T00:00:00Z");
const monthsAgo = (m: number) => new Date(NOW.getTime() - m * 30.4375 * 24 * 3600 * 1000);

describe("pilot constants", () => {
  it("are W = 2 and a cap of 3 (Gate 2 settings)", () => {
    expect(AREA_SIGNAL_WEIGHT).toBe(2);
    expect(AREA_SIGNAL_CAP).toBe(3);
  });
});

describe("signalRecencyWeight", () => {
  it("is 1.0 under 36 months, 0.6 under 60, then 0.3", () => {
    expect(signalRecencyWeight(0)).toBe(1);
    expect(signalRecencyWeight(35.9)).toBe(1);
    expect(signalRecencyWeight(36)).toBe(0.6);
    expect(signalRecencyWeight(59.9)).toBe(0.6);
    expect(signalRecencyWeight(60)).toBe(0.3);
    expect(signalRecencyWeight(Number.POSITIVE_INFINITY)).toBe(0.3);
  });
});

describe("scoreAreaSignals", () => {
  it("is score x W x recency", () => {
    expect(scoreAreaSignals([{ kind: "grant", score: 0.5, start: monthsAgo(12) }], NOW)).toBeCloseTo(1.0);
    expect(scoreAreaSignals([{ kind: "trial", score: 0.5, start: monthsAgo(48) }], NOW)).toBeCloseTo(0.6);
    expect(scoreAreaSignals([{ kind: "trial", score: 0.5, start: null }], NOW)).toBeCloseTo(0.3);
    // A future start (an estimated CT.gov date) pins to today.
    expect(scoreAreaSignals([{ kind: "trial", score: 0.5, start: monthsAgo(-6) }], NOW)).toBeCloseTo(1.0);
  });

  it("counts the top 3 of each kind separately", () => {
    const grants = [0.9, 0.8, 0.7, 0.6, 0.5].map((score) => ({
      kind: "grant" as const,
      score,
      start: monthsAgo(1),
    }));
    const trials = [0.4, 0.4, 0.4, 0.4].map((score) => ({ kind: "trial" as const, score, start: monthsAgo(1) }));
    expect(scoreAreaSignals(grants, NOW)).toBeCloseTo((0.9 + 0.8 + 0.7) * 2);
    expect(scoreAreaSignals([...grants, ...trials], NOW)).toBeCloseTo((0.9 + 0.8 + 0.7) * 2 + 0.4 * 3 * 2);
  });

  it("caps on the weighted contribution, so an old high score can lose to a recent lower one", () => {
    const items = [
      { kind: "grant" as const, score: 0.9, start: monthsAgo(80) }, // 0.54
      { kind: "grant" as const, score: 0.5, start: monthsAgo(1) }, // 1.0
      { kind: "grant" as const, score: 0.5, start: monthsAgo(2) }, // 1.0
      { kind: "grant" as const, score: 0.4, start: monthsAgo(3) }, // 0.8
    ];
    expect(scoreAreaSignals(items, NOW)).toBeCloseTo(2.8);
  });

  it("honors w and cap overrides and ignores zero scores", () => {
    const items = [
      { kind: "grant" as const, score: 0.5, start: monthsAgo(1) },
      { kind: "grant" as const, score: 0, start: monthsAgo(1) },
    ];
    expect(scoreAreaSignals(items, NOW, { w: 1, cap: 1 })).toBeCloseTo(0.5);
    expect(scoreAreaSignals([], NOW)).toBe(0);
  });
});

describe("collapseGrantProjects", () => {
  const row = (over: Partial<GrantProjectRow> & { id: string }): GrantProjectRow => ({
    cwid: "s1",
    title: "A synthetic project",
    awardNumber: null,
    mechanism: null,
    ...over,
  });

  it("merges renewals sharing a normalized title", () => {
    const groups = collapseGrantProjects([
      row({ id: "a", title: "Synthetic Project: Year 1" }),
      row({ id: "b", title: "synthetic project -- year 1" }),
      row({ id: "c", title: "A different project" }),
    ]);
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("merges NIH rows sharing an IC + serial (supplements, re-issues), and transitively", () => {
    const groups = collapseGrantProjects([
      row({ id: "r01", title: "Parent title", mechanism: "R01", awardNumber: "1 R01 ZZ 123456-01" }),
      row({ id: "supp", title: "Supplement title", mechanism: "R01", awardNumber: "3R01ZZ123456-02S1" }),
      row({ id: "renamed", title: "Supplement title" }), // joins via the supplement's title
      row({ id: "other", title: "Other", mechanism: "R21", awardNumber: "R21 ZZ 654321" }),
    ]);
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([["r01", "supp", "renamed"], ["other"]]);
  });

  it("ignores an award-number serial on a non-NIH row (no mechanism)", () => {
    const groups = collapseGrantProjects([
      row({ id: "a", title: "One", mechanism: null, awardNumber: "ZZ123456" }),
      row({ id: "b", title: "Two", mechanism: null, awardNumber: "ZZ123456" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("never merges across scholars", () => {
    const groups = collapseGrantProjects([row({ id: "a", cwid: "s1" }), row({ id: "b", cwid: "s2" })]);
    expect(groups).toHaveLength(2);
  });
});
