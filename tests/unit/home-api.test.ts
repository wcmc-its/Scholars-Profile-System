/**
 * Unit tests for lib/api/home.ts — three pure data-fetcher functions for the
 * Phase 2 home page composition (Recent contributions, Selected research,
 * Browse all research areas).
 *
 * Schema shape: candidate (e) per 02-SCHEMA-DECISION.md. The mocks use the
 * `publicationTopic` Prisma model (composite PK on pmid+cwid+parentTopicId,
 * embedded subtopic JSON, no first-class subtopic table). The `topic` table
 * contains 67 rows — ALL parents — with no `parentId` column.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Prisma mock — adjust per actual lib/db export. Three model accessors are
// exercised: publicationTopic, topic, and prisma.$queryRawUnsafe / $queryRaw
// for the distinct-cwid scholar count aggregation that Prisma groupBy can't
// express directly.
const mockPubTopicFindMany = vi.fn();
const mockPubTopicGroupBy = vi.fn();
const mockTopicFindMany = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      findMany: mockPubTopicFindMany,
      groupBy: mockPubTopicGroupBy,
    },
    topic: {
      findMany: mockTopicFindMany,
    },
    $queryRaw: mockQueryRaw,
    $queryRawUnsafe: mockQueryRaw,
  },
}));

import {
  getRecentContributions,
  getSelectedResearch,
  getBrowseAllResearchAreas,
} from "@/lib/api/home";

const NOW = new Date("2026-04-01");

// ---------- helpers to build fake (e)-shape rows ----------

function makePubTopicRow(over: {
  pmid?: number;
  cwid?: string;
  parentTopicId?: string;
  primarySubtopicId?: string | null;
  authorPosition?: string;
  year?: number;
  score?: number;
  daysAgo?: number;
  scholarRoleCategory?: string;
  scholarPreferredName?: string;
  scholarPrimaryTitle?: string | null;
  scholarSlug?: string;
  scholarStatus?: string;
  scholarDeletedAt?: Date | null;
  pubType?: string;
  pubJournal?: string | null;
  pubTitle?: string;
  pubDoi?: string | null;
  pubPubmedUrl?: string | null;
  parentLabel?: string;
} = {}) {
  const dateAdded = new Date(NOW.getTime() - (over.daysAgo ?? 30) * 24 * 60 * 60 * 1000);
  return {
    pmid: over.pmid ?? 1000001,
    cwid: over.cwid ?? "abc1234",
    parentTopicId: over.parentTopicId ?? "cancer_genomics",
    primarySubtopicId: over.primarySubtopicId ?? null,
    subtopicIds: null,
    subtopicConfidences: null,
    score: over.score ?? 0.85,
    impactScore: 0.9,
    authorPosition: over.authorPosition ?? "first",
    year: over.year ?? 2025,
    scholar: {
      cwid: over.cwid ?? "abc1234",
      slug: over.scholarSlug ?? "jane-doe",
      preferredName: over.scholarPreferredName ?? "Jane Doe",
      primaryTitle: over.scholarPrimaryTitle ?? "Associate Professor",
      roleCategory: over.scholarRoleCategory ?? "full_time_faculty",
      status: over.scholarStatus ?? "active",
      deletedAt: over.scholarDeletedAt ?? null,
    },
    topic: {
      id: over.parentTopicId ?? "cancer_genomics",
      label: over.parentLabel ?? "Cancer Genomics",
      description: "Cancer genomics research.",
    },
    publication: {
      pmid: String(over.pmid ?? 1000001),
      title: over.pubTitle ?? "An important paper",
      journal: over.pubJournal ?? "Nature",
      year: over.year ?? 2025,
      publicationType: over.pubType ?? "Academic Article",
      dateAddedToEntrez: dateAdded,
      doi: over.pubDoi ?? "10.1000/xyz",
      pubmedUrl: over.pubPubmedUrl ?? "https://pubmed.ncbi.nlm.nih.gov/1000001",
    },
  };
}

beforeEach(() => {
  mockPubTopicFindMany.mockReset();
  mockPubTopicGroupBy.mockReset();
  mockTopicFindMany.mockReset();
  mockQueryRaw.mockReset();
});

describe("getRecentContributions (RANKING-01)", () => {
  it("returns null with sparse-state log when fewer than 3 cards qualify", async () => {
    // Two distinct-parent rows — below the floor of 3
    mockPubTopicFindMany.mockResolvedValue([
      makePubTopicRow({ pmid: 1, parentTopicId: "cancer_genomics", daysAgo: 120 }),
      makePubTopicRow({ pmid: 2, parentTopicId: "neuroscience", daysAgo: 200, cwid: "def5678" }),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getRecentContributions(NOW);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(logged);
    expect(parsed.event).toBe("sparse_state_hide");
    expect(parsed.surface).toBe("home_recent_contributions");
    expect(parsed.floor).toBe(3);
    warn.mockRestore();
  });

  it("returns up to 6 cards when sufficient qualify, deduped one-per-parent", async () => {
    // 8 rows across 6 distinct parents. After dedup expect 6 cards.
    const parents = [
      "cancer_genomics", "neuroscience", "immunology", "cardiology",
      "endocrinology", "infectious_disease", "cancer_genomics", "neuroscience",
    ];
    mockPubTopicFindMany.mockResolvedValue(
      parents.map((p, i) =>
        makePubTopicRow({
          pmid: 100 + i,
          parentTopicId: p,
          parentLabel: p.replace(/_/g, " "),
          cwid: `c${i.toString().padStart(4, "0")}`,
          scholarSlug: `scholar-${i}`,
          scholarPreferredName: `Scholar ${i}`,
          daysAgo: 30 + i * 10,
          score: 0.9 - i * 0.05,
        }),
      ),
    );
    const result = await getRecentContributions(NOW);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(6);
    expect(result!.length).toBeGreaterThanOrEqual(3);
  });

  it("never includes citationCount field on returned objects (locked by design spec v1.7.1)", async () => {
    mockPubTopicFindMany.mockResolvedValue(
      ["cancer_genomics", "neuroscience", "immunology", "cardiology", "endocrinology"].map(
        (p, i) =>
          makePubTopicRow({
            pmid: 200 + i,
            parentTopicId: p,
            cwid: `c${i.toString().padStart(4, "0")}`,
            scholarSlug: `scholar-${i}`,
            daysAgo: 30,
          }),
      ),
    );
    const result = await getRecentContributions(NOW);
    expect(result).not.toBeNull();
    for (const c of result!) {
      expect(c).not.toHaveProperty("citationCount");
      expect(c.paper).not.toHaveProperty("citationCount");
    }
  });

  it("filter: Prisma where clause includes ELIGIBLE_ROLES roleCategory + first-or-last + year>=2020 + non-excluded pub types", async () => {
    mockPubTopicFindMany.mockResolvedValue([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await getRecentContributions(NOW);
    expect(mockPubTopicFindMany).toHaveBeenCalled();
    const callArg = mockPubTopicFindMany.mock.calls[0][0];
    // ELIGIBLE_ROLES check
    expect(callArg.where.scholar.roleCategory.in).toEqual(
      expect.arrayContaining(["full_time_faculty", "postdoc", "fellow", "doctoral_student"]),
    );
    // Author position first or last
    expect(callArg.where.authorPosition.in).toEqual(expect.arrayContaining(["first", "last"]));
    // Year floor (D-15 — 2020+)
    expect(callArg.where.year.gte).toBe(2020);
    // Hard-excluded types
    expect(callArg.where.publication.publicationType.notIn).toEqual(
      expect.arrayContaining(["Letter", "Editorial Article", "Erratum"]),
    );
    warn.mockRestore();
  });
});

describe("getSelectedResearch (HOME-02)", () => {
  it("returns null with sparse-state log when fewer than 4 subtopics qualify", async () => {
    // groupBy returns 2 distinct subtopic groups under 2 distinct parents — below floor of 4
    mockPubTopicGroupBy.mockResolvedValue([
      {
        parentTopicId: "cancer_genomics",
        primarySubtopicId: "breast_screening",
        _sum: { score: 5.0 },
        _count: { _all: 6 },
      },
      {
        parentTopicId: "neuroscience",
        primarySubtopicId: "alzheimers_imaging",
        _sum: { score: 3.5 },
        _count: { _all: 4 },
      },
    ]);
    mockTopicFindMany.mockResolvedValue([
      { id: "cancer_genomics", label: "Cancer Genomics", description: null },
      { id: "neuroscience", label: "Neuroscience", description: null },
    ]);
    mockQueryRaw.mockResolvedValue([]);
    mockPubTopicFindMany.mockResolvedValue([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getSelectedResearch(NOW);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("home_selected_research"),
    )?.[0] as string | undefined;
    expect(logged).toBeTruthy();
    const parsed = JSON.parse(logged!);
    expect(parsed.surface).toBe("home_selected_research");
    expect(parsed.floor).toBe(4);
    warn.mockRestore();
  });

  it("dedups one card per parent area (no parent appears twice in the result)", async () => {
    // Multiple subtopic groups across 5 parents; same parent appears in 2 groups.
    mockPubTopicGroupBy.mockResolvedValue([
      { parentTopicId: "cancer_genomics", primarySubtopicId: "breast_screening", _sum: { score: 9.0 }, _count: { _all: 10 } },
      { parentTopicId: "cancer_genomics", primarySubtopicId: "lung_genomics", _sum: { score: 8.5 }, _count: { _all: 9 } },
      { parentTopicId: "neuroscience", primarySubtopicId: "alzheimers_imaging", _sum: { score: 7.0 }, _count: { _all: 8 } },
      { parentTopicId: "immunology", primarySubtopicId: "t_cell_response", _sum: { score: 6.5 }, _count: { _all: 7 } },
      { parentTopicId: "cardiology", primarySubtopicId: "heart_failure", _sum: { score: 6.0 }, _count: { _all: 7 } },
      { parentTopicId: "endocrinology", primarySubtopicId: "diabetes_t2", _sum: { score: 5.5 }, _count: { _all: 6 } },
    ]);
    mockTopicFindMany.mockResolvedValue([
      { id: "cancer_genomics", label: "Cancer Genomics", description: null },
      { id: "neuroscience", label: "Neuroscience", description: null },
      { id: "immunology", label: "Immunology", description: null },
      { id: "cardiology", label: "Cardiology", description: null },
      { id: "endocrinology", label: "Endocrinology", description: null },
    ]);
    mockQueryRaw.mockResolvedValue([
      { parent_topic_id: "cancer_genomics", primary_subtopic_id: "breast_screening", scholar_count: 12 },
      { parent_topic_id: "cancer_genomics", primary_subtopic_id: "lung_genomics", scholar_count: 8 },
      { parent_topic_id: "neuroscience", primary_subtopic_id: "alzheimers_imaging", scholar_count: 9 },
      { parent_topic_id: "immunology", primary_subtopic_id: "t_cell_response", scholar_count: 7 },
      { parent_topic_id: "cardiology", primary_subtopic_id: "heart_failure", scholar_count: 6 },
      { parent_topic_id: "endocrinology", primary_subtopic_id: "diabetes_t2", scholar_count: 5 },
    ]);
    // findMany for top-2 publications per (parent,subtopic) — return any rows
    mockPubTopicFindMany.mockResolvedValue([]);
    const result = await getSelectedResearch(NOW);
    if (result) {
      const parentSlugs = result.map((r) => r.parentTopicSlug);
      expect(new Set(parentSlugs).size).toBe(parentSlugs.length);
    }
  });

  it("returns at most 8 cards when sufficient qualify", async () => {
    // 12 distinct parents — should slice to 8
    const parents = Array.from({ length: 12 }, (_, i) => `parent_${i}`);
    mockPubTopicGroupBy.mockResolvedValue(
      parents.map((p, i) => ({
        parentTopicId: p,
        primarySubtopicId: `sub_${i}`,
        _sum: { score: 9 - i * 0.3 },
        _count: { _all: 10 - i },
      })),
    );
    mockTopicFindMany.mockResolvedValue(
      parents.map((p) => ({ id: p, label: p.replace(/_/g, " "), description: null })),
    );
    mockQueryRaw.mockResolvedValue(
      parents.map((p, i) => ({
        parent_topic_id: p,
        primary_subtopic_id: `sub_${i}`,
        scholar_count: 5 + i,
      })),
    );
    mockPubTopicFindMany.mockResolvedValue([]);
    const result = await getSelectedResearch(NOW);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(8);
  });
});

describe("getBrowseAllResearchAreas (HOME-03)", () => {
  it("returns 67 parent topic rows from Topic table (under (e), every Topic row is a parent)", async () => {
    mockTopicFindMany.mockResolvedValue(
      Array.from({ length: 67 }, (_, i) => ({
        id: `topic_${i}`,
        label: `Topic ${i}`,
        description: null,
      })),
    );
    mockQueryRaw.mockResolvedValue(
      Array.from({ length: 67 }, (_, i) => ({
        parent_topic_id: `topic_${i}`,
        scholar_count: 100 + i,
      })),
    );
    const result = await getBrowseAllResearchAreas();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(67);
  });

  it("never returns null even with 0 topics (D-12 — Browse always renders)", async () => {
    mockTopicFindMany.mockResolvedValue([]);
    mockQueryRaw.mockResolvedValue([]);
    const result = await getBrowseAllResearchAreas();
    expect(result).toEqual([]);
  });

  it("merges scholar counts onto parent topic rows", async () => {
    mockTopicFindMany.mockResolvedValue([
      { id: "cancer_genomics", label: "Cancer Genomics", description: null },
      { id: "neuroscience", label: "Neuroscience", description: null },
    ]);
    mockQueryRaw.mockResolvedValue([
      { parent_topic_id: "cancer_genomics", scholar_count: 42 },
      { parent_topic_id: "neuroscience", scholar_count: 17 },
    ]);
    const result = await getBrowseAllResearchAreas();
    expect(result).toEqual([
      { slug: "cancer_genomics", name: "Cancer Genomics", scholarCount: 42 },
      { slug: "neuroscience", name: "Neuroscience", scholarCount: 17 },
    ]);
  });
});
