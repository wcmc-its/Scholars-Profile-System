/**
 * Report 17 shared module (`lib/edit/pub-relevance-report.ts`): the review
 * marker and the kind filter (reviews / non-reviews), with the status counts
 * computed inside the kind.
 */
import { describe, expect, it } from "vitest";

import {
  filterPubRelevance,
  isReviewPublicationType,
  parsePubRelevanceParams,
  type PubRelevanceRow,
} from "@/lib/edit/pub-relevance-report";

const row = (pmid: string, over: Partial<PubRelevanceRow>): PubRelevanceRow => ({
  pmid,
  title: `Synthetic title ${pmid}`,
  journal: null,
  year: 2025,
  publicationType: "Academic Article",
  isReview: false,
  members: [],
  relevant: true,
  source: "llm",
  reason: null,
  ...over,
});

describe("isReviewPublicationType", () => {
  it("is true for the canonical Review type only", () => {
    expect(isReviewPublicationType("Review")).toBe(true);
    for (const t of ["Academic Article", "Preprint", "review", "", null, undefined])
      expect(isReviewPublicationType(t)).toBe(false);
  });
});

describe("filterPubRelevance kind", () => {
  const rows = [
    row("1", { isReview: true, publicationType: "Review" }),
    row("2", { isReview: true, publicationType: "Review", source: "human" }),
    row("3", {}),
    row("4", { source: "rule", relevant: false, publicationType: "Preprint" }),
  ];

  it("selects reviews, non-reviews, or both", () => {
    expect(filterPubRelevance(rows, "all", "review").rows.map((r) => r.pmid)).toEqual(["1", "2"]);
    expect(filterPubRelevance(rows, "all", "non-review").rows.map((r) => r.pmid)).toEqual([
      "3",
      "4",
    ]);
    expect(filterPubRelevance(rows, "all").rows).toHaveLength(4);
  });

  it("counts statuses within the kind, and combines with the status filter", () => {
    const { rows: out, counts } = filterPubRelevance(rows, "ai", "review");
    expect(out.map((r) => r.pmid)).toEqual(["1"]);
    expect(counts).toMatchObject({ all: 2, ai: 1, confirmed: 1, rule: 0 });
  });

  it("parses kind from the URL, defaulting to all", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    expect(parsePubRelevanceParams(new URLSearchParams("kind=review"), now).kind).toBe("review");
    expect(parsePubRelevanceParams(new URLSearchParams("kind=non-review"), now).kind).toBe(
      "non-review",
    );
    expect(parsePubRelevanceParams(new URLSearchParams("kind=bogus"), now).kind).toBe("all");
  });
});
