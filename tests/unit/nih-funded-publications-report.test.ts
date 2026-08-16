import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `lib/edit/nih-funded-publications-report.ts` unit tests. Mocks the
 * collaborators at the module boundary, NO live DB — mirrors
 * `cancer-center-publications-report.test.ts`'s mocking shape.
 */
const hoisted = vi.hoisted(() => ({
  mockLoadCenterMembers: vi.fn(),
  mockLoadDivisionMembers: vi.fn(),
  mockPubFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
}));

vi.mock("@/lib/api/centers", () => ({
  loadActiveCenterMemberCwids: hoisted.mockLoadCenterMembers,
}));
vi.mock("@/lib/api/divisions", () => ({
  loadDivisionMemberCwids: hoisted.mockLoadDivisionMembers,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      publication: { findMany: hoisted.mockPubFindMany },
      scholar: { findMany: hoisted.mockScholarFindMany },
    },
  },
}));

import { loadNihFundedPublicationsReport } from "@/lib/edit/nih-funded-publications-report";

beforeEach(() => {
  hoisted.mockLoadCenterMembers.mockReset();
  hoisted.mockLoadDivisionMembers.mockReset();
  hoisted.mockPubFindMany.mockReset();
  hoisted.mockScholarFindMany.mockReset();
});

describe("loadNihFundedPublicationsReport — no members / no publications", () => {
  it("returns an empty report and never queries publications when the unit has no active members", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue([]);

    const report = await loadNihFundedPublicationsReport("center", "MEYER");

    expect(report).toEqual({ totalPublications: 0, rows: [] });
    expect(hoisted.mockPubFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty report when the member set has zero NIH-linked publications", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([]);

    const report = await loadNihFundedPublicationsReport("center", "MEYER");

    expect(report).toEqual({ totalPublications: 0, rows: [] });
  });

  it("queries with a grants: { some: {} } gate alongside confirmed member authorship", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([]);

    await loadNihFundedPublicationsReport("center", "MEYER");

    expect(hoisted.mockPubFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          authors: { some: { isConfirmed: true, cwid: { in: ["abc1234"] } } },
          grants: { some: {} },
        },
      }),
    );
  });
});

describe("loadNihFundedPublicationsReport — row grain and confidence", () => {
  it("flattens one row per (publication, grant) link — a pub with 2 grants yields 2 rows, totalPublications still 1", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      {
        pmid: "1",
        title: "Co-funded pub",
        journal: "Nature",
        year: 2024,
        grants: [
          {
            grantId: "g1",
            sourceReporter: true,
            sourceReciterdb: true,
            reciterdbFirstSeen: new Date("2023-01-01"),
            grant: { title: "Grant One", awardNumber: "R01 AG000001" },
          },
          {
            grantId: "g2",
            sourceReporter: false,
            sourceReciterdb: true,
            reciterdbFirstSeen: new Date("2020-01-01"),
            grant: { title: "Grant Two", awardNumber: null },
          },
        ],
      },
    ]);

    const report = await loadNihFundedPublicationsReport("center", "MEYER");

    expect(report.totalPublications).toBe(1);
    expect(report.rows).toHaveLength(2);
    expect(report.rows.map((r) => r.grantId).sort()).toEqual(["g1", "g2"]);
  });

  it("isLowerConfidence: true only when reciterdb-only AND first-seen >12 months ago", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    const old = new Date();
    old.setMonth(old.getMonth() - 13);
    hoisted.mockPubFindMany.mockResolvedValue([
      {
        pmid: "1",
        title: "Both sources",
        journal: "J1",
        year: 2024,
        grants: [
          {
            grantId: "both",
            sourceReporter: true,
            sourceReciterdb: true,
            reciterdbFirstSeen: old,
            grant: { title: "G", awardNumber: null },
          },
        ],
      },
      {
        pmid: "2",
        title: "Reciterdb-only, recent",
        journal: "J2",
        year: 2024,
        grants: [
          {
            grantId: "recent",
            sourceReporter: false,
            sourceReciterdb: true,
            reciterdbFirstSeen: new Date(),
            grant: { title: "G", awardNumber: null },
          },
        ],
      },
      {
        pmid: "3",
        title: "Reciterdb-only, stale",
        journal: "J3",
        year: 2024,
        grants: [
          {
            grantId: "stale",
            sourceReporter: false,
            sourceReciterdb: true,
            reciterdbFirstSeen: old,
            grant: { title: "G", awardNumber: null },
          },
        ],
      },
      {
        pmid: "4",
        title: "Reciterdb-only, null first-seen",
        journal: "J4",
        year: 2024,
        grants: [
          {
            grantId: "nullseen",
            sourceReporter: false,
            sourceReciterdb: true,
            reciterdbFirstSeen: null,
            grant: { title: "G", awardNumber: null },
          },
        ],
      },
    ]);

    const report = await loadNihFundedPublicationsReport("center", "MEYER");
    const byGrantId = new Map(report.rows.map((r) => [r.grantId, r.isLowerConfidence]));

    expect(byGrantId.get("both")).toBe(false); // RePORTER-confirmed
    expect(byGrantId.get("recent")).toBe(false); // too recent
    expect(byGrantId.get("stale")).toBe(true); // the trigger case
    expect(byGrantId.get("nullseen")).toBe(false); // no first-seen date to compare
  });

  it("sorts newest publication year first, then pmid, then grantId for stability", async () => {
    hoisted.mockLoadCenterMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      {
        pmid: "2",
        title: "Older",
        journal: "J",
        year: 2020,
        grants: [{ grantId: "g", sourceReporter: true, sourceReciterdb: false, reciterdbFirstSeen: null, grant: { title: "G", awardNumber: null } }],
      },
      {
        pmid: "1",
        title: "Newer",
        journal: "J",
        year: 2024,
        grants: [{ grantId: "g", sourceReporter: true, sourceReciterdb: false, reciterdbFirstSeen: null, grant: { title: "G", awardNumber: null } }],
      },
    ]);

    const report = await loadNihFundedPublicationsReport("center", "MEYER");

    expect(report.rows.map((r) => r.pmid)).toEqual(["1", "2"]);
  });
});

describe("loadNihFundedPublicationsReport — per-kind membership resolution", () => {
  it("division: resolves members via loadDivisionMemberCwids", async () => {
    hoisted.mockLoadDivisionMembers.mockResolvedValue(["div001"]);
    hoisted.mockPubFindMany.mockResolvedValue([]);

    await loadNihFundedPublicationsReport("division", "N1234");

    expect(hoisted.mockLoadDivisionMembers).toHaveBeenCalledWith("N1234");
    expect(hoisted.mockLoadCenterMembers).not.toHaveBeenCalled();
  });

  it("department: resolves members via Scholar.deptCode (active, non-deleted)", async () => {
    hoisted.mockScholarFindMany.mockResolvedValue([{ cwid: "dept001" }]);
    hoisted.mockPubFindMany.mockResolvedValue([]);

    await loadNihFundedPublicationsReport("department", "SURG");

    expect(hoisted.mockScholarFindMany).toHaveBeenCalledWith({
      where: { deptCode: "SURG", deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    expect(hoisted.mockLoadCenterMembers).not.toHaveBeenCalled();
    expect(hoisted.mockLoadDivisionMembers).not.toHaveBeenCalled();
  });
});
