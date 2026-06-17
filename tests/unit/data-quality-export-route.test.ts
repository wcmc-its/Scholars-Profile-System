/**
 * GET /edit/data-quality/export — CSV download route gating + headers
 * (docs/data-quality-dashboard-spec.md §10).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSession, mockEnabled, mockScope, mockEmpty, mockExport, mockCsv } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockScope: vi.fn(),
  mockEmpty: vi.fn(),
  mockExport: vi.fn(),
  mockCsv: vi.fn(),
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
    ...actual, // keep the real parseDataQualityParams so param threading is exercised
    loadDataQualityExport: mockExport,
    buildDataQualityCsv: mockCsv,
  };
});
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { GET } from "@/app/edit/data-quality/export/route";

const req = (qs = "") => new NextRequest(`http://localhost/edit/data-quality/export${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockSession.mockResolvedValue({ cwid: "edt1", isSuperuser: true, isCommsSteward: false });
  mockEnabled.mockReturnValue(true);
  mockScope.mockResolvedValue({ all: true });
  mockEmpty.mockReturnValue(false);
  mockExport.mockResolvedValue({ rows: [{ cwid: "fac1" }], total: 1, truncated: false });
  mockCsv.mockReturnValue("rank,cwid\r\n1,fac1\r\n");
});

describe("/edit/data-quality/export gating", () => {
  it("404s when the flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("404s for an empty scope (a plain scholar)", async () => {
    mockScope.mockResolvedValue({ all: false, unitCodes: [], centerCodes: [] });
    mockEmpty.mockReturnValue(true);
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("returns a CSV attachment for an in-scope viewer", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="data-quality-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("rank,cwid\r\n1,fac1\r\n");
  });

  it("threads the multi-value query-param filters into the export loader", async () => {
    await GET(req("?q=harr&type=postdoc&type=staff&unit=dept:MED&unit=center:MCC&gap=no-headshot&overviewAge=imported&hidden=0"));
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "harr",
        roleCategories: ["postdoc", "staff"],
        units: [
          { kind: "department", code: "MED" },
          { kind: "center", code: "MCC" },
        ],
        gap: "no-headshot",
        overviewAge: "imported",
        includeHidden: false,
      }),
      expect.anything(),
    );
  });
});
