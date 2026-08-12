import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `lib/edit/cancer-center-publications-report.ts` unit tests. Mocks the
 * collaborators at the module boundary, NO live DB:
 *   - `@/lib/api/centers` — `loadActiveCenterMemberCwids` (membership).
 *   - `@/lib/db` — `db.read.publication.findMany` / `db.read.journalImpactFactor
 *     .findMany` (the two reads the report joins in-process).
 *
 * The one behavior most worth protecting: `highImpactRatePct` MUST be computed
 * against `matchedPublications`, never `totalPublications` — a wrong
 * denominator silently overstates confidence. See the "match-rate-vs-total"
 * test below, which is built so it fails if that denominator ever regresses.
 */
const hoisted = vi.hoisted(() => ({
  mockLoadMembers: vi.fn(),
  mockPubFindMany: vi.fn(),
  mockJifFindMany: vi.fn(),
}));

vi.mock("@/lib/api/centers", () => ({
  loadActiveCenterMemberCwids: hoisted.mockLoadMembers,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      publication: { findMany: hoisted.mockPubFindMany },
      journalImpactFactor: { findMany: hoisted.mockJifFindMany },
    },
  },
}));

import {
  HIGH_IMPACT_THRESHOLD,
  loadCancerCenterPublicationsReport,
  parseCategory,
} from "@/lib/edit/cancer-center-publications-report";

beforeEach(() => {
  hoisted.mockLoadMembers.mockReset();
  hoisted.mockPubFindMany.mockReset();
  hoisted.mockJifFindMany.mockReset();
});

describe("loadCancerCenterPublicationsReport — no members / no publications", () => {
  it("returns a zeroed report and never queries publications when the center has no active members", async () => {
    hoisted.mockLoadMembers.mockResolvedValue([]);

    const report = await loadCancerCenterPublicationsReport("MEYER");

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
    hoisted.mockLoadMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([]);

    const report = await loadCancerCenterPublicationsReport("MEYER");

    expect(report.totalPublications).toBe(0);
    expect(report.rows).toEqual([]);
    expect(hoisted.mockJifFindMany).not.toHaveBeenCalled();
  });
});

describe("loadCancerCenterPublicationsReport — zero matches", () => {
  it("reports a 0% match rate when no publication's journal matches", async () => {
    hoisted.mockLoadMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "A", journal: "Foo Journal", journalAbbrev: "Foo J", year: 2020 },
      { pmid: "2", title: "B", journal: "Bar Journal", journalAbbrev: "Bar J", year: 2021 },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([]);

    const report = await loadCancerCenterPublicationsReport("MEYER");

    expect(report.totalPublications).toBe(2);
    expect(report.matchedPublications).toBe(0);
    expect(report.matchRatePct).toBe(0);
    expect(report.highImpactCount).toBe(0);
    expect(report.highImpactRatePct).toBe(0);
    expect(report.rows).toEqual([]);
  });

  it("skips a publication with no journalAbbrev without querying it against JournalImpactFactor", async () => {
    hoisted.mockLoadMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "No abbrev", journal: "Some Journal", journalAbbrev: null, year: 2020 },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([]);

    const report = await loadCancerCenterPublicationsReport("MEYER");

    expect(report.totalPublications).toBe(1);
    expect(report.matchedPublications).toBe(0);
    // Nothing to look up — findMany must not even be called with an empty `in`.
    expect(hoisted.mockJifFindMany).not.toHaveBeenCalled();
  });
});

describe("loadCancerCenterPublicationsReport — partial matches", () => {
  it("computes highImpactRatePct against MATCHED count, never totalPublications", async () => {
    hoisted.mockLoadMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "High-IF match", journal: "Nature", journalAbbrev: "Nature", year: 2024 },
      { pmid: "2", title: "Low-IF match", journal: "Some Journal", journalAbbrev: "Some J", year: 2023 },
      { pmid: "3", title: "Unmatched A", journal: "Unknown Journal 1", journalAbbrev: "Unk J1", year: 2022 },
      { pmid: "4", title: "Unmatched B", journal: "Unknown Journal 2", journalAbbrev: "Unk J2", year: 2021 },
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

    const report = await loadCancerCenterPublicationsReport("MEYER");

    expect(report.totalPublications).toBe(4);
    expect(report.matchedPublications).toBe(2);
    expect(report.matchRatePct).toBe(50); // 2 / 4 total
    expect(report.highImpactCount).toBe(1); // only Nature (50.5 >= HIGH_IMPACT_THRESHOLD)
    // The one behavior most worth protecting: 1/2 MATCHED (50%), never 1/4 TOTAL
    // (25%) — a wrong denominator here silently overstates confidence.
    expect(report.highImpactRatePct).toBe(50);
    expect(report.highImpactRatePct).not.toBe((report.highImpactCount / report.totalPublications) * 100);

    expect(report.rows).toHaveLength(2);
    // impactScore1 desc — the high-IF match sorts first.
    expect(report.rows[0].pmid).toBe("1");
    expect(report.rows[0].impactScore1).toBe(50.5);
    expect(report.rows[1].pmid).toBe("2");
    expect(report.rows[1].impactScore1).toBe(3.2);
  });

  it("normalizes journalAbbrev (trim + uppercase) on both sides of the join", async () => {
    hoisted.mockLoadMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "Mixed case", journal: "N Engl J Med", journalAbbrev: "  n engl j med  ", year: 2020 },
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

    const report = await loadCancerCenterPublicationsReport("MEYER");

    expect(hoisted.mockJifFindMany).toHaveBeenCalledWith({
      where: { journalAbbrev: { in: ["N ENGL J MED"] } },
    });
    expect(report.matchedPublications).toBe(1);
    expect(report.rows[0].impactScore1).toBe(96.2);
  });

  it("treats a null impactScore1 as not high-impact without dropping the match", async () => {
    hoisted.mockLoadMembers.mockResolvedValue(["abc1234"]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "1", title: "New journal", journal: "New J", journalAbbrev: "New J", year: 2026 },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([
      { journalAbbrev: "NEW J", journalTitle: "New Journal", impactScore1: null, impactScore2: null, category: null },
    ]);

    const report = await loadCancerCenterPublicationsReport("MEYER");

    expect(report.matchedPublications).toBe(1);
    expect(report.highImpactCount).toBe(0);
    expect(report.rows[0].impactScore1).toBeNull();
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
