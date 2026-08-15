/**
 * GET /edit/coi/export — CSV download route gating + headers for the COI
 * dashboard (`app/edit/coi/export/route.ts`). Same gate as the page:
 * superuser + `EDIT_DATA_QUALITY_DASHBOARD` on, else the route pretends not
 * to exist (401 with no session, 404 otherwise). Scope is always
 * `{ all: true }` — no `loadDataQualityScope` call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { DataQualityEntry } from "@/lib/api/data-quality";

const { mockSession, mockEnabled, mockExport } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockExport: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/edit/data-quality", () => ({ isDataQualityDashboardEnabled: mockEnabled }));
vi.mock("@/lib/api/data-quality", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api/data-quality")>();
  return {
    ...actual, // keep the real parseDataQualityParams + buildDataQualityCsv, so
    // param threading AND the actual CSV header row (COI columns present, no
    // Profiles columns) are exercised, not just what a mock was told to return.
    loadDataQualityExport: mockExport,
  };
});
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { GET } from "@/app/edit/coi/export/route";

const req = (qs = "") => new NextRequest(`http://localhost/edit/coi/export${qs}`);

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
  headshot: "present",
  hasOverview: true,
  overviewUpdatedAt: "2026-01-01T00:00:00.000Z",
  overviewState: "lt1yr",
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
  mockExport.mockResolvedValue({ rows: [ROW], total: 1, truncated: false });
});

describe("/edit/coi/export gating", () => {
  it("401s with no session", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("404s for a non-superuser, even with the flag on", async () => {
    mockSession.mockResolvedValue({ cwid: "stw1", isSuperuser: false, isCommsSteward: true });
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("404s for a superuser with the flag off", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("200s for a superuser with the flag on, and the export is unscoped ({ all: true })", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const [opts] = mockExport.mock.calls[0];
    expect(opts.scope).toEqual({ all: true });
  });

  it("includes pending_coi_high/pending_coi_medium and omits visible/headshot/has_overview/overview_updated", async () => {
    const res = await GET(req());
    const header = headerRow(await res.text());
    expect(header).toContain("pending_coi_high");
    expect(header).toContain("pending_coi_medium");
    expect(header).not.toContain("visible");
    expect(header).not.toContain("headshot");
    expect(header).not.toContain("has_overview");
    expect(header).not.toContain("overview_updated");
  });

  it("silently sanitizes a Profiles-only gap value (?gap=no-headshot) down to 'all'", async () => {
    await GET(req("?gap=no-headshot"));
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({ gap: "all" }),
      expect.anything(),
    );
  });

  it("passes ?gap=has-coi straight through", async () => {
    await GET(req("?gap=has-coi"));
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({ gap: "has-coi" }),
      expect.anything(),
    );
  });

  it("sets the coi-<date>.csv attachment headers", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="coi-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("threads the multi-value query-param filters into the export loader", async () => {
    await GET(req("?q=harr&type=postdoc&type=staff&unit=dept:MED&unit=center:MCC&hidden=0"));
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "harr",
        roleCategories: ["postdoc", "staff"],
        units: [
          { kind: "department", code: "MED" },
          { kind: "center", code: "MCC" },
        ],
        includeHidden: false,
      }),
      expect.anything(),
    );
  });
});
