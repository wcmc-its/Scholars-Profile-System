/**
 * `assembleOverviewFacts` + `loadOverviewSourceOptions` + `hasSufficientFacts`
 * (#742 v3.1). The DB is mocked — no network, no real DB. Asserts the facts
 * payload is assembled distilled-first (synopsis / justification / rationale, NO
 * raw abstract), grounded on the chosen selection (or the first/last-author
 * scored default), and that the Sources options carry the matching
 * `defaultSelected` flags.
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
  mockScholarFamilyFindMany,
  mockFamilySuppressionFindMany,
} = vi.hoisted(() => ({
  mockScholarFindUnique: vi.fn(),
  mockPubAuthorFindMany: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockPublicationAggregate: vi.fn(),
  mockPubTopicFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockEducationFindMany: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockFamilySuppressionFindMany: vi.fn(),
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
      // #886 — the generator's Methods bucket reads the live `scholar_family`
      // rollup (#799), #800-suppression applied.
      scholarFamily: { findMany: mockScholarFamilyFindMany },
      familySuppressionOverlay: { findMany: mockFamilySuppressionFindMany },
    },
  },
}));

import {
  assembleOverviewFacts,
  hasSufficientFacts,
  loadOverviewSourceOptions,
  type OverviewFacts,
} from "@/lib/edit/overview-facts";

/** A Prisma Decimal-like object (`.toNumber()`), as impactScore arrives. */
function decimal(n: number) {
  return { toNumber: () => n };
}

/** A scored publication row as `publication.findMany` returns it. */
function pubRow(
  pmid: string,
  opts: Partial<{
    title: string;
    journal: string | null;
    year: number | null;
    impact: number;
    synopsis: string | null;
    impactJustification: string | null;
  }> = {},
) {
  return {
    pmid,
    title: opts.title ?? `Title ${pmid}`,
    journal: opts.journal ?? "Cell",
    year: opts.year ?? 2024,
    impactScore: decimal(opts.impact ?? 80),
    synopsis: opts.synopsis ?? `synopsis ${pmid}`,
    impactJustification: opts.impactJustification ?? `justification ${pmid}`,
  };
}

/** A grant row as `grant.findMany` returns it. */
function grantRow(
  id: string,
  role: string,
  opts: Partial<{
    funder: string;
    title: string;
    mechanism: string | null;
    awardNumber: string | null;
    endYear: number;
  }> = {},
) {
  return {
    id,
    role,
    funder: opts.funder ?? "NIH/NIGMS",
    title: opts.title ?? `Project ${id}`,
    // `=== undefined` (not `??`) so an explicit null passes through as null.
    mechanism: opts.mechanism === undefined ? "R01" : opts.mechanism,
    awardNumber: opts.awardNumber === undefined ? `R01 ${id}` : opts.awardNumber,
    endDate: new Date(Date.UTC(opts.endYear ?? 2027, 0, 1)),
  };
}

/** The scholar row shape `findUnique` returns (metrics null unless overridden). */
function scholarRow(over: Record<string, unknown> = {}) {
  return {
    preferredName: "Jane Smith",
    primaryTitle: "Associate Professor of Medicine",
    primaryDepartment: "Medicine",
    overview: null,
    hIndex: null,
    firstAuthorCount: null,
    lastAuthorCount: null,
    scoredPubCount: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScholarFindUnique.mockResolvedValue(scholarRow());
  mockPubAuthorFindMany.mockResolvedValue([]);
  mockPublicationFindMany.mockResolvedValue([]);
  mockPublicationAggregate.mockResolvedValue({ _min: { year: null }, _max: { year: null } });
  mockPubTopicFindMany.mockResolvedValue([]);
  mockTopicFindMany.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  mockEducationFindMany.mockResolvedValue([]);
  mockScholarFamilyFindMany.mockResolvedValue([]);
  mockFamilySuppressionFindMany.mockResolvedValue([]);
});

/** A `scholar_family.findMany` row, as the #799 rollup returns it. */
function familyRow(
  familyLabel: string,
  supercategory: string,
  pmidCount: number,
  exemplarTools: string[] = [],
) {
  return {
    familyId: `fam_${familyLabel.replace(/\s+/g, "_")}`,
    familyLabel,
    supercategory,
    pmidCount,
    exemplarTools,
  };
}

describe("assembleOverviewFacts — identity & corpus", () => {
  it("returns null when the scholar row is missing", async () => {
    mockScholarFindUnique.mockResolvedValue(null);
    expect(await assembleOverviewFacts("ghost1")).toBeNull();
  });

  it("maps identity fields verbatim from the scholar row", async () => {
    const facts = await assembleOverviewFacts("self01");
    expect(facts).toMatchObject({
      name: "Jane Smith",
      title: "Associate Professor of Medicine",
      department: "Medicine",
    });
  });

  it("counts DISTINCT confirmed-authorship pmids", async () => {
    mockPubAuthorFindMany.mockResolvedValue([
      { pmid: "1", isFirst: true, isLast: false },
      { pmid: "1", isFirst: true, isLast: false }, // duplicate must not double-count
      { pmid: "2", isFirst: false, isLast: true },
    ]);
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.publicationCount).toBe(2);
  });

  it("computes yearsActive from the publication aggregate", async () => {
    mockPubAuthorFindMany.mockResolvedValue([{ pmid: "1", isFirst: true, isLast: false }]);
    mockPublicationAggregate.mockResolvedValue({ _min: { year: 2008 }, _max: { year: 2024 } });
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.yearsActive).toEqual({ first: 2008, last: 2024 });
  });

  it("degrades the C3 fields gracefully (methods [], facultyMetrics null)", async () => {
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.methods).toEqual([]);
    expect(facts?.facultyMetrics).toBeNull();
  });
});

describe("assembleOverviewFacts — representative publications (distilled, selection-driven)", () => {
  it("defaults to first/last-author scored pubs with distilled fields (NO abstract) + rationale", async () => {
    mockPubAuthorFindMany.mockResolvedValue([{ pmid: "1", isFirst: true, isLast: false }]);
    mockPublicationFindMany.mockResolvedValue([
      pubRow("1", {
        title: "A worldwide atlas of urban metagenomes",
        journal: "Cell",
        year: 2021,
        impact: 92.5,
        synopsis: "urban microbiome atlas",
        impactJustification: "broad influence",
      }),
    ]);
    mockPubTopicFindMany.mockResolvedValue([
      { parentTopicId: "t1", pmid: "1", rationale: "maps via metagenomic sequencing", score: 0.9 },
    ]);
    const facts = await assembleOverviewFacts("self01");
    const pub = facts!.representativePublications[0];
    expect(pub).toEqual({
      pmid: "1",
      title: "A worldwide atlas of urban metagenomes",
      venue: "Cell",
      year: 2021,
      impact: 92.5,
      synopsis: "urban microbiome atlas",
      impactJustification: "broad influence",
      topicRationale: "maps via metagenomic sequencing",
      authorPosition: "first",
    });
    // The raw abstract is gone (decision 4).
    expect(pub).not.toHaveProperty("abstractExcerpt");
  });

  it("does NOT default-select a middle-author scored pub", async () => {
    mockPubAuthorFindMany.mockResolvedValue([{ pmid: "9", isFirst: false, isLast: false }]);
    mockPublicationFindMany.mockResolvedValue([pubRow("9")]);
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.representativePublications).toEqual([]);
  });

  it("features exactly the explicitly-selected pmids (incl. a middle-author pub)", async () => {
    mockPubAuthorFindMany.mockResolvedValue([
      { pmid: "1", isFirst: true, isLast: false },
      { pmid: "9", isFirst: false, isLast: false }, // middle author
    ]);
    mockPublicationFindMany.mockResolvedValue([
      pubRow("1", { impact: 90 }),
      pubRow("9", { impact: 50 }),
    ]);
    const facts = await assembleOverviewFacts("self01", {
      pmids: ["9"],
      grantIds: [],
      toolNames: [],
    });
    expect(facts?.representativePublications.map((p) => p.pmid)).toEqual(["9"]);
  });

  it("drops a forged/foreign pmid (ownership filter — matches no candidate)", async () => {
    mockPubAuthorFindMany.mockResolvedValue([{ pmid: "1", isFirst: true, isLast: false }]);
    mockPublicationFindMany.mockResolvedValue([pubRow("1")]);
    const facts = await assembleOverviewFacts("self01", {
      pmids: ["1", "evil999"],
      grantIds: [],
      toolNames: [],
    });
    expect(facts?.representativePublications.map((p) => p.pmid)).toEqual(["1"]);
  });
});

describe("assembleOverviewFacts — funding (selection-driven)", () => {
  it("defaults to lead-role (PI/Co-PI) active awards, shaped {role,funderLabel,title,mechanism}", async () => {
    mockGrantFindMany.mockResolvedValue([
      grantRow("g1", "PI", { funder: "NIH/NIGMS", title: "Gene therapy", mechanism: "R01" }),
      grantRow("g2", "Co-I", { funder: "NIH/NHGRI", title: "Side project", mechanism: null }),
    ]);
    const facts = await assembleOverviewFacts("self01");
    // Co-I is a candidate but NOT a default pick — only the lead role.
    expect(facts?.activeGrants).toEqual([
      { role: "PI", funderLabel: "NIH/NIGMS", title: "Gene therapy", mechanism: "R01" },
    ]);
    expect(mockGrantFindMany.mock.calls[0][0].where).toMatchObject({ cwid: "self01" });
    expect(mockGrantFindMany.mock.calls[0][0].where.endDate).toHaveProperty("gte");
  });

  it("includes a non-lead award when it is explicitly selected", async () => {
    mockGrantFindMany.mockResolvedValue([
      grantRow("g1", "PI"),
      grantRow("g2", "Co-I", { funder: "NSF" }),
    ]);
    const facts = await assembleOverviewFacts("self01", {
      pmids: [],
      grantIds: ["g2"],
      toolNames: [],
    });
    expect(facts?.activeGrants.map((g) => g.role)).toEqual(["Co-I"]);
  });
});

describe("assembleOverviewFacts — topics", () => {
  it("ranks topics by distinct-pmid count and resolves the label + a rationale", async () => {
    mockPubTopicFindMany.mockResolvedValue([
      { parentTopicId: "cancer_genomics", pmid: "p1", rationale: null, score: 0.5 },
      {
        parentTopicId: "cancer_genomics",
        pmid: "p2",
        rationale: "maps via tumor sequencing",
        score: 0.8,
      },
      { parentTopicId: "immunology", pmid: "p3", rationale: "T-cell work", score: 0.7 },
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
      { parentTopicId: "orphan_slug", pmid: "p1", rationale: "x", score: 0.5 },
    ]);
    mockTopicFindMany.mockResolvedValue([]);
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.topics).toEqual([]);
  });
});

describe("assembleOverviewFacts — education & existingBio", () => {
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
    mockScholarFindUnique.mockResolvedValue(
      scholarRow({
        primaryTitle: "Professor",
        overview: "<p>Studies <strong>genomics</strong> &amp; precision medicine.</p>",
      }),
    );
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

describe("loadOverviewSourceOptions", () => {
  it("returns candidate pubs + funding with matching defaultSelected flags; tools []", async () => {
    mockPubAuthorFindMany.mockResolvedValue([
      { pmid: "1", isFirst: true, isLast: false }, // first author → default
      { pmid: "2", isFirst: false, isLast: false }, // middle → candidate, not default
    ]);
    mockPublicationFindMany.mockResolvedValue([
      pubRow("1", { title: "P1", journal: "Cell", year: 2024, impact: 90 }),
      pubRow("2", { title: "P2", journal: "Nature", year: 2022, impact: 70 }),
    ]);
    mockGrantFindMany.mockResolvedValue([
      grantRow("g1", "PI", { funder: "NIH", title: "Proj 1", awardNumber: "R01 X", endYear: 2027 }),
      grantRow("g2", "Co-I", {
        funder: "NSF",
        title: "Proj 2",
        awardNumber: null,
        mechanism: null,
        endYear: 2026,
      }),
    ]);

    const opts = await loadOverviewSourceOptions("self01");

    expect(opts.publications).toEqual([
      {
        pmid: "1",
        title: "P1",
        venue: "Cell",
        year: 2024,
        impact: 90,
        isFirstOrLast: true,
        authorPosition: "first",
        defaultSelected: true,
      },
      {
        pmid: "2",
        title: "P2",
        venue: "Nature",
        year: 2022,
        impact: 70,
        isFirstOrLast: false,
        authorPosition: "middle",
        defaultSelected: false,
      },
    ]);
    expect(opts.funding).toEqual([
      {
        id: "g1",
        role: "PI",
        funder: "NIH",
        title: "Proj 1",
        award: "R01 X",
        endYear: 2027,
        defaultSelected: true,
      },
      {
        id: "g2",
        role: "Co-I",
        funder: "NSF",
        title: "Proj 2",
        award: null,
        endYear: 2026,
        defaultSelected: false,
      },
    ]);
    expect(opts.tools).toEqual([]);
  });
});

describe("assembleOverviewFacts — methods (scholar_family) & faculty metrics", () => {
  // #886 — methods are the scholar's #799 `scholar_family` rollup, mapped into
  // the tool-bucket shape: familyLabel → toolName, supercategory → category,
  // exemplarTools → examples, and a constant maxConfidence of 1.
  const FAMILIES = [
    familyRow("AAV vectors", "vector platform", 28, ["AAV2", "AAV9"]),
    familyRow("PET imaging", "imaging", 12, ["[18F]FDG"]),
  ];

  it("defaults to the scholar's top families, shaped methods as {name, category, examples}", async () => {
    mockScholarFamilyFindMany.mockResolvedValue(FAMILIES);
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.methods).toEqual([
      { name: "AAV vectors", category: "vector platform", examples: ["AAV2", "AAV9"] },
      { name: "PET imaging", category: "imaging", examples: ["[18F]FDG"] },
    ]);
  });

  it("features only explicitly-selected families; drops a foreign family label", async () => {
    mockScholarFamilyFindMany.mockResolvedValue(FAMILIES);
    const facts = await assembleOverviewFacts("self01", {
      pmids: [],
      grantIds: [],
      toolNames: ["PET imaging", "evil-tool"],
    });
    expect(facts?.methods).toEqual([
      { name: "PET imaging", category: "imaging", examples: ["[18F]FDG"] },
    ]);
  });

  // #800 — a curator-suppressed (generic) family is excluded from the generator
  // grounding too, just as the public Methods & tools panel hides it. The overlay
  // keys on the stable (supercategory, family_label).
  it("excludes a #800-suppressed family from both methods and source-options", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      familyRow("AAV vectors", "vector platform", 28, ["AAV2"]),
      familyRow("generic technique", "lab methods", 9),
    ]);
    mockFamilySuppressionFindMany.mockResolvedValue([
      { supercategory: "lab methods", familyLabel: "generic technique" },
    ]);
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.methods).toEqual([
      { name: "AAV vectors", category: "vector platform", examples: ["AAV2"] },
    ]);
    const opts = await loadOverviewSourceOptions("self01");
    expect(opts.tools.map((t) => t.toolName)).toEqual(["AAV vectors"]);
  });

  it("maps facultyMetrics from the scholar row", async () => {
    mockScholarFindUnique.mockResolvedValue(
      scholarRow({ hIndex: 92, firstAuthorCount: 40, lastAuthorCount: 300, scoredPubCount: 39 }),
    );
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.facultyMetrics).toEqual({
      hIndex: 92,
      firstAuthorCount: 40,
      lastAuthorCount: 300,
      scoredPubCount: 39,
    });
  });

  it("facultyMetrics is null when the scholar has no FACULTY# metrics", async () => {
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.facultyMetrics).toBeNull();
  });

  it("source-options returns families as tools (maxConfidence 1) with defaultSelected", async () => {
    mockScholarFamilyFindMany.mockResolvedValue(FAMILIES);
    const opts = await loadOverviewSourceOptions("self01");
    expect(opts.tools).toEqual([
      {
        toolName: "AAV vectors",
        category: "vector platform",
        pmidCount: 28,
        maxConfidence: 1,
        defaultSelected: true,
      },
      {
        toolName: "PET imaging",
        category: "imaging",
        pmidCount: 12,
        maxConfidence: 1,
        defaultSelected: true,
      },
    ]);
  });

  // #765 §2 / §7.4 — the pmid_count >= 2 default floor keeps the Methods rule
  // line ("ranked by how often each appears") honest. Single-paper long-tail
  // families are CANDIDATES (still selectable) but never default-selected.
  it("does NOT default-select a single-paper (pmid_count = 1) method family", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([familyRow("long-tail method", "method", 1)]);
    const opts = await loadOverviewSourceOptions("self01");
    expect(opts.tools).toEqual([
      {
        toolName: "long-tail method",
        category: "method",
        pmidCount: 1,
        maxConfidence: 1,
        defaultSelected: false,
      },
    ]);
  });

  it("default-selects only the >=2-paper families, skipping the pmid_count = 1 ones", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      familyRow("frequent", "method", 5),
      familyRow("rare", "method", 1),
    ]);
    const opts = await loadOverviewSourceOptions("self01");
    expect(opts.tools.map((t) => [t.toolName, t.defaultSelected])).toEqual([
      ["frequent", true],
      ["rare", false],
    ]);
  });

  it("the empty-selection assembler path also honors the pmid_count floor", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      familyRow("frequent", "method", 5, ["tool-a"]),
      familyRow("rare", "method", 1),
    ]);
    // No explicit selection → default path → only the >=2 family flows to methods.
    const facts = await assembleOverviewFacts("self01");
    expect(facts?.methods).toEqual([
      { name: "frequent", category: "method", examples: ["tool-a"] },
    ]);
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
    methods: [],
    facultyMetrics: null,
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
            pmid: "1",
            title: "t",
            venue: null,
            year: null,
            impact: null,
            synopsis: null,
            impactJustification: null,
            topicRationale: null,
            authorPosition: null,
          },
        ],
      }),
    ).toBe(true);
  });

  it("is true with at least one active grant", () => {
    expect(
      hasSufficientFacts({
        ...empty,
        activeGrants: [{ role: "PI", funderLabel: "NIH", title: null, mechanism: "R01" }],
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
