import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `lib/edit/cancer-center-publications-report.ts` unit tests. Mocks the
 * collaborators at the module boundary, NO live DB:
 *   - `@/lib/api/centers` — `loadActiveCenterMemberCwids` (center membership).
 *   - `@/lib/api/divisions` — `loadDivisionMemberCwids` (division membership).
 *   - `@/lib/api/cores` — `loadConfirmedCorePmidsByCore` (a CORE's publication
 *     set; cores have no membership at all, so this replaces the member
 *     resolver rather than joining it).
 *   - `@/lib/db` — `db.read.publication.findMany` / `db.read.journalImpactFactor
 *     .findMany` / `db.read.scholar.findMany` (the reads the report joins
 *     in-process — `scholar.findMany` backs both department membership and the
 *     confirmed-author roleCategory batch lookup).
 *
 * The one behavior most worth protecting: `highImpactRatePct` MUST be computed
 * against `matchedPublications`, never `totalPublications` — a wrong
 * denominator silently overstates confidence. See the "match-rate-vs-total"
 * test below, which is built so it fails if that denominator ever regresses.
 */
const hoisted = vi.hoisted(() => ({
  mockLoadCenterMembers: vi.fn(),
  mockLoadDivisionMembers: vi.fn(),
  mockLoadConfirmedCorePmids: vi.fn(),
  mockPubFindMany: vi.fn(),
  mockJifFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
}));

vi.mock("@/lib/api/centers", () => ({
  loadActiveCenterMemberCwids: hoisted.mockLoadCenterMembers,
}));
vi.mock("@/lib/api/divisions", () => ({
  loadDivisionMemberCwids: hoisted.mockLoadDivisionMembers,
}));
vi.mock("@/lib/api/cores", () => ({
  loadConfirmedCorePmidsByCore: hoisted.mockLoadConfirmedCorePmids,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      publication: { findMany: hoisted.mockPubFindMany },
      journalImpactFactor: { findMany: hoisted.mockJifFindMany },
      scholar: { findMany: hoisted.mockScholarFindMany },
    },
  },
}));

import {
  HIGH_IMPACT_THRESHOLD,
  loadUnitPublicationsReport,
  parseCategory,
} from "@/lib/edit/cancer-center-publications-report";

beforeEach(() => {
  hoisted.mockLoadCenterMembers.mockReset();
  hoisted.mockLoadDivisionMembers.mockReset();
  hoisted.mockLoadConfirmedCorePmids.mockReset();
  hoisted.mockPubFindMany.mockReset();
  hoisted.mockJifFindMany.mockReset();
  hoisted.mockScholarFindMany.mockReset();
  hoisted.mockScholarFindMany.mockResolvedValue([]);
});

describe("loadUnitPublicationsReport — no members / no publications", () => {
  it("returns a zeroed report and never queries publications when the center has no active members", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue([]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    expect(report).toEqual({
      totalPublications: 0,
      matchedPublications: 0,
      matchRatePct: 0,
      highImpactCount: 0,
      highImpactRatePct: 0,
      rows: [],
    });
    expect(hoisted.mockPubFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockJifFindMany).not.toHaveBeenCalled();
  });

  it("returns a zeroed report and never queries JournalImpactFactor when the member set has zero publications", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    expect(report.totalPublications).toBe(0);
    expect(report.rows).toEqual([]);
    expect(hoisted.mockJifFindMany).not.toHaveBeenCalled();
  });
});

describe("loadUnitPublicationsReport — zero matches", () => {
  it("reports a 0% match rate when no publication's journal matches", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "A", journal: "Foo Journal", journalAbbrev: "Foo J", year: 2020, authors: [] },
      { pmid: "2", title: "B", journal: "Bar Journal", journalAbbrev: "Bar J", year: 2021, authors: [] },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    expect(report.totalPublications).toBe(2);
    expect(report.matchedPublications).toBe(0);
    expect(report.matchRatePct).toBe(0);
    expect(report.highImpactCount).toBe(0);
    expect(report.highImpactRatePct).toBe(0);
    expect(report.rows).toEqual([]);
  });

  it("skips a publication with no journalAbbrev without querying it against JournalImpactFactor", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "No abbrev", journal: "Some Journal", journalAbbrev: null, year: 2020, authors: [] },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    expect(report.totalPublications).toBe(1);
    expect(report.matchedPublications).toBe(0);
    // Nothing to look up — findMany must not even be called with an empty `in`.
    expect(hoisted.mockJifFindMany).not.toHaveBeenCalled();
  });
});

describe("loadUnitPublicationsReport — partial matches", () => {
  it("computes highImpactRatePct against MATCHED count, never totalPublications", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "High-IF match", journal: "Nature", journalAbbrev: "Nature", year: 2024, authors: [] },
      { pmid: "2", title: "Low-IF match", journal: "Some Journal", journalAbbrev: "Some J", year: 2023, authors: [] },
      { pmid: "3", title: "Unmatched A", journal: "Unknown Journal 1", journalAbbrev: "Unk J1", year: 2022, authors: [] },
      { pmid: "4", title: "Unmatched B", journal: "Unknown Journal 2", journalAbbrev: "Unk J2", year: 2021, authors: [] },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([
      {
        journalAbbrev: "NATURE",
        journalTitle: "Nature",
        impactScore1: 50.5,
        impactScore2: 54.4,
        category: "MULTIDISCIPLINARY SCIENCES|Q1|1/134",
      },
      {
        journalAbbrev: "SOME J",
        journalTitle: "Some Journal",
        impactScore1: 3.2,
        impactScore2: 2.9,
        category: "MEDICINE, GENERAL & INTERNAL|Q3|200/325",
      },
    ]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    expect(report.totalPublications).toBe(4);
    expect(report.matchedPublications).toBe(2);
    expect(report.matchRatePct).toBe(50); // 2 / 4 total
    expect(report.highImpactCount).toBe(1); // only Nature (50.5 >= HIGH_IMPACT_THRESHOLD)
    // The one behavior most worth protecting: 1/2 MATCHED (50%), never 1/4 TOTAL
    // (25%) — a wrong denominator here silently overstates confidence.
    expect(report.highImpactRatePct).toBe(50);
    expect(report.highImpactRatePct).not.toBe((report.highImpactCount / report.totalPublications) * 100);

    expect(report.rows).toHaveLength(2);
    // Neither pub carries an `impactScore` in this fixture, so the primary
    // sort key ties and falls back to impactScore1 desc — the high-IF match
    // still sorts first.
    expect(report.rows[0].pmid).toBe("1");
    expect(report.rows[0].impactScore1).toBe(50.5);
    expect(report.rows[0].impactScore).toBeNull();
    expect(report.rows[1].pmid).toBe("2");
    expect(report.rows[1].impactScore1).toBe(3.2);
  });

  it("normalizes journalAbbrev (trim + uppercase) on both sides of the join", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      {
        pmid: "1",
        title: "Mixed case",
        journal: "N Engl J Med",
        journalAbbrev: "  n engl j med  ",
        year: 2020,
        authors: [],
      },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([
      {
        journalAbbrev: "N ENGL J MED",
        journalTitle: "New England Journal of Medicine",
        impactScore1: 96.2,
        impactScore2: 94.3,
        category: "MEDICINE, GENERAL & INTERNAL|Q1|2/325",
      },
    ]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    expect(hoisted.mockJifFindMany).toHaveBeenCalledWith({
      where: { journalAbbrev: { in: ["N ENGL J MED"] } },
    });
    expect(report.matchedPublications).toBe(1);
    expect(report.rows[0].impactScore1).toBe(96.2);
  });

  it("treats a null impactScore1 as not high-impact without dropping the match", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "New journal", journal: "New J", journalAbbrev: "New J", year: 2026, authors: [] },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([
      { journalAbbrev: "NEW J", journalTitle: "New Journal", impactScore1: null, impactScore2: null, category: null },
    ]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    expect(report.matchedPublications).toBe(1);
    expect(report.highImpactCount).toBe(0);
    expect(report.rows[0].impactScore1).toBeNull();
  });

  it("sorts by the paper-level impactScore first, falling back to impactScore1 only on a tie", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      {
        pmid: "1",
        title: "High JIF, low impactScore",
        journal: "Nature",
        journalAbbrev: "Nature",
        year: 2024,
        impactScore: 40,
        authors: [],
      },
      {
        pmid: "2",
        title: "Low JIF, high impactScore",
        journal: "Some Journal",
        journalAbbrev: "Some J",
        year: 2023,
        impactScore: 88,
        authors: [],
      },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([
      { journalAbbrev: "NATURE", journalTitle: "Nature", impactScore1: 50.5, impactScore2: null, category: null },
      { journalAbbrev: "SOME J", journalTitle: "Some Journal", impactScore1: 3.2, impactScore2: null, category: null },
    ]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    // impactScore 88 outranks impactScore 40, even though pmid 1's JIF is
    // much higher — the primary key is now the paper-level score.
    expect(report.rows[0].pmid).toBe("2");
    expect(report.rows[1].pmid).toBe("1");
  });

  it("carries synopsis / impactJustification through when present, null when absent", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      {
        pmid: "1",
        title: "Has both",
        journal: "Nature",
        journalAbbrev: "Nature",
        year: 2024,
        impactScore: 77,
        impactJustification: "Novel mechanism, high translational relevance.",
        synopsis: "Plain-language one-liner.",
        authors: [],
      },
      {
        pmid: "2",
        title: "Has neither",
        journal: "Some Journal",
        journalAbbrev: "Some J",
        year: 2023,
        authors: [],
      },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([
      { journalAbbrev: "NATURE", journalTitle: "Nature", impactScore1: 50.5, impactScore2: null, category: null },
      { journalAbbrev: "SOME J", journalTitle: "Some Journal", impactScore1: 3.2, impactScore2: null, category: null },
    ]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    const row1 = report.rows.find((r) => r.pmid === "1")!;
    expect(row1.impactScore).toBe(77);
    expect(row1.impactJustification).toBe("Novel mechanism, high translational relevance.");
    expect(row1.synopsis).toBe("Plain-language one-liner.");

    const row2 = report.rows.find((r) => r.pmid === "2")!;
    expect(row2.impactScore).toBeNull();
    expect(row2.impactJustification).toBeNull();
    expect(row2.synopsis).toBeNull();
  });

  it("derives authorRoleCategories from the confirmed member authors only, deduped and non-null", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["fac001", "pd001"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      {
        pmid: "1",
        title: "Two member authors",
        journal: "Nature",
        journalAbbrev: "Nature",
        year: 2024,
        authors: [{ cwid: "fac001" }, { cwid: "pd001" }],
      },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([
      { journalAbbrev: "NATURE", journalTitle: "Nature", impactScore1: 50.5, impactScore2: null, category: null },
    ]);
    hoisted.mockScholarFindMany.mockResolvedValue([
      { cwid: "fac001", roleCategory: "full_time_faculty" },
      { cwid: "pd001", roleCategory: "postdoc" },
    ]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    expect(hoisted.mockScholarFindMany).toHaveBeenCalledWith({
      where: { cwid: { in: ["fac001", "pd001"] } },
      select: { cwid: true, roleCategory: true },
    });
    expect([...report.rows[0].authorRoleCategories].sort()).toEqual(["full_time_faculty", "postdoc"]);
  });

  it("never queries scholar roleCategories when no publication has a resolvable member author", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "No authors selected", journal: "Nature", journalAbbrev: "Nature", year: 2024, authors: [] },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([
      { journalAbbrev: "NATURE", journalTitle: "Nature", impactScore1: 50.5, impactScore2: null, category: null },
    ]);

    const report = await loadUnitPublicationsReport("center", "MEYER");

    expect(hoisted.mockScholarFindMany).not.toHaveBeenCalled();
    expect(report.rows[0].authorRoleCategories).toEqual([]);
  });
});

describe("loadUnitPublicationsReport — per-kind membership resolution", () => {
  it("division: resolves members via loadDivisionMemberCwids, not the center resolver", async () => {
    hoisted.mockLoadDivisionMembers.mockResolvedValue(["div001"]);
    hoisted.mockPubFindMany.mockResolvedValue([]);

    const report = await loadUnitPublicationsReport("division", "N1234");

    expect(hoisted.mockLoadDivisionMembers).toHaveBeenCalledWith("N1234");
    expect(hoisted.mockLoadCenterMembers).not.toHaveBeenCalled();
    expect(report.totalPublications).toBe(0);
  });

  it("department: resolves members via Scholar.deptCode (active, non-deleted), not a cached resolver", async () => {
    hoisted.mockScholarFindMany.mockResolvedValueOnce([{ cwid: "dept001" }]).mockResolvedValueOnce([]);
    hoisted.mockPubFindMany.mockResolvedValue([]);

    const report = await loadUnitPublicationsReport("department", "SURG");

    expect(hoisted.mockScholarFindMany).toHaveBeenCalledWith({
      where: { deptCode: "SURG", deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    expect(hoisted.mockLoadCenterMembers).not.toHaveBeenCalled();
    expect(hoisted.mockLoadDivisionMembers).not.toHaveBeenCalled();
    expect(report.totalPublications).toBe(0);
  });
});

describe("loadUnitPublicationsReport — core: publications come from confirmed USAGES, not members", () => {
  /** A core's publication rows always carry a real byline — the facet key is
   *  the confirmed WCM authors of the core's confirmed publications. */
  const corePub = (pmid: string, over: Record<string, unknown> = {}) => ({
    pmid,
    title: `Paper ${pmid}`,
    journal: "Nature",
    journalAbbrev: "Nature",
    year: 2025,
    impactScore: null,
    impactJustification: null,
    synopsis: null,
    authors: [{ cwid: "abc1234" }],
    ...over,
  });
  const jifNature = {
    // Normalized (trim + uppercase) on both sides of the join.
    journalAbbrev: "NATURE",
    journalTitle: "Nature",
    impactScore1: 50,
    impactScore2: 48,
    category: "MULTIDISCIPLINARY SCIENCES|Q1|1/134",
  };

  it("resolves the publication set from confirmed publication_core rows — non-empty for a core with usages, and NO member resolver is consulted", async () => {
    // THE regression this suite exists for. Simply dropping the `core`
    // exclusion from the reports suite would send a core down the MEMBER path;
    // a core has no membership table, so that resolves zero CWIDs and returns
    // EMPTY_REPORT for every core forever — "sees the report", learns nothing.
    // Asserting non-empty here is what catches that naive un-filter.
    hoisted.mockLoadConfirmedCorePmids.mockResolvedValue(new Map([["14", ["111", "222"]]]));
    hoisted.mockPubFindMany.mockResolvedValue([corePub("111"), corePub("222")]);
    hoisted.mockJifFindMany.mockResolvedValue([jifNature]);

    const report = await loadUnitPublicationsReport("core", "14");

    expect(report.totalPublications).toBe(2);
    expect(report.matchedPublications).toBe(2);
    expect(report.rows.map((r) => r.pmid)).toEqual(["111", "222"]);
    // Confirmed core usages, by core id.
    expect(hoisted.mockLoadConfirmedCorePmids).toHaveBeenCalledWith(["14"], expect.anything());
    // None of the three membership resolvers ran.
    expect(hoisted.mockLoadCenterMembers).not.toHaveBeenCalled();
    expect(hoisted.mockLoadDivisionMembers).not.toHaveBeenCalled();
    expect(hoisted.mockScholarFindMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deptCode: "14" }) }),
    );
    // The publication query is a pmid IN-list over that exact set — never the
    // `authors: { some: { cwid: { in: members } } }` fan-out.
    const where = hoisted.mockPubFindMany.mock.calls[0][0].where;
    expect(where).toEqual({ pmid: { in: ["111", "222"] } });
    expect(where.authors).toBeUndefined();
  });

  it("keys the Person-type rail on the confirmed WCM authors of those publications, so the rail is populated rather than empty", async () => {
    hoisted.mockLoadConfirmedCorePmids.mockResolvedValue(new Map([["14", ["111"]]]));
    hoisted.mockPubFindMany.mockResolvedValue([
      corePub("111", { authors: [{ cwid: "abc1234" }, { cwid: "def5678" }] }),
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([jifNature]);
    hoisted.mockScholarFindMany.mockResolvedValue([
      { cwid: "abc1234", roleCategory: "full_time_faculty" },
      { cwid: "def5678", roleCategory: "postdoc" },
    ]);

    const report = await loadUnitPublicationsReport("core", "14");

    expect([...report.rows[0].authorRoleCategories].sort()).toEqual(["full_time_faculty", "postdoc"]);
    // The nested author select is confirmed-only with NO member cwid IN-list —
    // scoping it to members would leave the rail permanently empty for a core.
    expect(hoisted.mockPubFindMany.mock.calls[0][0].select.authors.where).toEqual({ isConfirmed: true });
  });

  it("a core with zero confirmed usages renders the clean empty state and never queries publications", async () => {
    // 6 of 14 staging cores have zero confirmed usages, so an empty core is an
    // expected state, not an error one: a zeroed report, no crash.
    hoisted.mockLoadConfirmedCorePmids.mockResolvedValue(new Map([["7", []]]));

    const report = await loadUnitPublicationsReport("core", "7");

    expect(report).toEqual({
      totalPublications: 0,
      matchedPublications: 0,
      matchRatePct: 0,
      highImpactCount: 0,
      highImpactRatePct: 0,
      rows: [],
    });
    expect(hoisted.mockPubFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockJifFindMany).not.toHaveBeenCalled();
  });

  it("a core id the loader returns no entry for is treated as zero usages, not a crash", async () => {
    hoisted.mockLoadConfirmedCorePmids.mockResolvedValue(new Map());

    const report = await loadUnitPublicationsReport("core", "999");

    expect(report.totalPublications).toBe(0);
    expect(hoisted.mockPubFindMany).not.toHaveBeenCalled();
  });
});

describe("parseCategory", () => {
  it("splits a well-formed category into name/quartile/rank", () => {
    expect(parseCategory("ONCOLOGY|Q1|1/322")).toEqual({
      categoryName: "ONCOLOGY",
      quartile: "Q1",
      categoryRank: "1/322",
    });
  });

  it("returns all-null on null input", () => {
    expect(parseCategory(null)).toEqual({ categoryName: null, quartile: null, categoryRank: null });
  });

  it("returns all-null on an empty string", () => {
    expect(parseCategory("")).toEqual({ categoryName: null, quartile: null, categoryRank: null });
  });

  it("degrades gracefully on a malformed (partial) category, never throws", () => {
    expect(parseCategory("ONCOLOGY")).toEqual({
      categoryName: "ONCOLOGY",
      quartile: null,
      categoryRank: null,
    });
  });
});

describe("HIGH_IMPACT_THRESHOLD", () => {
  it("is 10 — the report's headline stat threshold", () => {
    expect(HIGH_IMPACT_THRESHOLD).toBe(10);
  });
});
