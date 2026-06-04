/**
 * `assembleOverviewFacts` + `hasSufficientFacts` (#742). The DB is mocked — no
 * network, no real DB. Asserts the facts payload is assembled and ordered the
 * way the contract specifies (distinct-pmid topic rank, impact-sorted pubs,
 * active-grant mapping, plain-text existingBio, sufficiency threshold).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFindUnique,
  mockPubAuthorFindMany,
  mockPublicationFindMany,
  mockPublicationAggregate,
  mockPubTopicFindMany,
  mockTopicFindMany,
  mockGrantFindMany,
  mockEducationFindMany,
} = vi.hoisted(() => ({
  mockScholarFindUnique: vi.fn(),
  mockPubAuthorFindMany: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockPublicationAggregate: vi.fn(),
  mockPubTopicFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockEducationFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: mockScholarFindUnique },
      publicationAuthor: { findMany: mockPubAuthorFindMany },
      publication: { findMany: mockPublicationFindMany, aggregate: mockPublicationAggregate },
      publicationTopic: { findMany: mockPubTopicFindMany },
      topic: { findMany: mockTopicFindMany },
      grant: { findMany: mockGrantFindMany },
      education: { findMany: mockEducationFindMany },
    },
  },
}));

import {
  assembleOverviewFacts,
  hasSufficientFacts,
  type OverviewFacts,
} from "@/lib/edit/overview-facts";

/** A Prisma Decimal-like object (`.toNumber()`), as impactScore arrives. */
function decimal(n: number) {
  return { toNumber: () => n };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScholarFindUnique.mockResolvedValue({
    preferredName: "Jane Smith",
    primaryTitle: "Associate Professor of Medicine",
    primaryDepartment: "Medicine",
    overview: null,
  });
  mockPubAuthorFindMany.mockResolvedValue([]);
  mockPublicationFindMany.mockResolvedValue([]);
  mockPublicationAggregate.mockResolvedValue({ _min: { year: null }, _max: { year: null } });
  mockPubTopicFindMany.mockResolvedValue([]);
  mockTopicFindMany.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  mockEducationFindMany.mockResolvedValue([]);
});

describe("assembleOverviewFacts", () => {
  it("returns null when the scholar row is missing", async () => {
    mockScholarFindUnique.mockResolvedValue(null);
    expect(await assembleOverviewFacts("ghost1")).toBeNull();
  });

  it("maps identity fields verbatim from the scholar row", async () => {
    const facts = await assembleOverviewFacts("self01");
    expect(facts).not.toBeNull();
    expect(facts).toMatchObject({
      name: "Jane Smith",
      title: "Associate Professor of Medicine",
      department: "Medicine",
    });
  });

  it("counts DISTINCT confirmed-authorship pmids", async () => {
    mockPubAuthorFindMany.mockResolvedValue([
      { pmid: "1" },
      { pmid: "1" }, // duplicate (e.g. two author positions) must not double-count
      { pmid: "2" },
    ]);
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.publicationCount).toBe(2);
  });

  it("shapes representative publications and excerpts the abstract", async () => {
    mockPubAuthorFindMany.mockResolvedValue([{ pmid: "1" }]);
    mockPublicationFindMany.mockResolvedValue([
      {
        title: "A worldwide atlas of urban metagenomes",
        journal: "Cell",
        year: 2021,
        impactScore: decimal(92.5),
        abstract: "x".repeat(600),
        impactJustification: "broad influence",
        synopsis: "urban microbiome atlas",
      },
    ]);
    const facts = await assembleOverviewFacts("self01");
    const pub = facts!.representativePublications[0];
    expect(pub).toMatchObject({
      title: "A worldwide atlas of urban metagenomes",
      venue: "Cell",
      year: 2021,
      impact: 92.5,
      impactJustification: "broad influence",
      synopsis: "urban microbiome atlas",
    });
    expect(pub.abstractExcerpt).toHaveLength(400);
  });

  it("computes yearsActive from the publication aggregate", async () => {
    mockPubAuthorFindMany.mockResolvedValue([{ pmid: "1" }]);
    mockPublicationAggregate.mockResolvedValue({ _min: { year: 2008 }, _max: { year: 2024 } });
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.yearsActive).toEqual({ first: 2008, last: 2024 });
  });

  it("ranks topics by distinct-pmid count and resolves the label + a rationale", async () => {
    mockPubTopicFindMany.mockResolvedValue([
      // cancer_genomics: 2 distinct pmids
      { parentTopicId: "cancer_genomics", pmid: "p1", rationale: null },
      { parentTopicId: "cancer_genomics", pmid: "p2", rationale: "maps via tumor sequencing" },
      // immunology: 1 distinct pmid
      { parentTopicId: "immunology", pmid: "p3", rationale: "T-cell work" },
    ]);
    mockTopicFindMany.mockResolvedValue([
      { id: "cancer_genomics", label: "Cancer Genomics" },
      { id: "immunology", label: "Immunology" },
    ]);
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.topics).toEqual([
      { label: "Cancer Genomics", rationale: "maps via tumor sequencing" },
      { label: "Immunology", rationale: "T-cell work" },
    ]);
  });

  it("drops a topic id that has no catalog label (never surfaces a raw slug)", async () => {
    mockPubTopicFindMany.mockResolvedValue([
      { parentTopicId: "orphan_slug", pmid: "p1", rationale: "x" },
    ]);
    mockTopicFindMany.mockResolvedValue([]); // no label row
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.topics).toEqual([]);
  });

  it("maps active grants to {role, funderLabel, mechanism}", async () => {
    mockGrantFindMany.mockResolvedValue([
      { role: "PI", funder: "NIH/NIGMS", mechanism: "R01" },
      { role: "Co-I", funder: "NIH/NHGRI", mechanism: null },
    ]);
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.activeGrants).toEqual([
      { role: "PI", funderLabel: "NIH/NIGMS", mechanism: "R01" },
      { role: "Co-I", funderLabel: "NIH/NHGRI", mechanism: null },
    ]);
    // active = endDate >= today
    expect(mockGrantFindMany.mock.calls[0][0].where).toMatchObject({ cwid: "self01" });
    expect(mockGrantFindMany.mock.calls[0][0].where.endDate).toHaveProperty("gte");
  });

  it("passes education through, preserving a null field (never invents one)", async () => {
    mockEducationFindMany.mockResolvedValue([
      { degree: "Ph.D.", institution: "Simon Fraser University", field: null, year: 2012 },
    ]);
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.education).toEqual([
      { degree: "Ph.D.", institution: "Simon Fraser University", field: null, year: 2012 },
    ]);
  });

  it("derives existingBio as plain text from the overview HTML, source 'vivo'", async () => {
    mockScholarFindUnique.mockResolvedValue({
      preferredName: "Jane Smith",
      primaryTitle: "Professor",
      primaryDepartment: "Medicine",
      overview: "<p>Studies <strong>genomics</strong> &amp; precision medicine.</p>",
    });
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.existingBio).toEqual({
      text: "Studies genomics & precision medicine.",
      source: "vivo",
    });
  });

  it("leaves existingBio null when the overview is empty", async () => {
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.existingBio).toBeNull();
  });
});

describe("hasSufficientFacts", () => {
  const empty: OverviewFacts = {
    name: "Jane Smith",
    title: null,
    department: null,
    topics: [],
    representativePublications: [],
    publicationCount: 0,
    yearsActive: { first: null, last: null },
    activeGrants: [],
    education: [],
    existingBio: null,
  };

  it("is false for a sparse payload (no pubs, no grants, <2 topics)", () => {
    expect(hasSufficientFacts(empty)).toBe(false);
    expect(hasSufficientFacts({ ...empty, topics: [{ label: "One", rationale: null }] })).toBe(
      false,
    );
  });

  it("is true with at least one representative publication", () => {
    expect(
      hasSufficientFacts({
        ...empty,
        representativePublications: [
          {
            title: "t",
            venue: null,
            year: null,
            impact: null,
            abstractExcerpt: null,
            impactJustification: null,
            synopsis: null,
          },
        ],
      }),
    ).toBe(true);
  });

  it("is true with at least one active grant", () => {
    expect(
      hasSufficientFacts({
        ...empty,
        activeGrants: [{ role: "PI", funderLabel: "NIH", mechanism: "R01" }],
      }),
    ).toBe(true);
  });

  it("is true with two or more topics", () => {
    expect(
      hasSufficientFacts({
        ...empty,
        topics: [
          { label: "One", rationale: null },
          { label: "Two", rationale: null },
        ],
      }),
    ).toBe(true);
  });
});
