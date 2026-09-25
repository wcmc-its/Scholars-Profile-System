/**
 * GET /api/edit/reports/clinical-trials — report 5's `.xlsx`. The gate is the
 * page's (401 no session, 400 no center, 404 not a report-5 center, 403
 * `canEditUnit` denied and logged, 403 retired via `loadReportsContext`), and
 * the workbook follows the same query string as the page. The loader and the
 * unit-context gate are mocked; `canEditUnit` is the real one.
 */
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  identity: vi.fn(),
  centerFind: vi.fn(),
  programFind: vi.fn(),
  role: vi.fn(),
  deny: vi.fn(),
  ctx: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: { center: { findUnique: h.centerFind }, centerProgram: { findFirst: h.programFind } },
    write: {},
  },
  prisma: {},
}));
vi.mock("@/lib/edit/request", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/request")>()),
  resolveEditIdentity: h.identity,
}));
vi.mock("@/lib/edit/authz", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/authz")>()),
  getEffectiveUnitRole: h.role,
  logEditDenial: h.deny,
}));
vi.mock("@/lib/edit/cancer-center-reports", () => ({ loadReportsContext: h.ctx }));
vi.mock("@/lib/center-collaboration/clinical-trials-report", () => ({
  loadClinicalTrialsReport: h.load,
}));

import { GET } from "@/app/api/edit/reports/clinical-trials/route";

const session = { cwid: "cur0001", isSuperuser: false, isCommsSteward: false };
const req = (qs: string) =>
  new NextRequest(`http://localhost/api/edit/reports/clinical-trials?${qs}`);

function link(
  protocolNumber: string,
  status: string,
  cwid = "aaa1001",
  sponsorClass: string | null = "industry",
) {
  return {
    cwid,
    personName: `Person ${cwid}`,
    department: "Medicine",
    role: "Principal Investigator",
    protocolNumber,
    nctNumber: null,
    title: `Trial ${protocolNumber}`,
    phase: "PHASE2",
    principalSponsor: "Acme",
    sponsorClass,
    status,
    isActive: status === "OPEN TO ACCRUAL",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.identity.mockResolvedValue({ session, realCwid: "cur0001", impersonatedCwid: null });
  h.centerFind.mockResolvedValue({ code: "CC" });
  h.programFind.mockResolvedValue({ centerCode: "CC" });
  h.role.mockResolvedValue("curator");
  h.ctx.mockResolvedValue({ unit: { name: "Test Center" } });
  h.load.mockResolvedValue([
    link("P-1", "OPEN TO ACCRUAL"),
    link("P-2", "SUSPENDED", "bbb2002", null),
  ]);
});

describe("GET /api/edit/reports/clinical-trials — gate", () => {
  it("401 without a session", async () => {
    h.identity.mockResolvedValue(null);
    expect((await GET(req("center=CC"))).status).toBe(401);
  });

  it("400 without a center", async () => {
    expect((await GET(req(""))).status).toBe(400);
  });

  it("404 for a center report 5 does not serve (no CenterProgram taxonomy)", async () => {
    h.programFind.mockResolvedValue(null);
    expect((await GET(req("center=CC"))).status).toBe(404);
    h.programFind.mockResolvedValue({ centerCode: "CC" });
    h.centerFind.mockResolvedValue(null);
    expect((await GET(req("center=CC"))).status).toBe(404);
    expect(h.load).not.toHaveBeenCalled();
  });

  it("403 and a logged denial when canEditUnit refuses", async () => {
    h.role.mockResolvedValue("none");
    const res = await GET(req("center=CC"));
    expect(res.status).toBe(403);
    expect(h.deny).toHaveBeenCalledWith(
      expect.objectContaining({ targetEntityId: "CC", reason: "not_curator" }),
    );
    expect(h.load).not.toHaveBeenCalled();
  });

  it("403 when the page's unit gate refuses (e.g. a retired center)", async () => {
    h.ctx.mockResolvedValue(null);
    expect((await GET(req("center=CC"))).status).toBe(403);
    expect(h.load).not.toHaveBeenCalled();
  });

  it("a superuser passes without a unit role", async () => {
    h.identity.mockResolvedValue({
      session: { ...session, isSuperuser: true },
      realCwid: "su",
      impersonatedCwid: null,
    });
    h.role.mockResolvedValue("none");
    expect((await GET(req("center=CC"))).status).toBe(200);
  });
});

describe("GET /api/edit/reports/clinical-trials — workbook", () => {
  it("sends an .xlsx narrowed by the page's filters", async () => {
    const res = await GET(req("center=CC&status=suspended"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="Clinical trials CC \d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(h.load).toHaveBeenCalledWith(expect.anything(), "CC");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const trials = wb.getWorksheet("Trials")!;
    expect(trials.rowCount).toBe(2);
    expect(trials.getRow(2).getCell(1).value).toBe("P-2");
    const criteria = Object.fromEntries(
      (wb.getWorksheet("Criteria")!.getSheetValues().filter(Boolean) as unknown[][]).map((r) => [
        r[1],
        r[2],
      ]),
    );
    expect(criteria).toMatchObject({ Center: "Test Center", Status: "Temporarily suspended" });
  });

  it("narrows the .xlsx by sponsor type, with a Sponsor type column and criterion", async () => {
    const res = await GET(req("center=CC&sponsorType=industry"));
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const trials = wb.getWorksheet("Trials")!;
    expect(trials.rowCount).toBe(2);
    expect(trials.getRow(1).getCell(5).value).toBe("Sponsor type");
    expect(trials.getRow(2).getCell(1).value).toBe("P-1");
    expect(trials.getRow(2).getCell(5).value).toBe("Industry");
    const criteria = Object.fromEntries(
      (wb.getWorksheet("Criteria")!.getSheetValues().filter(Boolean) as unknown[][]).map((r) => [
        r[1],
        r[2],
      ]),
    );
    expect(criteria["Sponsor type"]).toBe("Industry");
  });
});
