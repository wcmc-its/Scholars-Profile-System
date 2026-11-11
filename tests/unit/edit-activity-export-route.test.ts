/** GET /api/edit/activity/export — gate, asOf validation, CSV response. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSession, mockCanView, mockCsv, mockLogDenial } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockCanView: vi.fn(),
  mockCsv: vi.fn(),
  mockLogDenial: vi.fn(),
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/edit/dashboard-access", () => ({ canViewDashboard: mockCanView }));
vi.mock("@/lib/db", () => ({ db: { read: { tag: "read-client" } } }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogDenial }));
vi.mock("@/lib/edit/directory-names", () => ({ resolveDirectoryPeople: vi.fn() }));
vi.mock("@/lib/api/edit-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/edit-activity")>()),
  loadEditActivityCsv: mockCsv,
}));

import { GET } from "@/app/api/edit/activity/export/route";

const AS_OF = "2026-11-11T12:00:00.000Z";
const req = (qs: string) => new NextRequest(`http://localhost/api/edit/activity/export${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.mockResolvedValue({ cwid: "su0001" });
  mockCanView.mockResolvedValue(true);
  mockCsv.mockResolvedValue("time,editor_cwid\r\nx,y");
});

describe("GET /api/edit/activity/export", () => {
  it("401 without a session, 403 without the dashboard grant", async () => {
    mockSession.mockResolvedValueOnce(null);
    expect((await GET(req(`?asOf=${AS_OF}`))).status).toBe(401);
    mockCanView.mockResolvedValueOnce(false);
    expect((await GET(req(`?asOf=${AS_OF}`))).status).toBe(403);
    expect(mockCsv).not.toHaveBeenCalled();
  });

  it("400 on a missing or malformed asOf", async () => {
    expect((await GET(req("?range=all"))).status).toBe(400);
    expect((await GET(req("?range=all&asOf=yesterday"))).status).toBe(400);
  });

  it("returns the range's CSV as an attachment", async () => {
    const res = await GET(req(`?range=12m&asOf=${AS_OF}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="edit-activity-12m-2026-11-11.csv"');
    expect(await res.text()).toBe("time,editor_cwid\r\nx,y");
    expect(mockCsv).toHaveBeenCalledWith({ tag: "read-client" }, "12m", new Date(AS_OF), expect.any(Function));
  });

  it("500 when the audit read fails", async () => {
    mockCsv.mockRejectedValueOnce(new Error("SELECT command denied"));
    expect((await GET(req(`?asOf=${AS_OF}`))).status).toBe(500);
  });
});
