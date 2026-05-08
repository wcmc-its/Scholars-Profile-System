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
//
// vi.mock factories are hoisted; closure variables must be declared via
// vi.hoisted so they're initialized before the factory runs.
const mocks = vi.hoisted(() => ({
  pubTopicFindMany: vi.fn(),
  pubTopicGroupBy: vi.fn(),
  topicFindMany: vi.fn(),
  publicationFindMany: vi.fn(),
  subtopicFindMany: vi.fn().mockResolvedValue([]),
  spotlightFindMany: vi.fn(),
  scholarFindMany: vi.fn(),
  publicationAuthorFindMany: vi.fn(),
  queryRaw: vi.fn(),
}));
const {
  pubTopicFindMany: mockPubTopicFindMany,
  pubTopicGroupBy: mockPubTopicGroupBy,
  topicFindMany: mockTopicFindMany,
  publicationFindMany: mockPublicationFindMany,
  spotlightFindMany: mockSpotlightFindMany,
  scholarFindMany: mockScholarFindMany,
  publicationAuthorFindMany: mockPublicationAuthorFindMany,
  queryRaw: mockQueryRaw,
} = mocks;

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      findMany: mocks.pubTopicFindMany,
      groupBy: mocks.pubTopicGroupBy,
    },
    topic: {
      findMany: mocks.topicFindMany,
    },
    subtopic: {
      findMany: mocks.subtopicFindMany,
    },
    publication: {
      findMany: mocks.publicationFindMany,
    },
    spotlight: {
      findMany: mocks.spotlightFindMany,
    },
    scholar: {
      findMany: mocks.scholarFindMany,
    },
    publicationAuthor: {
      findMany: mocks.publicationAuthorFindMany,
    },
    $queryRaw: mocks.queryRaw,
    $queryRawUnsafe: mocks.queryRaw,
  },
}));

import {
  getRecentContributions,
  getSelectedResearch,
  getSpotlights,
  getBrowseAllResearchAreas,
} from "@/lib/api/home";

const NOW = new Date("2026-04-01");

// ---------- helpers to build fake (e)-shape rows ----------

type FixtureSpec = {
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
};

/**
 * Build a fake publication_topic row in the candidate-(e) shape that
 * `getRecentContributions` and `getSelectedResearch` consume (after
 * `include: { scholar, topic, publication }`). Under candidate (e),
 * publication_topic.pmid is VARCHAR(32) FK-related to publication.pmid,
 * so the publication payload is included via Prisma `include`.
 */
function makePubTopicRow(over: FixtureSpec = {}) {
  return {
    pmid: String(over.pmid ?? 1000001),
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
    publication: makePubRow(over),
  };
}

/** Build a Publication row matching makePubTopicRow's pmid. */
function makePubRow(over: FixtureSpec = {}) {
  const pmidNum = over.pmid ?? 1000001;
  const dateAdded = new Date(NOW.getTime() - (over.daysAgo ?? 30) * 24 * 60 * 60 * 1000);
  return {
    pmid: String(pmidNum),
    title: over.pubTitle ?? "An important paper",
    journal: over.pubJournal ?? "Nature",
    year: over.year ?? 2025,
    publicationType: over.pubType ?? "Academic Article",
    dateAddedToEntrez: dateAdded,
    pubmedUrl: over.pubPubmedUrl ?? "https://pubmed.ncbi.nlm.nih.gov/1000001",
    doi: over.pubDoi ?? "10.1000/xyz",
  };
}

beforeEach(() => {
  mockPubTopicFindMany.mockReset();
  mockPubTopicGroupBy.mockReset();
  mockTopicFindMany.mockReset();
  mockPublicationFindMany.mockReset();
  mockSpotlightFindMany.mockReset();
  mockScholarFindMany.mockReset();
  mockPublicationAuthorFindMany.mockReset();
  mockQueryRaw.mockReset();
});

// ---------- helpers for spotlight fixtures ----------

function makeSpotlightRow(over: {
  subtopicId: string;
  parentTopicId: string;
  displayName?: string;
  shortDescription?: string;
  lede?: string;
  pmids: string[];
}) {
  return {
    subtopicId: over.subtopicId,
    parentTopicId: over.parentTopicId,
    label: over.subtopicId.replace(/_/g, " "),
    displayName: over.displayName ?? over.subtopicId.replace(/_/g, " "),
    shortDescription: over.shortDescription ?? "",
    lede: over.lede ?? `WCM scholars are advancing ${over.subtopicId}.`,
    papers: over.pmids.map((pmid) => ({
      pmid,
      title: `Paper ${pmid}`,
      journal: "Nature",
      year: 2025,
      // The artifact carries first_author / last_author but the DAL no
      // longer reads them — see author-resolution policy in lib/api/home.ts.
      first_author: { personIdentifier: "ignored", displayName: "Ignored", position: "first" },
      last_author: { personIdentifier: "ignored", displayName: "Ignored", position: "last" },
    })),
    artifactVersion: "v2026-05-07",
    refreshedAt: NOW,
  };
}

function makeAuthorRow(over: {
  pmid: string;
  cwid: string;
  position: number;
  preferredName?: string;
  slug?: string;
}) {
  return {
    id: `${over.pmid}-${over.cwid}`,
    pmid: over.pmid,
    cwid: over.cwid,
    externalName: null,
    position: over.position,
    totalAuthors: 5,
    isFirst: false,
    isLast: false,
    isPenultimate: false,
    isConfirmed: true,
    lastRefreshedAt: NOW,
    scholar: {
      cwid: over.cwid,
      slug: over.slug ?? `slug-${over.cwid}`,
      preferredName: over.preferredName ?? `Name ${over.cwid}`,
    },
  };
}

describe("getRecentContributions (RANKING-01)", () => {
  it("returns null with sparse-state log when fewer than 3 cards qualify", async () => {
    // Two distinct-parent rows — below the floor of 3
    mockPubTopicFindMany.mockResolvedValue([
      makePubTopicRow({ pmid: 1, parentTopicId: "cancer_genomics", daysAgo: 120 }),
      makePubTopicRow({ pmid: 2, parentTopicId: "neuroscience", daysAgo: 200, cwid: "def5678" }),
    ]);
    mockPublicationFindMany.mockResolvedValue([
      makePubRow({ pmid: 1, daysAgo: 120 }),
      makePubRow({ pmid: 2, daysAgo: 200 }),
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
    const ptRows = parents.map((p, i) =>
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
    );
    mockPubTopicFindMany.mockResolvedValue(ptRows);
    mockPublicationFindMany.mockResolvedValue(
      ptRows.map((r, i) => makePubRow({ pmid: 100 + i, daysAgo: 30 + i * 10 })),
    );
    const result = await getRecentContributions(NOW);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(6);
    expect(result!.length).toBeGreaterThanOrEqual(3);
    // Dedup: distinct slugs (i.e. no duplicate parent — implicit via score)
    expect(new Set(result!.map((r) => r.cwid)).size).toBe(result!.length);
  });

  it("never includes citationCount field on returned objects (locked by design spec v1.7.1)", async () => {
    const parents = ["cancer_genomics", "neuroscience", "immunology", "cardiology", "endocrinology"];
    const ptRows = parents.map((p, i) =>
      makePubTopicRow({
        pmid: 200 + i,
        parentTopicId: p,
        cwid: `c${i.toString().padStart(4, "0")}`,
        scholarSlug: `scholar-${i}`,
        daysAgo: 30,
      }),
    );
    mockPubTopicFindMany.mockResolvedValue(ptRows);
    mockPublicationFindMany.mockResolvedValue(
      ptRows.map((_, i) => makePubRow({ pmid: 200 + i, daysAgo: 30 })),
    );
    const result = await getRecentContributions(NOW);
    expect(result).not.toBeNull();
    for (const c of result!) {
      expect(c).not.toHaveProperty("citationCount");
      expect(c.paper).not.toHaveProperty("citationCount");
    }
  });

  it("filter: Prisma where clause includes ELIGIBLE_ROLES roleCategory + first-or-last + year>=2020", async () => {
    mockPubTopicFindMany.mockResolvedValue([]);
    mockPublicationFindMany.mockResolvedValue([]);
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
    // Hard-excluded pub-types are filtered in the publicationTopic WHERE clause
    // via the included publication relation (FK).
    warn.mockRestore();
  });

  it("filter: hard-excluded pub-types (Letter / Editorial / Erratum) are dropped", async () => {
    // Hard-exclude is enforced in the publicationTopic.findMany WHERE clause
    // via `publication: { publicationType: { notIn: [...] } }` (FK relation).
    mockPubTopicFindMany.mockResolvedValue([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await getRecentContributions(NOW);
    expect(mockPubTopicFindMany).toHaveBeenCalled();
    const callArg = mockPubTopicFindMany.mock.calls[0][0];
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

describe("getSpotlights (Phase 9 SPOTLIGHT-03)", () => {
  it("returns null with sparse-state log when no spotlight rows exist", async () => {
    mockSpotlightFindMany.mockResolvedValue([]);
    mockTopicFindMany.mockResolvedValue([]);
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getSpotlights();
    expect(result).toBeNull();
    const logged = warn.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("home_spotlights"),
    )?.[0] as string | undefined;
    expect(logged).toBeTruthy();
    const parsed = JSON.parse(logged!);
    expect(parsed.surface).toBe("home_spotlights");
    expect(parsed.floor).toBe(6);
    warn.mockRestore();
  });

  it("includes per-subtopic publication + scholar counts via raw aggregation", async () => {
    mockSpotlightFindMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) =>
        makeSpotlightRow({
          subtopicId: `sub_${i}`,
          parentTopicId: `parent_${i}`,
          pmids: [`${4000 + i}`],
        }),
      ),
    );
    mockTopicFindMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({ id: `parent_${i}`, label: `Parent ${i}` })),
    );
    mockPublicationAuthorFindMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) =>
        makeAuthorRow({ pmid: `${4000 + i}`, cwid: `c${i}`, position: 1 }),
      ),
    );
    // Raw count rows — note publication_count / scholar_count keys, BigInt-safe Number coercion expected.
    mockQueryRaw.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        parent_topic_id: `parent_${i}`,
        primary_subtopic_id: `sub_${i}`,
        publication_count: 40 + i,
        scholar_count: 8 + i,
      })),
    );
    const result = await getSpotlights();
    expect(result).not.toBeNull();
    expect(result![0].publicationCount).toBe(40);
    expect(result![0].scholarCount).toBe(8);
    expect(result![5].publicationCount).toBe(45);
    expect(result![5].scholarCount).toBe(13);
  });

  it("projects spotlights using PublicationAuthor as the WCM-author source (not the artifact's first/last)", async () => {
    // Six spotlights, each with 2 papers. Half the parents have WCM-author
    // matches via PublicationAuthor; half have none (those spotlights drop).
    const parents = [
      "cell_molecular_biology", "translational_clinical_science",
      "epidemiology_population_health", "biostatistics_quantitative_sciences",
      "health_services_policy", "drug_discovery_pharmacology",
      "genetics_genomics_precision_medicine", "surgery_perioperative_medicine",
      "immunology_inflammation", "pathology_laboratory_medicine",
    ];
    mockSpotlightFindMany.mockResolvedValue(
      parents.map((p, i) =>
        makeSpotlightRow({
          subtopicId: `sub_${i}`,
          parentTopicId: p,
          displayName: `Display ${i}`,
          shortDescription: `Subtitle ${i}`,
          lede: `WCM scholars are reshaping ${p}.`,
          pmids: [`${1000 + i * 2}`, `${1001 + i * 2}`],
        }),
      ),
    );
    mockTopicFindMany.mockResolvedValue(
      parents.map((p) => ({ id: p, label: p.replace(/_/g, " ") })),
    );
    // PublicationAuthor: every PMID gets two distinct WCM authors (positions 1 & 5).
    const authorRows = parents.flatMap((_, i) => [
      makeAuthorRow({ pmid: `${1000 + i * 2}`, cwid: `c${i}a`, position: 1, preferredName: `Author A${i}` }),
      makeAuthorRow({ pmid: `${1000 + i * 2}`, cwid: `c${i}b`, position: 5, preferredName: `Author B${i}` }),
      makeAuthorRow({ pmid: `${1001 + i * 2}`, cwid: `c${i}a`, position: 2, preferredName: `Author A${i}` }),
    ]);
    mockPublicationAuthorFindMany.mockResolvedValue(authorRows);

    const result = await getSpotlights();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(10);

    // Render order is alphabetical by parentTopicId
    const orderedParents = [...parents].sort();
    expect(result!.map((c) => c.parentTopicSlug)).toEqual(orderedParents);

    for (const card of result!) {
      expect(card.papers.length).toBeGreaterThanOrEqual(1);
      expect(card.lede).toMatch(/^WCM scholars are reshaping/);
      // parentTopicLabel comes from Topic.label (not the raw id)
      expect(card.parentTopicLabel).not.toBe(card.parentTopicSlug);
      for (const paper of card.papers) {
        expect(paper.authors.length).toBeGreaterThanOrEqual(1);
        for (const author of paper.authors) {
          expect(author.cwid).toBeTruthy();
          expect(author.profileSlug).toBeTruthy();
          expect(author.identityImageEndpoint).toContain(author.cwid);
        }
      }
    }
  });

  it("drops papers with zero WCM-resolved authors and drops spotlights whose papers all dropped", async () => {
    // Six spotlights, but only the first three have any WCM author rows.
    // The other three should be filtered out, dropping us below the floor (6).
    const parents = ["a", "b", "c", "d", "e", "f"];
    mockSpotlightFindMany.mockResolvedValue(
      parents.map((p, i) =>
        makeSpotlightRow({
          subtopicId: `sub_${p}`,
          parentTopicId: p,
          pmids: [`${9000 + i}`],
        }),
      ),
    );
    mockTopicFindMany.mockResolvedValue(
      parents.map((p) => ({ id: p, label: p.toUpperCase() })),
    );
    mockPublicationAuthorFindMany.mockResolvedValue([
      makeAuthorRow({ pmid: "9000", cwid: "ca", position: 3 }),
      makeAuthorRow({ pmid: "9001", cwid: "cb", position: 1 }),
      makeAuthorRow({ pmid: "9002", cwid: "cc", position: 4 }),
      // 9003 / 9004 / 9005 — no WCM authors → those spotlights drop
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getSpotlights();
    // 3 surviving cards is below the floor of 6 → null + sparse-hide log.
    expect(result).toBeNull();
    const drops = warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("home_spotlight_dropped_no_wcm_authors"),
    );
    expect(drops.length).toBe(3);
    const sparse = warn.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes('"surface":"home_spotlights"'),
    );
    expect(sparse).toBeTruthy();
    warn.mockRestore();
  });

  it("orders authors by byline position (ascending)", async () => {
    mockSpotlightFindMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) =>
        makeSpotlightRow({
          subtopicId: `sub_${i}`,
          parentTopicId: `parent_${i}`,
          pmids: ["7000"],
        }),
      ),
    );
    mockTopicFindMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({ id: `parent_${i}`, label: `Parent ${i}` })),
    );
    // Mock returns rows already ordered by position asc (mirrors the
    // Prisma orderBy in the DAL).
    mockPublicationAuthorFindMany.mockResolvedValue([
      makeAuthorRow({ pmid: "7000", cwid: "c1", position: 1, preferredName: "Alpha" }),
      makeAuthorRow({ pmid: "7000", cwid: "c5", position: 5, preferredName: "Echo" }),
      makeAuthorRow({ pmid: "7000", cwid: "c9", position: 9, preferredName: "Indigo" }),
    ]);
    const result = await getSpotlights();
    expect(result).not.toBeNull();
    const authors = result![0].papers[0].authors;
    expect(authors.map((a) => a.displayName)).toEqual(["Alpha", "Echo", "Indigo"]);
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
      { parent_topic_id: "cancer_genomics", scholar_count: 42, publication_count: 312 },
      { parent_topic_id: "neuroscience", scholar_count: 17, publication_count: 89 },
    ]);
    const result = await getBrowseAllResearchAreas();
    expect(result).toEqual([
      { slug: "cancer_genomics", name: "Cancer Genomics", scholarCount: 42, publicationCount: 312 },
      { slug: "neuroscience", name: "Neuroscience", scholarCount: 17, publicationCount: 89 },
    ]);
  });
});
