/**
 * `lib/api/data-quality.ts` — CSV export helpers
 * (buildDataQualityCsv, loadDataQualityExport).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDataQualityCsv,
  loadDataQualityExport,
  type DataQualityEntry,
} from "@/lib/api/data-quality";

type LoaderClient = Parameters<typeof loadDataQualityExport>[1];

function entry(over: Partial<DataQualityEntry> = {}): DataQualityEntry {
  return {
    cwid: "fac1",
    slug: "fac-one",
    name: "Ada, Faculty",
    title: "Professor",
    unit: "Medicine",
    roleCategory: "full_time_faculty",
    isChair: false,
    isChief: true,
    leadership: "Chief",
    leadershipTier: 2,
    isVisible: true,
    headshot: "present",
    hasOverview: true,
    overviewUpdatedAt: "2026-06-01T00:00:00.000Z",
    overviewState: "lt1yr",
    pendingCoiHigh: 0,
    pendingCoiMedium: 0,
    prominence: 10.567,
    editHref: "/edit/scholar/fac1",
    ...over,
  };
}

describe("buildDataQualityCsv", () => {
  it("always includes the base columns (rank/cwid/name/title/unit/person_type/leadership) plus prominence, regardless of the two flags", () => {
    const csv = buildDataQualityCsv([entry()], { includeProfileCols: false, includeCoi: false });
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("rank,cwid,name,title,unit,person_type,leadership,prominence");
    expect(lines[1].startsWith("1,fac1,")).toBe(true);
    expect(lines[1]).toContain('"Ada, Faculty"');
    expect(lines[1]).toContain(",Chief,");
    expect(lines[1].endsWith(",10.57")).toBe(true);
  });

  it("profile-cols-only: headshot/has_overview/overview_updated/visible present, no COI columns", () => {
    const csv = buildDataQualityCsv(
      [
        entry({
          leadership: "Dean",
          isVisible: true,
          headshot: "missing",
          hasOverview: false,
          overviewUpdatedAt: null,
          overviewState: "never",
        }),
      ],
      { includeProfileCols: true, includeCoi: false },
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "rank,cwid,name,title,unit,person_type,leadership,visible,headshot,has_overview,overview_updated,prominence",
    );
    expect(lines[1]).toContain(",Dean,yes,missing,no,,10.57");
    // No COI columns anywhere in the row — not just absent from the header.
    expect(lines[0]).not.toContain("pending_coi");
    expect(lines[1]).not.toContain("pending_coi");
  });

  it("profile-cols-only: an imported (un-edited) overview renders the 'imported' cell", () => {
    const csv = buildDataQualityCsv(
      [entry({ hasOverview: true, overviewUpdatedAt: null, overviewState: "imported" })],
      { includeProfileCols: true, includeCoi: false },
    );
    expect(csv.split("\r\n")[1]).toContain(",yes,imported,");
  });

  it("profile-cols-only: a dated overview renders YYYY-MM-DD (date-only, no time)", () => {
    const csv = buildDataQualityCsv(
      [entry({ hasOverview: true, overviewUpdatedAt: "2025-03-14T12:34:56.000Z", overviewState: "lt1yr" })],
      { includeProfileCols: true, includeCoi: false },
    );
    expect(csv.split("\r\n")[1]).toContain(",2025-03-14,");
  });

  it("coi-only: pending_coi_high/pending_coi_medium present, no profile columns", () => {
    const csv = buildDataQualityCsv(
      [
        entry({
          leadership: "Chair",
          isChair: true,
          isChief: false,
          pendingCoiHigh: 2,
          pendingCoiMedium: 1,
        }),
      ],
      { includeProfileCols: false, includeCoi: true },
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "rank,cwid,name,title,unit,person_type,leadership,pending_coi_high,pending_coi_medium,prominence",
    );
    expect(lines[1]).toContain(",Chair,2,1,10.57");
    // No profile columns anywhere in the row.
    expect(lines[0]).not.toContain("visible");
    expect(lines[0]).not.toContain("headshot");
    expect(lines[0]).not.toContain("has_overview");
    expect(lines[0]).not.toContain("overview_updated");
  });

  it("both true: profile columns then COI columns, in that order, before prominence", () => {
    const csv = buildDataQualityCsv(
      [
        entry({
          isVisible: false,
          headshot: "unknown",
          hasOverview: true,
          overviewUpdatedAt: null,
          overviewState: "imported",
          pendingCoiHigh: 3,
          pendingCoiMedium: 0,
        }),
      ],
      { includeProfileCols: true, includeCoi: true },
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "rank,cwid,name,title,unit,person_type,leadership,visible,headshot,has_overview,overview_updated,pending_coi_high,pending_coi_medium,prominence",
    );
    expect(lines[1]).toContain(",no,unknown,yes,imported,3,0,10.57");
  });

  it("renders a non-leader with an empty leadership cell", () => {
    const csv = buildDataQualityCsv([entry({ isChief: false, isChair: false, leadership: null })], {
      includeProfileCols: true,
      includeCoi: false,
    });
    expect(csv.split("\r\n")[1]).toContain(",,yes,"); // empty leadership between person_type and visible
  });

  it("renders a hidden (suppressed) scholar with visible=no", () => {
    const csv = buildDataQualityCsv([entry({ isVisible: false })], {
      includeProfileCols: true,
      includeCoi: false,
    });
    expect(csv.split("\r\n")[1]).toContain(",no,");
  });
});

/** Minimal fake client — empty aggregates, N scholars. */
function fakeClient(scholars: unknown[]) {
  return {
    scholar: { findMany: vi.fn().mockResolvedValue(scholars) },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: vi.fn().mockResolvedValue([]) },
    center: { findMany: vi.fn().mockResolvedValue([]) },
    grant: { groupBy: vi.fn().mockResolvedValue([]) },
    coiGapCandidate: { groupBy: vi.fn().mockResolvedValue([]) },
    fieldOverride: { findMany: vi.fn().mockResolvedValue([]) },
    centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
    divisionMembership: { findMany: vi.fn().mockResolvedValue([]) },
    overviewProvenance: { findMany: vi.fn().mockResolvedValue([]) },
  };
}
const scholarRow = (i: number) => ({
  cwid: `s${i}`,
  slug: `s${i}`,
  preferredName: `S${String(i).padStart(3, "0")}`,
  primaryTitle: null,
  roleCategory: "full_time_faculty",
  status: "active",
  overview: null,
  hIndex: null,
  scoredPubCount: 100 - i,
  hasHeadshot: null,
  department: null,
  division: null,
});

beforeEach(() => vi.clearAllMocks());

describe("loadDataQualityExport", () => {
  it("returns ALL filtered rows (unpaginated), prominence-sorted, not truncated", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => scholarRow(i));
    const c = fakeClient(rows);
    const out = await loadDataQualityExport({ scope: { all: true } }, c as unknown as LoaderClient);
    expect(out.total).toBe(120);
    expect(out.rows).toHaveLength(120); // not capped to a page of 50
    expect(out.truncated).toBe(false);
    // higher scoredPubCount (lower index) ranks first
    expect(out.rows[0].cwid).toBe("s0");
    expect(out.rows[119].cwid).toBe("s119");
  });

  it("carries isVisible through from Scholar.status", async () => {
    const rows = [
      { ...scholarRow(0), status: "active" },
      { ...scholarRow(1), status: "suppressed" },
    ];
    const c = fakeClient(rows);
    const out = await loadDataQualityExport({ scope: { all: true } }, c as unknown as LoaderClient);
    const byCwid = new Map(out.rows.map((r) => [r.cwid, r]));
    expect(byCwid.get("s0")?.isVisible).toBe(true);
    expect(byCwid.get("s1")?.isVisible).toBe(false);
  });

  it("classifies headshot/overview presence from Scholar.hasHeadshot/overview", async () => {
    const rows = [
      { ...scholarRow(0), hasHeadshot: true, overview: "Bio text" },
      { ...scholarRow(1), hasHeadshot: false, overview: null },
      { ...scholarRow(2), hasHeadshot: null, overview: null },
    ];
    const c = fakeClient(rows);
    const out = await loadDataQualityExport({ scope: { all: true } }, c as unknown as LoaderClient);
    const byCwid = new Map(out.rows.map((r) => [r.cwid, r]));
    expect(byCwid.get("s0")?.headshot).toBe("present");
    expect(byCwid.get("s0")?.hasOverview).toBe(true);
    expect(byCwid.get("s1")?.headshot).toBe("missing");
    expect(byCwid.get("s1")?.hasOverview).toBe(false);
    expect(byCwid.get("s2")?.headshot).toBe("unknown");
  });
});
