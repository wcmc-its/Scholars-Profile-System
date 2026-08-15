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
    pendingCoiHigh: 0,
    pendingCoiMedium: 0,
    prominence: 10.567,
    editHref: "/edit/scholar/fac1",
    ...over,
  };
}

describe("buildDataQualityCsv", () => {
  it("emits the header and rank/leadership/visible/pending-coi/prominence, quoting commas, when includeCoi is true", () => {
    const csv = buildDataQualityCsv(
      [
        entry({ leadership: "Dean", pendingCoiHigh: 0, pendingCoiMedium: 1 }),
        entry({
          cwid: "fac2",
          name: "Ben Chair",
          isChair: true,
          isChief: false,
          leadership: "Chair",
          isVisible: false,
          pendingCoiHigh: 2,
          pendingCoiMedium: 0,
        }),
      ],
      { includeCoi: true },
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "rank,cwid,name,title,unit,person_type,leadership,visible,pending_coi_high,pending_coi_medium,prominence",
    );
    // Row 1: rank 1, name with a comma is quoted, Dean label, visible, COI counts, prominence to 2dp.
    expect(lines[1].startsWith("1,fac1,")).toBe(true);
    expect(lines[1]).toContain('"Ada, Faculty"');
    expect(lines[1]).toContain(",Dean,yes,0,1,");
    expect(lines[1].endsWith(",10.57")).toBe(true);
    // Row 2: rank 2, Chair, hidden (visible=no), 2 high-tier COI.
    expect(lines[2].startsWith("2,fac2,")).toBe(true);
    expect(lines[2]).toContain(",Chair,no,2,0,");
  });

  it("omits the COI columns entirely when includeCoi is false", () => {
    const csv = buildDataQualityCsv(
      [entry({ leadership: "Dean", pendingCoiHigh: 3, pendingCoiMedium: 2 })],
      { includeCoi: false },
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("rank,cwid,name,title,unit,person_type,leadership,visible,prominence");
    // The COI counts never appear anywhere in the row — not just hidden from
    // the header, actually absent from the serialized cells.
    expect(lines[1]).not.toContain("3");
    expect(lines[1]).not.toContain(",2,");
    expect(lines[1]).toContain(",Dean,yes,10.57");
  });

  it("renders a non-leader with an empty leadership cell", () => {
    const csv = buildDataQualityCsv([entry({ isChief: false, isChair: false, leadership: null })], {
      includeCoi: true,
    });
    expect(csv.split("\r\n")[1]).toContain(",,yes,"); // empty leadership between person_type and visible
  });

  it("renders a hidden (suppressed) scholar with visible=no", () => {
    const csv = buildDataQualityCsv([entry({ isVisible: false })], { includeCoi: false });
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
    centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
  };
}
const scholarRow = (i: number) => ({
  cwid: `s${i}`,
  slug: `s${i}`,
  preferredName: `S${String(i).padStart(3, "0")}`,
  primaryTitle: null,
  roleCategory: "full_time_faculty",
  status: "active",
  hIndex: null,
  scoredPubCount: 100 - i,
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
});
