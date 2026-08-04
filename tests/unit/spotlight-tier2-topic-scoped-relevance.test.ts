/**
 * Regression test for the tier-2 (middle-author top-up) "best topic" pick
 * in lib/api/spotlight.ts, exercised via getSpotlightCardsForTopic.
 *
 * Bug: a paper commonly carries a publication_topic row per topic it
 * touches, each with its own relevance `score` — but impact_score is
 * publication-level (identical across every row). Before this fix, the
 * "best topic" pick for a tier-2 candidate compared impact across ALL of
 * the paper's topic rows, which is an always-tied comparison, so it
 * degenerated to an arbitrary row (whichever the DB returned first) —
 * completely independent of which topic's page was actually being viewed.
 * That meant the #2179 relevance-weighted ranking could score a candidate
 * against an unrelated topic's relevance value.
 *
 * Reproduces the reported case: pmid 42401606 carries 8 publication_topic
 * rows, including anesthesiology (relevance 0.35) and surgery_perioperative
 * _medicine (relevance 0.95) — both impact 68. On the anesthesiology topic
 * page, the candidate must be scored against the anesthesiology row (0.35),
 * not whichever row the DB happened to return first.
 */
import { describe, expect, it, vi } from "vitest";

const {
  mockTopicFindUnique,
  mockPublicationTopicFindMany,
  mockPublicationAuthorFindMany,
  mockSubtopicFindMany,
} = vi.hoisted(() => ({
  mockTopicFindUnique: vi.fn(),
  mockPublicationTopicFindMany: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findUnique: mockTopicFindUnique },
    subtopic: { findMany: mockSubtopicFindMany },
    publicationTopic: { findMany: mockPublicationTopicFindMany },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
  },
}));

vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: vi.fn().mockResolvedValue({
    darkPmids: new Set(),
    hiddenAuthorsByPmid: new Map(),
  }),
  resolveDarkPmids: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: vi.fn().mockResolvedValue(new Map()),
}));

import { getSpotlightCardsForTopic } from "@/lib/api/spotlight";

const PUB = (over = {}) => ({
  pmid: "42401606",
  title: "Biological aging increases risk of postoperative morbidity and mortality.",
  journal: "npj aging",
  year: 2026,
  pubmedUrl: null,
  doi: null,
  dateAddedToEntrez: new Date("2026-07-04"),
  impactScore: 68,
  ...over,
});

describe("getSpotlightCardsForTopic tier-2 topic-scoped relevance (regression)", () => {
  it("scores a multi-topic tier-2 candidate against the PAGE's topic relevance, not an arbitrary one", async () => {
    mockTopicFindUnique.mockResolvedValue({ id: "anesthesiology", label: "Anesthesiology" });
    mockSubtopicFindMany.mockResolvedValue([]);

    // Tier-1 direct query: no candidates (forces the tier-2 fill path,
    // matching the real anesthesiology data where author_position is
    // empty on ~all rows).
    mockPublicationTopicFindMany
      .mockResolvedValueOnce([])
      // Tier-2's topicRows query — scoped to parentTopicId: "anesthesiology"
      // per the fix. If the fix regresses (query stops scoping by topic),
      // this mock can't tell the difference on its own, so the assertion
      // below checks the WHERE clause the code actually sent.
      .mockResolvedValueOnce([
        { pmid: "42401606", parentTopicId: "anesthesiology", primarySubtopicId: "anesthesiology_sub", score: 0.35, publication: { impactScore: 68 } },
      ]);

    mockPublicationAuthorFindMany.mockResolvedValue([
      { pmid: "42401606", cwid: "mcr2004", position: 2, publication: PUB() },
    ]);

    const cards = await getSpotlightCardsForTopic("anesthesiology");

    expect(cards).not.toBeNull();
    expect(cards![0].pmid).toBe("42401606");

    // The regression check that actually matters: the tier-2 topicRows
    // query must be scoped to the page's own topic, not fetch every topic
    // the paper touches.
    const tier2Call = mockPublicationTopicFindMany.mock.calls[1][0];
    expect(tier2Call.where.parentTopicId).toBe("anesthesiology");
  });
});
