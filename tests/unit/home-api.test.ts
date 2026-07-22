/**
 * Unit tests for lib/api/home.ts — three pure data-fetcher functions for the
 * Phase 2 home page composition (Recent contributions, Selected research,
 * Browse all research areas).
 *
 * Schema shape: candidate (e) per 02-SCHEMA-DECISION.md. The mocks use the
 * `publicationTopic` Prisma model (composite PK on pmid+cwid+parentTopicId,
 * embedded subtopic JSON, no first-class subtopic table). The `topic` table
 * contains 68 rows — ALL parents — with no `parentId` column.
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
  suppressionFindMany: vi.fn().mockResolvedValue([]),
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
    suppression: {
      findMany: mocks.suppressionFindMany,
    },
    $queryRaw: mocks.queryRaw,
    $queryRawUnsafe: mocks.queryRaw,
  },
}));

// getHomeMethodCategories imports getSupercategoryHubEntries (which hits
// prisma.scholarFamily.groupBy + overlay/topics modules NOT in the @/lib/db
// mock) and the methods-lens page flag. Mock both directly so the test exercises
// only the loader's mapping logic, never the real taxonomy query path.
const methodMocks = vi.hoisted(() => ({
  getSupercategoryHubEntries: vi.fn(),
  isMethodPagesEnabled: vi.fn(),
}));
vi.mock("@/lib/api/methods", () => ({
  getSupercategoryHubEntries: methodMocks.getSupercategoryHubEntries,
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodPagesEnabled: methodMocks.isMethodPagesEnabled,
}));

import {
  getSpotlights,
  getBrowseAllResearchAreas,
  getHomeMethodCategories,
} from "@/lib/api/home";

const NOW = new Date("2026-04-01");

beforeEach(() => {
  mockPubTopicFindMany.mockReset();
  mockPubTopicGroupBy.mockReset();
  mockTopicFindMany.mockReset();
  mockPublicationFindMany.mockReset();
  mockSpotlightFindMany.mockReset();
  mockScholarFindMany.mockReset();
  mockPublicationAuthorFindMany.mockReset();
  mockQueryRaw.mockReset();
  methodMocks.getSupercategoryHubEntries.mockReset();
  methodMocks.isMethodPagesEnabled.mockReset();
  // Default the page flag on so most cases exercise the happy path.
  methodMocks.isMethodPagesEnabled.mockReturnValue(true);
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

  it("seeded-samples a 7-paper artifact pool down to 3, deterministically (#286)", async () => {
    // Six spotlights so the floor (6) is met. The first ships a 7-paper pool;
    // getSpotlights() must seeded-sample it to exactly 3. The other five ship
    // a single paper and pass through the sampler untouched.
    const bigPmids = Array.from({ length: 7 }, (_, i) => `${8001 + i}`);
    const smallPmids = Array.from({ length: 5 }, (_, i) => `${9001 + i}`);
    mockSpotlightFindMany.mockResolvedValue([
      makeSpotlightRow({
        subtopicId: "sub_big",
        parentTopicId: "parent_0",
        pmids: bigPmids,
      }),
      ...smallPmids.map((pmid, i) =>
        makeSpotlightRow({
          subtopicId: `sub_${i + 1}`,
          parentTopicId: `parent_${i + 1}`,
          pmids: [pmid],
        }),
      ),
    ]);
    mockTopicFindMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({ id: `parent_${i}`, label: `Parent ${i}` })),
    );
    // One distinct WCM author per pmid — nothing drops, no author collisions.
    mockPublicationAuthorFindMany.mockResolvedValue(
      [...bigPmids, ...smallPmids].map((pmid, i) =>
        makeAuthorRow({ pmid, cwid: `cw${i}`, position: 1 }),
      ),
    );

    const first = await getSpotlights();
    expect(first).not.toBeNull();
    const bigCard = first!.find((card) => card.subtopicId === "sub_big")!;
    // 7-paper pool sampled down to exactly 3, each drawn from the pool.
    expect(bigCard.papers).toHaveLength(3);
    expect(new Set(bigCard.papers.map((p) => p.pmid)).size).toBe(3);
    for (const p of bigCard.papers) expect(bigPmids).toContain(p.pmid);
    // #343 — the publish-cycle ID is surfaced on the card so Spotlight
    // paper-click telemetry can attribute CTR per cycle.
    expect(bigCard.artifactVersion).toBe("v2026-05-07");
    // Pools of 3 or fewer pass through untouched.
    for (const card of first!.filter((c) => c.subtopicId !== "sub_big")) {
      expect(card.papers).toHaveLength(1);
    }

    // Deterministic: a second call yields the identical sampled triple.
    const second = await getSpotlights();
    const bigCard2 = second!.find((card) => card.subtopicId === "sub_big")!;
    expect(bigCard2.papers.map((p) => p.pmid)).toEqual(
      bigCard.papers.map((p) => p.pmid),
    );
  });
});

describe("getBrowseAllResearchAreas (HOME-03)", () => {
  it("returns 68 parent topic rows from Topic table (under (e), every Topic row is a parent)", async () => {
    mockTopicFindMany.mockResolvedValue(
      Array.from({ length: 68 }, (_, i) => ({
        id: `topic_${i}`,
        label: `Topic ${i}`,
        description: null,
      })),
    );
    mockQueryRaw.mockResolvedValue(
      Array.from({ length: 68 }, (_, i) => ({
        parent_topic_id: `topic_${i}`,
        scholar_count: 100 + i,
      })),
    );
    const result = await getBrowseAllResearchAreas();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(68);
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

describe("getHomeMethodCategories (home Browse by research method)", () => {
  // Builds a SupercategoryHubEntry-shaped fixture. `slug` mirrors the real
  // loader (`id` with underscores → hyphens); `familyCount` derives from the
  // families array. `families` order is intentionally arbitrary so the
  // representative-family sort is exercised.
  function makeHubEntry(over: {
    id: string;
    label: string;
    families: Array<{ familyId: string; familyLabel: string; scholarCount: number }>;
  }) {
    return {
      id: over.id,
      slug: over.id.replace(/_/g, "-"),
      label: over.label,
      description: "desc",
      familyCount: over.families.length,
      families: over.families,
    };
  }

  it("returns null when the page flag is off (and never queries the taxonomy)", async () => {
    methodMocks.isMethodPagesEnabled.mockReturnValue(false);
    const result = await getHomeMethodCategories();
    expect(result).toBeNull();
    expect(methodMocks.getSupercategoryHubEntries).not.toHaveBeenCalled();
  });

  it("returns null when the taxonomy is empty", async () => {
    methodMocks.getSupercategoryHubEntries.mockResolvedValue([]);
    const result = await getHomeMethodCategories();
    expect(result).toBeNull();
  });

  it("sorts categories alphabetically by label", async () => {
    methodMocks.getSupercategoryHubEntries.mockResolvedValue([
      makeHubEntry({
        id: "zebrafish_models",
        label: "Zebrafish models",
        families: [{ familyId: "f1", familyLabel: "Larval imaging", scholarCount: 3 }],
      }),
      makeHubEntry({
        id: "animal_cell_models",
        label: "Animal & Cell Models",
        families: [{ familyId: "f2", familyLabel: "Mouse models", scholarCount: 5 }],
      }),
      makeHubEntry({
        id: "genomics_sequencing",
        label: "Genomics & Sequencing",
        families: [{ familyId: "f3", familyLabel: "WGS", scholarCount: 4 }],
      }),
    ]);
    const result = await getHomeMethodCategories();
    expect(result).not.toBeNull();
    expect(result!.categories.map((c) => c.label)).toEqual([
      "Animal & Cell Models",
      "Genomics & Sequencing",
      "Zebrafish models",
    ]);
  });

  it("computes categoryCount and totalFamilyCount from the taxonomy", async () => {
    methodMocks.getSupercategoryHubEntries.mockResolvedValue([
      makeHubEntry({
        id: "a_cat",
        label: "A cat",
        families: [
          { familyId: "f1", familyLabel: "One", scholarCount: 1 },
          { familyId: "f2", familyLabel: "Two", scholarCount: 2 },
        ],
      }),
      makeHubEntry({
        id: "b_cat",
        label: "B cat",
        families: [{ familyId: "f3", familyLabel: "Three", scholarCount: 3 }],
      }),
    ]);
    const result = await getHomeMethodCategories();
    expect(result!.categoryCount).toBe(2);
    expect(result!.totalFamilyCount).toBe(3);
    expect(result!.categories.find((c) => c.label === "A cat")!.familyCount).toBe(2);
  });

  it("emits up to 3 representative families, top-by-scholarCount desc", async () => {
    methodMocks.getSupercategoryHubEntries.mockResolvedValue([
      makeHubEntry({
        id: "genomics_sequencing",
        label: "Genomics & Sequencing",
        families: [
          { familyId: "f1", familyLabel: "Low", scholarCount: 1 },
          { familyId: "f2", familyLabel: "Top", scholarCount: 50 },
          { familyId: "f3", familyLabel: "Mid", scholarCount: 20 },
          { familyId: "f4", familyLabel: "High", scholarCount: 40 },
          { familyId: "f5", familyLabel: "Bottom", scholarCount: 2 },
        ],
      }),
    ]);
    const result = await getHomeMethodCategories();
    const rep = result!.categories[0].representativeFamilies;
    expect(rep).toEqual(["Top", "High", "Mid"]);
    expect(rep.length).toBeLessThanOrEqual(3);
  });

  it("excludes generic catch-all (General*) families from the scent line", async () => {
    methodMocks.getSupercategoryHubEntries.mockResolvedValue([
      makeHubEntry({
        id: "molecular_reagents",
        label: "Molecular reagents",
        families: [
          { familyId: "f1", familyLabel: "General molecular biology methods", scholarCount: 99 },
          { familyId: "f2", familyLabel: "CRISPR screens", scholarCount: 30 },
          { familyId: "f3", familyLabel: "Western blotting", scholarCount: 20 },
        ],
      }),
    ]);
    const result = await getHomeMethodCategories();
    const rep = result!.categories[0].representativeFamilies;
    expect(rep).not.toContain("General molecular biology methods");
    expect(rep).toEqual(["CRISPR screens", "Western blotting"]);
  });

  it("yields an empty scent line when every family is generic", async () => {
    methodMocks.getSupercategoryHubEntries.mockResolvedValue([
      makeHubEntry({
        id: "misc",
        label: "Miscellaneous",
        families: [
          { familyId: "f1", familyLabel: "General methods", scholarCount: 10 },
          { familyId: "f2", familyLabel: "General assays", scholarCount: 5 },
        ],
      }),
    ]);
    const result = await getHomeMethodCategories();
    expect(result!.categories[0].representativeFamilies).toEqual([]);
  });
});
