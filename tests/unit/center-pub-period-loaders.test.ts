/**
 * The publication period shared by report 17, the attribution loader (reports
 * 18/19) and `etl/center-pub-relevance`: a publication is in a window by its
 * `publicationDate` (dateAddedToEntrez, else 1 January of the year), not by
 * `Publication.year`. And a confirmed author with no scholar row is shown as
 * "Unknown author", never by cwid. Synthetic cwids, pmids and names only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { membershipFindMany, publicationFindMany, relevanceFindMany, appointmentFindMany } =
  vi.hoisted(() => ({
    membershipFindMany: vi.fn(),
    publicationFindMany: vi.fn(),
    relevanceFindMany: vi.fn(),
    appointmentFindMany: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      centerMembership: { findMany: membershipFindMany },
      publication: { findMany: publicationFindMany },
      centerPublicationRelevance: { findMany: relevanceFindMany },
      appointment: { findMany: appointmentFindMany },
    },
  },
}));

import { publicationInPeriod, publicationPeriodWhere } from "@/lib/edit/center-pub-attribution";
import { loadCenterPubAttribution } from "@/lib/edit/center-pub-attribution.server";
import { loadPubRelevanceReport } from "@/lib/edit/pub-relevance-report.server";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

const pub = (pmid: string, year: number, entrez: string | null, cwid = "zz1001") => ({
  pmid,
  title: `Synthetic title ${pmid}`,
  journal: null,
  year,
  dateAddedToEntrez: entrez ? d(entrez) : null,
  publicationType: "Academic Article",
  authors: [{ cwid, scholar: cwid === "zz1001" ? { preferredName: "Pat Synthetic" } : null }],
});

beforeEach(() => {
  vi.clearAllMocks();
  membershipFindMany.mockResolvedValue([
    {
      cwid: "zz1001",
      programCode: "AA",
      membershipType: "research",
      startDate: d("2020-01-01"),
      endDate: null,
      membershipRoleKey: null,
    },
    {
      cwid: "zz1002",
      programCode: "BB",
      membershipType: "research",
      startDate: d("2020-01-01"),
      endDate: null,
      membershipRoleKey: null,
    },
  ]);
  relevanceFindMany.mockResolvedValue([]);
  appointmentFindMany.mockResolvedValue([]);
});

describe("publicationInPeriod", () => {
  it("tests the Entrez date, not the year", () => {
    const p = { dateAddedToEntrez: d("2025-01-10"), year: 2024 };
    expect(publicationInPeriod(p, "2025-01-01", "2025-12-31")).toBe(true);
    expect(publicationInPeriod(p, "2024-01-01", "2024-12-31")).toBe(false);
  });

  it("falls back to 1 January of the year, and an open window has no end", () => {
    expect(publicationInPeriod({ dateAddedToEntrez: null, year: 2025 }, "2025-01-01")).toBe(true);
    expect(publicationInPeriod({ dateAddedToEntrez: null, year: 2024 }, "2025-01-01")).toBe(false);
    expect(publicationInPeriod({ dateAddedToEntrez: null, year: null }, "2025-01-01")).toBe(false);
  });
});

describe("publicationPeriodWhere", () => {
  it("selects by Entrez date, else by year when the Entrez date is null", () => {
    expect(publicationPeriodWhere("2025-01-01", "2025-12-31")).toEqual({
      OR: [
        { dateAddedToEntrez: { gte: d("2025-01-01"), lte: d("2025-12-31") } },
        { dateAddedToEntrez: null, year: { gte: 2025, lte: 2025 } },
      ],
    });
    expect(publicationPeriodWhere("2025-01-01")).toEqual({
      OR: [
        { dateAddedToEntrez: { gte: d("2025-01-01") } },
        { dateAddedToEntrez: null, year: { gte: 2025 } },
      ],
    });
  });
});

describe("loadPubRelevanceReport", () => {
  it("shows a year=2024 pub added to Entrez in 2025 in the 2025 view, by publicationDate", async () => {
    publicationFindMany.mockResolvedValue([
      pub("90000001", 2024, "2025-01-10"),
      pub("90000002", 2025, "2026-01-02"), // out of 2025 by its Entrez date
      pub("90000003", 2025, null),
    ]);
    const rows = await loadPubRelevanceReport("ZZCC", 2025);
    expect(rows.map((r) => r.pmid)).toEqual(["90000001", "90000003"]);
    expect(publicationFindMany.mock.calls[0][0].where).toMatchObject(
      publicationPeriodWhere("2025-01-01", "2025-12-31"),
    );
    expect(publicationFindMany.mock.calls[0][0].where).not.toHaveProperty("year");
  });

  it("names an author with no scholar row 'Unknown author', not by cwid", async () => {
    publicationFindMany.mockResolvedValue([pub("90000004", 2025, null, "zz1002")]);
    const [row] = await loadPubRelevanceReport("ZZCC", 2025);
    expect(row.members).toEqual([{ cwid: "zz1002", name: "Unknown author", programCode: "BB" }]);
  });
});

describe("loadCenterPubAttribution", () => {
  it("names an author with no scholar row 'Unknown author', not by cwid", async () => {
    publicationFindMany.mockResolvedValue([pub("90000005", 2025, "2025-03-01", "zz1002")]);
    const r = await loadCenterPubAttribution("ZZCC", {
      from: "2025-01-01",
      to: "2025-12-31",
      asOf: "2025-06-01",
    });
    expect(r.publications[0].members.map((m) => m.name)).toEqual(["Unknown author"]);
  });
});
