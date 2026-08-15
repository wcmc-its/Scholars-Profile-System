/**
 * GET /edit/scholars/export — CSV download route gating + headers (the
 * Profiles roster's export; formerly the standalone Data Quality dashboard's
 * `/edit/data-quality/export`, see `app/edit/scholars/export/route.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { DataQualityEntry } from "@/lib/api/data-quality";

const { mockSession, mockEnabled, mockScope, mockEmpty, mockExport } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockScope: vi.fn(),
  mockEmpty: vi.fn(),
  mockExport: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/edit/data-quality", () => ({
  isDataQualityDashboardEnabled: mockEnabled,
  isEmptyScope: mockEmpty,
  loadDataQualityScope: mockScope,
}));
vi.mock("@/lib/api/data-quality", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api/data-quality")>();
  return {
    ...actual, // keep the real parseDataQualityParams + buildDataQualityCsv, so
    // param threading AND the actual CSV header row (COI columns present/absent)
    // are exercised, not just what a mock was told to return.
    loadDataQualityExport: mockExport,
  };
});
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { GET } from "@/app/edit/scholars/export/route";

const req = (qs = "") => new NextRequest(`http://localhost/edit/scholars/export${qs}`);

const ROW: DataQualityEntry = {
  cwid: "fac1",
  slug: "fac1-slug",
  name: "Fac One",
  title: "Professor",
  unit: "Medicine",
  roleCategory: "full_time_faculty",
  isChair: false,
  isChief: false,
  leadership: null,
  leadershipTier: 3,
  isVisible: true,
  pendingCoiHigh: 2,
  pendingCoiMedium: 1,
  prominence: 4.2,
  editHref: "/edit/scholar/fac1",
};

function headerRow(csv: string): string {
  return csv.split("\r\n")[0] ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockSession.mockResolvedValue({ cwid: "edt1", isSuperuser: true, isCommsSteward: false });
  mockEnabled.mockReturnValue(true);
  mockScope.mockResolvedValue({ all: true });
  mockEmpty.mockReturnValue(false);
  mockExport.mockResolvedValue({ rows: [ROW], total: 1, truncated: false });
});

describe("/edit/scholars/export gating", () => {
  it("401s with no session", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("404s for an empty scope (a plain scholar)", async () => {
    mockScope.mockResolvedValue({ all: false, unitCodes: [], centerCodes: [] });
    mockEmpty.mockReturnValue(true);
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("does NOT 404 when EDIT_DATA_QUALITY_DASHBOARD is off — the route itself is never flag-gated", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockExport).toHaveBeenCalled();
  });

  it("includes COI columns for a superuser with the flag on", async () => {
    const res = await GET(req());
    const header = headerRow(await res.text());
    expect(header).toContain("pending_coi_high");
    expect(header).toContain("pending_coi_medium");
  });

  it("omits COI columns for a superuser with the flag off, and forces gap to 'all' despite ?gap=has-coi", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(req("?gap=has-coi"));
    const header = headerRow(await res.text());
    expect(header).not.toContain("pending_coi_high");
    expect(header).not.toContain("pending_coi_medium");
    // The row set itself must not be narrowed by the query either — the flag
    // being off forces `gap: "all"` server-side, not just the column withheld.
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({ gap: "all" }),
      expect.anything(),
    );
  });

  it("omits COI columns for a non-superuser unit Owner/Curator regardless of flag, and forces gap to 'all' despite ?gap=has-coi", async () => {
    mockSession.mockResolvedValue({ cwid: "own1", isSuperuser: false, isCommsSteward: false });
    mockScope.mockResolvedValue({ all: false, unitCodes: ["MED"], centerCodes: [] });
    mockEmpty.mockReturnValue(false);
    mockEnabled.mockReturnValue(true); // flag ON — still not a superuser, so still no COI
    const res = await GET(req("?gap=has-coi"));
    const header = headerRow(await res.text());
    expect(header).not.toContain("pending_coi_high");
    expect(header).not.toContain("pending_coi_medium");
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({ gap: "all" }),
      expect.anything(),
    );
  });

  it("sets the profiles-<date>.csv attachment headers", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="profiles-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("threads the multi-value query-param filters into the export loader", async () => {
    await GET(req("?q=harr&type=postdoc&type=staff&unit=dept:MED&unit=center:MCC&gap=has-coi&hidden=0"));
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "harr",
        roleCategories: ["postdoc", "staff"],
        units: [
          { kind: "department", code: "MED" },
          { kind: "center", code: "MCC" },
        ],
        gap: "has-coi", // a superuser with the flag on — nothing forces it to "all" here
        includeHidden: false,
      }),
      expect.anything(),
    );
  });
});
