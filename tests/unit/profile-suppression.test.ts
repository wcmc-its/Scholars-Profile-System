import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockScholarFindFirst,
  mockScholarFindUnique,
  mockFieldOverrideFindUnique,
  mockFieldOverrideFindMany,
  mockPublicationAuthorFindMany,
  mockSuppressionFindMany,
  mockPersonNihProfileFindFirst,
} = vi.hoisted(() => ({
  mockScholarFindFirst: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockFieldOverrideFindUnique: vi.fn(),
  mockFieldOverrideFindMany: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockPersonNihProfileFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findFirst: mockScholarFindFirst, findUnique: mockScholarFindUnique },
    fieldOverride: { findUnique: mockFieldOverrideFindUnique, findMany: mockFieldOverrideFindMany },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    personNihProfile: { findFirst: mockPersonNihProfileFindFirst },
    // #1266 — leadership reader lookups; default empty (no leadership roles).
    department: { findMany: vi.fn(async () => []) },
    division: { findMany: vi.fn(async () => []) },
    center: { findMany: vi.fn(async () => []) },
    centerProgramLeader: { findMany: vi.fn(async () => []) },
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
    profileAppointments: [],
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
  // No section-visibility overrides by default (a fully-public profile).
  mockFieldOverrideFindMany.mockReset().mockResolvedValue([]);
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
function grant(externalId: string, title: string) {
  return {
    externalId,
    title,
    role: "PI",
    funder: "NIH",
    source: "InfoEd",
    startDate: new Date("2020-01-01"),
    endDate: new Date("2030-01-01"),
    awardNumber: null,
    programType: "Grant",
    primeSponsor: null,
    primeSponsorRaw: null,
    directSponsor: null,
    directSponsorRaw: null,
    mechanism: null,
    nihIc: null,
    isSubaward: false,
    applId: null,
    abstract: null,
    abstractSource: null,
    publications: [],
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

  it("drops a suppressed grant role from the funding section (#160 PR-B)", async () => {
    mockScholarFindFirst.mockResolvedValue({
      ...scholarRow(),
      grants: [grant("INFOED-1-owner001", "Grant A"), grant("INFOED-2-owner001", "Grant B")],
    });
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    suppressByType({ grant: ["INFOED-2-owner001"] });
    const payload = await getScholarFullProfileBySlug("owner-one");
    expect((payload?.grants ?? []).map((g) => g.title)).toEqual(["Grant A"]);
  });
});

// ---------------------------------------------------------------------------
// section-visibility: whole-section hide (section-visibility-spec.md)
// ---------------------------------------------------------------------------

describe("getScholarFullProfileBySlug — section visibility", () => {
  it("empties the Education section from the payload when hideEducation is set", async () => {
    mockScholarFindFirst.mockResolvedValue({
      ...scholarRow(),
      educations: [education("EDU-1", "MD"), education("EDU-2", "PhD")],
      grants: [grant("INFOED-1-owner001", "Grant A")],
    });
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    mockFieldOverrideFindMany.mockResolvedValue([{ fieldName: "hideEducation" }]);
    const payload = await getScholarFullProfileBySlug("owner-one");
    // Education is gone; Funding (not hidden) still renders.
    expect(payload?.educations).toEqual([]);
    expect((payload?.grants ?? []).map((g) => g.title)).toEqual(["Grant A"]);
    // The hidden key is surfaced for the render body's mentoring / methods gates.
    expect(payload?.hiddenSections).toContain("hideEducation");
  });

  it("empties Funding and surfaces hideMentoring while keeping Education visible", async () => {
    mockScholarFindFirst.mockResolvedValue({
      ...scholarRow(),
      educations: [education("EDU-1", "MD")],
      grants: [grant("INFOED-1-owner001", "Grant A"), grant("INFOED-2-owner001", "Grant B")],
    });
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "hideFunding" },
      { fieldName: "hideMentoring" },
    ]);
    const payload = await getScholarFullProfileBySlug("owner-one");
    expect(payload?.grants).toEqual([]);
    expect((payload?.educations ?? []).map((e) => e.degree)).toEqual(["MD"]);
    expect(payload?.hiddenSections).toEqual(
      expect.arrayContaining(["hideFunding", "hideMentoring"]),
    );
    // Only rows the loader queried for value "true" are read; a "false" row is
    // never returned by the query, so it never appears as hidden here.
    expect(mockFieldOverrideFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "scholar",
          value: "true",
        }),
      }),
    );
  });

  it("keeps every section visible when no section-visibility override is set", async () => {
    mockScholarFindFirst.mockResolvedValue({
      ...scholarRow(),
      educations: [education("EDU-1", "MD")],
      grants: [grant("INFOED-1-owner001", "Grant A")],
    });
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    // default beforeEach: mockFieldOverrideFindMany resolves []
    const payload = await getScholarFullProfileBySlug("owner-one");
    expect((payload?.educations ?? []).length).toBe(1);
    expect((payload?.grants ?? []).length).toBe(1);
    expect(payload?.hiddenSections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// historical appointments: reveal split (#1323)
// ---------------------------------------------------------------------------

/** An `ED-HISTORICAL` (expired) appointment row from the WOOFA SOR. Hidden by
 *  default; only surfaces in `pastAppointments` when `showOnProfile` is true. */
function historicalAppointment(externalId: string, title: string, showOnProfile: boolean) {
  return {
    externalId,
    title,
    organization: "Weill Cornell",
    startDate: new Date("2008-01-01"),
    endDate: new Date("2012-12-31"),
    isPrimary: false,
    isInterim: false,
    source: "ED-HISTORICAL",
    showOnProfile,
  };
}

describe("getScholarFullProfileBySlug — historical appointment reveal split (#1323)", () => {
  it("keeps historical rows out of `appointments` and surfaces only the revealed one in `pastAppointments`", async () => {
    mockScholarFindFirst.mockResolvedValue({
      ...scholarRow(),
      appointments: [
        appointment("APPT-1", "Professor"), // active ED — must stay in `appointments`
        historicalAppointment("HIST-1", "Resident", false), // hidden — excluded everywhere
        historicalAppointment("HIST-2", "Fellow", true), // revealed — only in `pastAppointments`
      ],
    });
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    suppressByType({});
    const payload = await getScholarFullProfileBySlug("owner-one");

    // Active pipeline is untouched: the ED appointment is the only `appointments` entry.
    expect((payload?.appointments ?? []).map((a) => a.title)).toEqual(["Professor"]);
    // Both historical rows are absent from the active list (zero regression).
    expect((payload?.appointments ?? []).map((a) => a.title)).not.toContain("Resident");
    expect((payload?.appointments ?? []).map((a) => a.title)).not.toContain("Fellow");

    // Only the revealed historical row appears in `pastAppointments`.
    expect((payload?.pastAppointments ?? []).map((a) => a.title)).toEqual(["Fellow"]);
  });
});
