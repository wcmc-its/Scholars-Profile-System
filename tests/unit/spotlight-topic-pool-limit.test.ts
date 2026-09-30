/**
 * `getSpotlightCardsForTopic` pool size: the default stays the historical 3
 * (every other caller unchanged); the topic page asks for up to 9 to page
 * through, and the limit is clamped to 1..9. Fake pmids / cwids only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTopicFindUnique, mockPublicationTopicFindMany, mockSubtopicFindMany } = vi.hoisted(
  () => ({
    mockTopicFindUnique: vi.fn(),
    mockPublicationTopicFindMany: vi.fn(),
    mockSubtopicFindMany: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findUnique: mockTopicFindUnique },
    subtopic: { findMany: mockSubtopicFindMany },
    publicationTopic: { findMany: mockPublicationTopicFindMany },
    publicationAuthor: { findMany: vi.fn().mockResolvedValue([]) },
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

import { getSpotlightCardsForTopic, TOPIC_SPOTLIGHT_POOL_MAX } from "@/lib/api/spotlight";

function row(i: number) {
  return {
    pmid: `900000${i.toString().padStart(2, "0")}`,
    cwid: `zzz${1000 + i}`,
    parentTopicId: "test_topic",
    primarySubtopicId: null,
    score: 0.9 - i * 0.01,
    publication: {
      pmid: `900000${i.toString().padStart(2, "0")}`,
      title: `Paper ${i}`,
      journal: "Journal",
      year: 2025,
      pubmedUrl: null,
      doi: null,
      dateAddedToEntrez: new Date("2025-01-01"),
      impactScore: 60,
    },
  };
}

beforeEach(() => {
  mockTopicFindUnique.mockResolvedValue({ id: "test_topic", label: "Test Topic" });
  mockSubtopicFindMany.mockResolvedValue([]);
  mockPublicationTopicFindMany.mockReset();
  mockPublicationTopicFindMany.mockResolvedValue(Array.from({ length: 12 }, (_, i) => row(i)));
});

describe("getSpotlightCardsForTopic pool size", () => {
  it("defaults to 3 (unchanged for existing callers)", async () => {
    const cards = await getSpotlightCardsForTopic("test_topic");
    expect(cards).toHaveLength(3);
    expect(cards!.map((c) => c.title)).toEqual(["Paper 0", "Paper 1", "Paper 2"]);
  });

  it("returns up to 9 with the topic page's limit, best first", async () => {
    expect(TOPIC_SPOTLIGHT_POOL_MAX).toBe(9);
    const cards = await getSpotlightCardsForTopic("test_topic", { limit: TOPIC_SPOTLIGHT_POOL_MAX });
    expect(cards).toHaveLength(9);
    expect(cards![0].title).toBe("Paper 0");
    expect(cards![8].title).toBe("Paper 8");
  });

  it("clamps the limit to 1..9", async () => {
    expect(await getSpotlightCardsForTopic("test_topic", { limit: 50 })).toHaveLength(9);
    expect(await getSpotlightCardsForTopic("test_topic", { limit: 0 })).toHaveLength(1);
  });
});
