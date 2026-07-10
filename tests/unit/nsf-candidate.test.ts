import { describe, expect, it } from "vitest";
import { hasFreshNsfResult, isStale } from "@/etl/nsf/candidate";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("isStale", () => {
  it("treats a missing timestamp as stale", () => {
    expect(isStale(null)).toBe(true);
  });
  it("is fresh within the 90-day TTL, stale past it", () => {
    expect(isStale(daysAgo(89))).toBe(false);
    expect(isStale(daysAgo(91))).toBe(true);
  });
});

describe("hasFreshNsfResult", () => {
  it("skips a row that already has a fresh NSF abstract", () => {
    expect(
      hasFreshNsfResult({
        abstract: "x",
        abstractSource: "nsf",
        abstractFetchedAt: daysAgo(1),
      }),
    ).toBe(true);
  });

  // The bug this fix closes: NSF had the award but no abstract, so we stamp
  // a marker (source 'nsf', fetchedAt set, abstract still null). It must be
  // treated as fresh so we don't re-fetch it every run.
  it("skips an abstract-less row carrying a fresh NSF marker", () => {
    expect(
      hasFreshNsfResult({
        abstract: null,
        abstractSource: "nsf",
        abstractFetchedAt: daysAgo(1),
      }),
    ).toBe(true);
  });

  it("re-fetches an abstract-less, never-marked row", () => {
    expect(
      hasFreshNsfResult({
        abstract: null,
        abstractSource: null,
        abstractFetchedAt: null,
      }),
    ).toBe(false);
  });

  it("re-fetches once the marker goes stale", () => {
    expect(
      hasFreshNsfResult({
        abstract: null,
        abstractSource: "nsf",
        abstractFetchedAt: daysAgo(120),
      }),
    ).toBe(false);
  });
});
