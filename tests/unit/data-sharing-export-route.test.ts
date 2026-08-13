/**
 * GET /edit/data-sharing/export — CSV download route gating + headers.
 * Mirrors `tests/unit/data-quality-export-route.test.ts`'s structure, minus
 * the query-param/scope machinery this dashboard doesn't have.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSession, mockEnabled, mockCanView, mockLoadRows, mockCap, mockCsv } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockCanView: vi.fn(),
  mockLoadRows: vi.fn(),
  mockCap: vi.fn(),
  mockCsv: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/edit/data-sharing-dashboard", () => ({
  isDataSharingDashboardEnabled: mockEnabled,
  canViewDataSharingDashboard: mockCanView,
}));
vi.mock("@/lib/api/data-sharing-report", () => ({
  loadDatasetLinkRows: mockLoadRows,
  capDatasetLinkRows: mockCap,
  buildDataSharingCsv: mockCsv,
}));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { GET } from "@/app/edit/data-sharing/export/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockSession.mockResolvedValue({ cwid: "edt1", isSuperuser: true, isCommsSteward: false });
  mockEnabled.mockReturnValue(true);
  mockCanView.mockReturnValue(true);
  mockLoadRows.mockResolvedValue([{ cwid: "fac1" }]);
  mockCap.mockReturnValue({ rows: [{ cwid: "fac1" }], total: 1, truncated: false });
  mockCsv.mockReturnValue("repository,cwid\r\nGEO,fac1\r\n");
});

describe("/edit/data-sharing/export gating", () => {
  it("404s when the flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(404);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("404s for a viewer who fails the view gate (not superuser/comms_steward)", async () => {
    mockCanView.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(404);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("returns a CSV attachment for an in-scope viewer", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="data-sharing-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("repository,cwid\r\nGEO,fac1\r\n");
    expect(mockCap).toHaveBeenCalledWith([{ cwid: "fac1" }]);
    expect(mockCsv).toHaveBeenCalledWith([{ cwid: "fac1" }]);
  });

  it("logs one export_data_sharing audit line with row/total/truncated counts", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockCap.mockReturnValue({ rows: [{ cwid: "fac1" }], total: 5001, truncated: true });
    await GET();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "export_data_sharing",
      cwid: "edt1",
      rows: 1,
      total: 5001,
      truncated: true,
    });
    expect(typeof logged.ts).toBe("string");
  });
});
