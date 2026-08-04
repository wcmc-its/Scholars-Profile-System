/**
 * Tests for the relevance-weighted Spotlight ranking in lib/api/spotlight.ts.
 *
 * User report: pmid 42401606 (relevance score 0.35, impact 68, recently
 * added to Entrez) won the anesthesiology Spotlight slot over more centrally
 * on-topic papers, because the prior sort (dateAddedToEntrez -> year ->
 * impactScore) never looked at relevance at all. spotlightScore weights
 * relevance (1.4) above impact (1.2, normalized to 0-1) so on-topic-ness
 * dominates the ranking.
 *
 * Covers:
 *   - spotlightScore weights relevance above impact
 *   - sortForSpotlight ranks a highly-relevant paper above the user's
 *     reported low-relevance/high-impact/recent one
 *   - spotlightScore is deterministic and pure
 */
import { describe, expect, it } from "vitest";
import {
  spotlightScore,
  sortForSpotlight,
  type CandidateRow,
} from "@/lib/api/spotlight";

/** Minimal candidate row fixture, per-test overrides for the fields that matter. */
function candidate(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    pmid: "1",
    cwid: "abc1234",
    parentTopicId: "anesthesiology",
    primarySubtopicId: null,
    impactScore: 50,
    relevanceScore: 0.5,
    position: null,
    publication: {
      pmid: "1",
      title: "Untitled",
      journal: null,
      year: 2024,
      pubmedUrl: null,
      doi: null,
      dateAddedToEntrez: new Date("2024-01-01"),
    },
    ...over,
  };
}

describe("spotlightScore", () => {
  it("weights relevance (1.4) above normalized impact (1.2)", () => {
    // Same relevance, higher impact should score higher, but by less than
    // an equivalent relevance bump would.
    const higherImpact = spotlightScore(0.5, 80) - spotlightScore(0.5, 50);
    const higherRelevance = spotlightScore(0.8, 50) - spotlightScore(0.5, 50);
    expect(higherRelevance).toBeGreaterThan(higherImpact);
  });

  it("is deterministic and pure", () => {
    expect(spotlightScore(0.35, 68)).toBe(spotlightScore(0.35, 68));
  });

  it("matches the reported case: a 0.35-relevance/68-impact paper scores below a 0.8-relevance/50-impact one", () => {
    const reported = spotlightScore(0.35, 68); // pmid 42401606 under anesthesiology
    const stronglyOnTopic = spotlightScore(0.8, 50);
    expect(stronglyOnTopic).toBeGreaterThan(reported);
  });
});

describe("sortForSpotlight (relevance-weighted)", () => {
  it("ranks a strongly on-topic paper above a barely-on-topic, high-impact, recent one", () => {
    // Reproduces the user-reported case: low relevance (0.35) but high
    // impact (68) and very recently added — under the old
    // dateAdded -> year -> impactScore sort this won outright.
    const reported = candidate({
      pmid: "42401606",
      relevanceScore: 0.35,
      impactScore: 68,
      publication: {
        ...candidate().publication,
        pmid: "42401606",
        dateAddedToEntrez: new Date("2026-07-04"),
        year: 2026,
      },
    });
    const stronglyOnTopic = candidate({
      pmid: "99999999",
      relevanceScore: 0.85,
      impactScore: 45,
      publication: {
        ...candidate().publication,
        pmid: "99999999",
        dateAddedToEntrez: new Date("2025-01-01"),
        year: 2025,
      },
    });
    const [first] = sortForSpotlight([reported, stronglyOnTopic]);
    expect(first.pmid).toBe("99999999");
  });

  it("falls back to dateAddedToEntrez when spotlightScore ties", () => {
    const a = candidate({
      pmid: "a",
      relevanceScore: 0.5,
      impactScore: 50,
      publication: { ...candidate().publication, pmid: "a", dateAddedToEntrez: new Date("2024-06-01") },
    });
    const b = candidate({
      pmid: "b",
      relevanceScore: 0.5,
      impactScore: 50,
      publication: { ...candidate().publication, pmid: "b", dateAddedToEntrez: new Date("2025-06-01") },
    });
    const [first] = sortForSpotlight([a, b]);
    expect(first.pmid).toBe("b"); // more recent wins the tie
  });
});
