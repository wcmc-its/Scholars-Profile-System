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
    headshot: "present",
    hasOverview: true,
    overviewUpdatedAt: null,
    overviewState: "imported",
    pendingCoiHigh: 0,
    pendingCoiMedium: 1,
    prominence: 10.567,
    editHref: "/edit/scholar/fac1",
    ...over,
  };
}

describe("buildDataQualityCsv", () => {
  it("emits the header and rank/leadership/overview_updated/prominence, quoting commas", () => {
    const csv = buildDataQualityCsv([
      entry({ leadership: "Dean", overviewState: "lt1yr", overviewUpdatedAt: "2026-06-01T12:00:00.000Z" }),
      entry({
        cwid: "fac2",
        name: "Ben Chair",
        isChair: true,
        isChief: false,
        leadership: "Chair",
        headshot: "missing",
        hasOverview: false,
        overviewState: "never",
        overviewUpdatedAt: null,
        pendingCoiHigh: 2,
      }),
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "rank,cwid,name,title,unit,person_type,leadership,headshot,has_overview,overview_updated,pending_coi_high,pending_coi_medium,prominence",
    );
    // Row 1: rank 1, name with a comma is quoted, Dean label, edit date (YYYY-MM-DD), prominence to 2dp.
    expect(lines[1].startsWith("1,fac1,")).toBe(true);
    expect(lines[1]).toContain('"Ada, Faculty"');
    expect(lines[1]).toContain(",Dean,present,yes,2026-06-01,0,1,");
    expect(lines[1].endsWith(",10.57")).toBe(true);
    // Row 2: rank 2, Chair, missing headshot, no overview (empty overview_updated), 2 COI.
    expect(lines[2].startsWith("2,fac2,")).toBe(true);
    expect(lines[2]).toContain(",Chair,missing,no,,2,");
  });

  it("an imported (un-edited) overview shows 'imported' in overview_updated", () => {
    const csv = buildDataQualityCsv([entry({ overviewState: "imported", overviewUpdatedAt: null })]);
    expect(csv.split("\r\n")[1]).toContain(",present,yes,imported,");
  });

  it("renders a non-leader with an empty leadership cell", () => {
    const csv = buildDataQualityCsv([entry({ isChief: false, isChair: false, leadership: null })]);
    expect(csv.split("\r\n")[1]).toContain(",,present,"); // empty leadership between person_type and headshot
  });
});

/** Minimal fake client — empty aggregates, N scholars. */
function fakeClient(scholars: unknown[]) {
  return {
    scholar: { findMany: vi.fn().mockResolvedValue(scholars) },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: vi.fn().mockResolvedValue([]) },
    grant: { groupBy: vi.fn().mockResolvedValue([]) },
    coiGapCandidate: { groupBy: vi.fn().mockResolvedValue([]) },
    fieldOverride: { findMany: vi.fn().mockResolvedValue([]) },
    overviewProvenance: { findMany: vi.fn().mockResolvedValue([]) },
    centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
  };
}
const scholarRow = (i: number) => ({
  cwid: `s${i}`,
  slug: `s${i}`,
  preferredName: `S${String(i).padStart(3, "0")}`,
  primaryTitle: null,
  roleCategory: "full_time_faculty",
  overview: "bio",
  hIndex: null,
  scoredPubCount: 100 - i,
  hasHeadshot: true,
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
});
