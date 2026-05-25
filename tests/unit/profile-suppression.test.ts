import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockScholarFindFirst,
  mockScholarFindUnique,
  mockFieldOverrideFindUnique,
  mockPublicationAuthorFindMany,
  mockSuppressionFindMany,
  mockPersonNihProfileFindFirst,
} = vi.hoisted(() => ({
  mockScholarFindFirst: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockFieldOverrideFindUnique: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockPersonNihProfileFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findFirst: mockScholarFindFirst, findUnique: mockScholarFindUnique },
    fieldOverride: { findUnique: mockFieldOverrideFindUnique },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    personNihProfile: { findFirst: mockPersonNihProfileFindFirst },
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

import { getScholarFullProfileBySlug } from "@/lib/api/profile";

const OWNER = "owner001";

function scholarRow() {
  return {
    cwid: OWNER,
    slug: "owner-one",
    preferredName: "Owner One",
    fullName: "Owner Q. One",
    postnominal: null,
    primaryTitle: "Professor",
    primaryDepartment: "Medicine",
    email: null,
    headshotUrl: null,
    overview: null,
    orcid: null,
    hasClinicalProfile: false,
    clinicalProfileUrl: null,
    deletedAt: null,
    status: "active",
    appointments: [],
    educations: [],
    grants: [],
    coiActivities: [],
    division: null,
    postdoctoralMentor: null,
  };
}

/** A confirmed authorship row for OWNER on `pmid`; optionally with one co-author. */
function authorship(pmid: string, coCwid: string | null) {
  const authors: Array<Record<string, unknown>> = [
    {
      isFirst: true,
      isLast: false,
      position: 1,
      scholar: {
        cwid: OWNER,
        slug: "owner-one",
        preferredName: "Owner One",
        deletedAt: null,
        status: "active",
      },
    },
  ];
  if (coCwid) {
    authors.push({
      isFirst: false,
      isLast: true,
      position: 2,
      scholar: {
        cwid: coCwid,
        slug: `${coCwid}-slug`,
        preferredName: "Co Author",
        deletedAt: null,
        status: "active",
      },
    });
  }
  return {
    cwid: OWNER,
    isConfirmed: true,
    isFirst: true,
    isLast: false,
    isPenultimate: false,
    position: 1,
    publication: {
      pmid,
      title: `Title ${pmid}`,
      authorsString: "Owner O, Co A",
      journal: "Journal",
      year: 2024,
      publicationType: "Academic Article",
      citationCount: 0,
      impactScore: null,
      dateAddedToEntrez: new Date("2024-01-01"),
      doi: null,
      pmcid: null,
      pubmedUrl: null,
      meshTerms: null,
      abstract: null,
      authors,
      publicationScores: [],
    },
  };
}

beforeEach(() => {
  mockScholarFindFirst.mockReset();
  mockScholarFindUnique.mockReset();
  mockFieldOverrideFindUnique.mockReset().mockResolvedValue(null);
  mockPublicationAuthorFindMany.mockReset();
  mockSuppressionFindMany.mockReset().mockResolvedValue([]);
  mockPersonNihProfileFindFirst.mockReset().mockResolvedValue(null);
});

describe("getScholarFullProfileBySlug — publication suppression", () => {
  it("drops a publication the scholar has hidden from their own publications list", async () => {
    mockScholarFindFirst.mockResolvedValue(scholarRow());
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorship("100", null),
      authorship("200", null),
    ]);
    mockSuppressionFindMany.mockResolvedValue([
      { entityId: "100", contributorCwid: OWNER },
    ]);
    const payload = await getScholarFullProfileBySlug("owner-one");
    expect((payload?.publications ?? []).map((p) => p.pmid)).toEqual(["200"]);
  });

  it("drops a whole-publication takedown from the publications list", async () => {
    mockScholarFindFirst.mockResolvedValue(scholarRow());
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorship("100", null),
      authorship("200", null),
    ]);
    mockSuppressionFindMany.mockResolvedValue([
      { entityId: "200", contributorCwid: null },
    ]);
    const payload = await getScholarFullProfileBySlug("owner-one");
    expect((payload?.publications ?? []).map((p) => p.pmid)).toEqual(["100"]);
  });

  it("omits a hidden co-author from a kept publication's WCM author chips", async () => {
    mockScholarFindFirst.mockResolvedValue(scholarRow());
    mockPublicationAuthorFindMany.mockResolvedValue([authorship("100", "co001")]);
    mockSuppressionFindMany.mockResolvedValue([
      { entityId: "100", contributorCwid: "co001" },
    ]);
    const payload = await getScholarFullProfileBySlug("owner-one");
    const pub = (payload?.publications ?? []).find((p) => p.pmid === "100");
    expect(pub).toBeDefined();
    expect(pub!.wcmAuthors.map((w) => w.cwid)).toEqual([OWNER]);
  });

  it("keeps every publication and chip when nothing is suppressed", async () => {
    mockScholarFindFirst.mockResolvedValue(scholarRow());
    mockPublicationAuthorFindMany.mockResolvedValue([authorship("100", "co001")]);
    mockSuppressionFindMany.mockResolvedValue([]);
    const payload = await getScholarFullProfileBySlug("owner-one");
    const pub = (payload?.publications ?? []).find((p) => p.pmid === "100");
    expect([...(pub?.wcmAuthors ?? [])].map((w) => w.cwid).sort()).toEqual(
      [OWNER, "co001"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// whole-entity suppression: education / appointment sidebars (#160 PR-A)
// ---------------------------------------------------------------------------

function education(externalId: string, degree: string) {
  return { externalId, degree, institution: "Inst", year: 2010, field: "Biology" };
}
function appointment(externalId: string, title: string) {
  return {
    externalId,
    title,
    organization: "Weill Cornell",
    startDate: new Date("2015-01-01"),
    endDate: null,
    isPrimary: false,
    isInterim: false,
    source: "ED",
  };
}

/** Mock keyed on the queried entityType, so the publication loader and the
 *  whole-entity loaders don't cross-contaminate. */
function suppressByType(map: Record<string, string[]>) {
  mockSuppressionFindMany.mockImplementation(
    async ({ where }: { where: { entityType: string } }) =>
      (map[where.entityType] ?? []).map((entityId) => ({ entityId, contributorCwid: null })),
  );
}

describe("getScholarFullProfileBySlug — entity suppression (#160)", () => {
  it("drops a suppressed education entry from the sidebar", async () => {
    mockScholarFindFirst.mockResolvedValue({
      ...scholarRow(),
      educations: [education("EDU-1", "MD"), education("EDU-2", "PhD")],
    });
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    suppressByType({ education: ["EDU-2"] });
    const payload = await getScholarFullProfileBySlug("owner-one");
    expect((payload?.educations ?? []).map((e) => e.degree)).toEqual(["MD"]);
  });

  it("drops a suppressed appointment from the sidebar", async () => {
    mockScholarFindFirst.mockResolvedValue({
      ...scholarRow(),
      appointments: [appointment("APPT-1", "Professor"), appointment("APPT-2", "Lecturer")],
    });
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    suppressByType({ appointment: ["APPT-2"] });
    const payload = await getScholarFullProfileBySlug("owner-one");
    expect((payload?.appointments ?? []).map((a) => a.title)).toEqual(["Professor"]);
  });

  it("keeps education + appointments when nothing is suppressed", async () => {
    mockScholarFindFirst.mockResolvedValue({
      ...scholarRow(),
      educations: [education("EDU-1", "MD")],
      appointments: [appointment("APPT-1", "Professor")],
    });
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    suppressByType({});
    const payload = await getScholarFullProfileBySlug("owner-one");
    expect((payload?.educations ?? []).length).toBe(1);
    expect((payload?.appointments ?? []).length).toBe(1);
  });
});
