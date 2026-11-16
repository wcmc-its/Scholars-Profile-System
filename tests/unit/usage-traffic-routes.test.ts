/**
 * GET /api/edit/usage/traffic (one list page) and GET
 * /api/edit/usage/traffic/export (the workbook): the usage gate, param
 * validation, the range passed through, and fail-soft on an Athena error.
 */
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  canView: vi.fn(),
  logDenial: vi.fn(),
  runQuery: vi.fn(),
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/edit/dashboard-access", () => ({ canViewDashboard: h.canView }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: h.logDenial }));
vi.mock("@/lib/analytics/athena-client", () => ({ runUsageQuery: h.runQuery }));
// unstable_cache needs Next's incremental cache; run the loader directly.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
}));

import { GET as listGET } from "@/app/api/edit/usage/traffic/route";
import { GET as exportGET } from "@/app/api/edit/usage/traffic/export/route";

const listReq = (qs: string) => new NextRequest(`http://localhost/api/edit/usage/traffic?${qs}`);
const exportReq = (qs: string) =>
  new NextRequest(`http://localhost/api/edit/usage/traffic/export?${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.session.mockResolvedValue({ cwid: "adm001", isSuperuser: true });
  h.canView.mockResolvedValue(true);
  h.runQuery.mockResolvedValue([]);
});

describe("GET /api/edit/usage/traffic", () => {
  it("401 without a session, 403 for a viewer without usage access", async () => {
    h.session.mockResolvedValueOnce(null);
    expect((await listGET(listReq("list=referrers"))).status).toBe(401);
    h.canView.mockResolvedValueOnce(false);
    const res = await listGET(listReq("list=referrers"));
    expect(res.status).toBe(403);
    expect(h.canView).toHaveBeenLastCalledWith(expect.anything(), "usage");
    expect(h.logDenial).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/edit/usage/traffic", targetCwid: "usage" }),
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("400 on an unknown list, category, kind, AI class or offset", async () => {
    for (const qs of [
      "list=nope",
      "list=referrers&cats=WCM,Bogus",
      "list=referrers&view=table",
      "list=pages&kind=edit",
      "list=pages&ai=fetch,human",
      "list=referrers&offset=-1",
      "list=referrers&offset=1e3",
    ]) {
      expect((await listGET(listReq(qs))).status, qs).toBe(400);
    }
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("returns one shaped page for the page's range", async () => {
    h.runQuery.mockResolvedValueOnce([
      { ref: "www.google.com", category: "Search engines", visits: "10", total: "2" },
      { ref: "news.weill.cornell.edu", category: "WCM", visits: "3", total: "2" },
    ]);
    const res = await listGET(
      listReq(
        "list=referrers&view=site&cats=WCM,Search%20engines&q=news&offset=25&range=custom&from=2026-10-01&to=2026-10-31",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [
        { label: "www.google.com", category: "Search engines", visits: 10 },
        { label: "news.weill.cornell.edu", category: "WCM", visits: 3 },
      ],
      total: 2,
    });
    const sql = h.runQuery.mock.calls[0][0] as string;
    expect(sql).toContain("dt >= '2026-10-01' AND dt <= '2026-10-31'");
    expect(sql).toContain("category IN ('Search engines', 'WCM')");
    expect(sql).toContain("strpos(lower(ref), 'news') > 0");
    expect(sql).toContain("OFFSET 25 LIMIT 25");
  });

  it("reads landing pages when sources are chosen", async () => {
    await listGET(listReq("list=pages&kind=profile&cats=WCM&ai=crawler"));
    const sql = h.runQuery.mock.calls[0][0] as string;
    expect(sql).toContain("metric = 'landing'");
    expect(sql).toContain("metric = 'ai_landing'");
  });

  it("500 when Athena fails", async () => {
    h.runQuery.mockRejectedValueOnce(new Error("athena down"));
    expect((await listGET(listReq("list=pages"))).status).toBe(500);
  });
});

describe("GET /api/edit/usage/traffic/export", () => {
  it("403 for a viewer without usage access", async () => {
    h.canView.mockResolvedValueOnce(false);
    expect((await exportGET(exportReq("range=30"))).status).toBe(403);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("returns a workbook with every sheet", async () => {
    const res = await exportGET(
      exportReq("range=custom&from=2026-10-01&to=2026-10-31&grain=month"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="scholars-usage-2026-10-01-to-2026-10-31.xlsx"',
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Summary",
      "Sources by month",
      "Referring sites",
      "Referring pages",
      "Top pages",
      "Landing pages",
      "AI",
    ]);
    // Six overview queries + four unpaged list queries.
    expect(h.runQuery).toHaveBeenCalledTimes(10);
  });

  it("500 when Athena fails", async () => {
    h.runQuery.mockRejectedValue(new Error("athena down"));
    expect((await exportGET(exportReq("range=30"))).status).toBe(500);
  });
});
