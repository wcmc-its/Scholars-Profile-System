/**
 * Report 1's two `.xlsx` routes:
 *   GET /api/edit/center/[code]/collab-report/xlsx     — one sheet per list +
 *     Criteria, for the URL's thresholds/filters; a list over
 *     SCHOLAR_EXPORT_CAP is withheld (note row), never truncated.
 *   GET /api/edit/center/[code]/collab-report/selected — the ticked CWIDs;
 *     refused above the cap, and every CWID must be this center's candidate.
 * Both behind the shared gate (401 / 404 / 403 + logged denial). The loader
 * (`loadCollabReportRows`) runs for real against mocked Prisma reads, so the
 * program-name join and refreshed stamp are covered too.
 */
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  centerFindUnique: vi.fn(),
  unitAdminFindMany: vi.fn(),
  candidateFindMany: vi.fn(),
  scholarFindMany: vi.fn(),
  programFindMany: vi.fn(),
  logEditDenial: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: h.session }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.session,
  impersonationActive: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => {
    const s = await h.session();
    return s ? { cwid: s.cwid, iat: 0, exp: 0 } : null;
  }),
}));
vi.mock("@/lib/edit/authz", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/authz")>()),
  logEditDenial: h.logEditDenial,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      center: { findUnique: h.centerFindUnique },
      unitAdmin: { findMany: h.unitAdminFindMany },
      centerCollabCandidate: { findMany: h.candidateFindMany },
      scholar: { findMany: h.scholarFindMany },
      centerProgram: { findMany: h.programFindMany },
    },
  },
}));

import { GET as XLSX } from "@/app/api/edit/center/[code]/collab-report/xlsx/route";
import { GET as SELECTED } from "@/app/api/edit/center/[code]/collab-report/selected/route";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";

const CENTER = { code: "meyer_cancer_center", name: "Meyer Cancer Center" };
const REFRESHED = new Date("2026-09-20T12:05:00Z");

function cand(cwid: string, over: Record<string, unknown> = {}) {
  return {
    centerCode: CENTER.code,
    cwid,
    totalPapersPostCutoff: 10,
    collaborationsWithCenter: 0,
    cancerRelatedPapers: 0,
    isCurrentMember: false,
    currentProgramCode: null,
    lastRefreshedAt: REFRESHED,
    ...over,
  };
}

const BASE = [
  cand("m1", { isCurrentMember: true, currentProgramCode: "CB" }),
  cand("c1", { collaborationsWithCenter: 3, cancerRelatedPapers: 5 }),
  cand("r1", { collaborationsWithCenter: 1, cancerRelatedPapers: 4 }),
];

function req(url: string) {
  return new NextRequest(`http://localhost${url}`, {
    headers: { "sec-fetch-site": "same-origin" },
  });
}
const ctx = { params: Promise.resolve({ code: CENTER.code }) };

async function sheets(res: Response): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
  return wb;
}
const values = (ws: ExcelJS.Worksheet) =>
  ws
    .getSheetValues()
    .filter(Boolean)
    .map((r) => (r as unknown[]).slice(1));

beforeEach(() => {
  vi.clearAllMocks();
  h.session.mockResolvedValue({ cwid: "cur001", isSuperuser: false });
  h.centerFindUnique.mockResolvedValue(CENTER);
  h.unitAdminFindMany.mockResolvedValue([
    { entityType: "center", entityId: CENTER.code, role: "curator" },
  ]);
  h.candidateFindMany.mockResolvedValue(BASE);
  h.scholarFindMany.mockImplementation(async ({ where }: { where: { cwid: { in: string[] } } }) =>
    where.cwid.in.map((cwid) => ({
      cwid,
      preferredName: `Ann ${cwid.toUpperCase()}`,
      primaryDepartment: "Medicine",
      primaryOrgCode: null,
    })),
  );
  h.programFindMany.mockResolvedValue([{ code: "CB", label: "Cancer Biology" }]);
});

describe.each([
  ["xlsx", XLSX, "/x"],
  ["selected", SELECTED, "/x?cwid=m1"],
])("%s route gate", (_name, GET, url) => {
  it("401s an unauthenticated caller", async () => {
    h.session.mockResolvedValue(null);
    expect((await GET(req(url), ctx)).status).toBe(401);
  });
  it("404s an unknown center", async () => {
    h.centerFindUnique.mockResolvedValue(null);
    expect((await GET(req(url), ctx)).status).toBe(404);
  });
  it("403s (and logs) a non-admin, never reading candidates", async () => {
    h.session.mockResolvedValue({ cwid: "non001", isSuperuser: false });
    h.unitAdminFindMany.mockResolvedValue([]);
    expect((await GET(req(url), ctx)).status).toBe(403);
    expect(h.logEditDenial).toHaveBeenCalledOnce();
    expect(h.candidateFindMany).not.toHaveBeenCalled();
  });
});

describe("GET …/collab-report/xlsx", () => {
  it("sends one sheet per list plus Criteria, for the URL's thresholds", async () => {
    const res = await XLSX(req("/x?c=1"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="Optimize membership meyer_cancer_center \d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    const wb = await sheets(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Remove",
      "Add collaborators",
      "Add recruits",
      "Criteria",
    ]);
    const remove = values(wb.getWorksheet("Remove")!);
    expect(remove[0][0]).toBe("CWID");
    expect(remove[1]).toEqual([
      "m1",
      "Ann M1",
      "Medicine",
      "",
      10,
      0,
      0,
      0,
      0,
      "CB",
      "Cancer Biology",
    ]);
    // c=1: r1 (1 co-authored) now clears collaboration → collaborators, not recruits.
    expect(
      values(wb.getWorksheet("Add collaborators")!)
        .slice(1)
        .map((r) => r[0]),
    ).toEqual(["c1", "r1"]);
    expect(values(wb.getWorksheet("Add recruits")!)).toHaveLength(1);
    const crit = new Map(values(wb.getWorksheet("Criteria")!).map((r) => [r[0], r[1]]));
    expect(crit.get("Center")).toBe("Meyer Cancer Center");
    expect(crit.get("Collaboration threshold")).toBe("At least 1 co-authored with members (count)");
    expect(crit.get("Data last refreshed")).toBe(REFRESHED.toISOString());
  });

  it("withholds a list over the cap with a note — never a truncated list", async () => {
    const recruits = Array.from({ length: SCHOLAR_EXPORT_CAP + 1 }, (_, i) =>
      cand(`r${String(i).padStart(3, "0")}`, { cancerRelatedPapers: 9 }),
    );
    h.candidateFindMany.mockResolvedValue([...BASE, ...recruits]);
    const wb = await sheets(await XLSX(req("/x"), ctx));
    const rec = values(wb.getWorksheet("Add recruits")!);
    expect(rec).toHaveLength(1);
    expect(String(rec[0][0])).toContain(
      `${SCHOLAR_EXPORT_CAP + 2} people exceeds the ${SCHOLAR_EXPORT_CAP}-person export limit`,
    );
    // The lists under the cap still ship in full.
    expect(values(wb.getWorksheet("Remove")!)).toHaveLength(2);
  });

  it("applies the search and institution filters to the sheets", async () => {
    const wb = await sheets(await XLSX(req("/x?q=ann+c1"), ctx));
    expect(values(wb.getWorksheet("Remove")!)).toHaveLength(1);
    expect(
      values(wb.getWorksheet("Add collaborators")!)
        .slice(1)
        .map((r) => r[0]),
    ).toEqual(["c1"]);
  });
});

describe("GET …/collab-report/selected", () => {
  it("sends the chosen rows (name order) plus Criteria", async () => {
    const res = await SELECTED(req("/x?cwid=r1&cwid=c1&cwid=c1"), ctx);
    expect(res.status).toBe(200);
    const wb = await sheets(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Selected", "Criteria"]);
    expect(
      values(wb.getWorksheet("Selected")!)
        .slice(1)
        .map((r) => r[0]),
    ).toEqual(["c1", "r1"]);
    const crit = new Map(values(wb.getWorksheet("Criteria")!).map((r) => [r[0], r[1]]));
    expect(crit.get("Selection")).toContain("2 people");
  });

  it("400s with no CWIDs", async () => {
    const res = await SELECTED(req("/x"), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_cwid" });
  });

  it("refuses (422) above the cap without reading candidates", async () => {
    const qs = Array.from({ length: SCHOLAR_EXPORT_CAP + 1 }, (_, i) => `cwid=x${i}`).join("&");
    const res = await SELECTED(req(`/x?${qs}`), ctx);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "export_cap_exceeded" });
    expect(h.candidateFindMany).not.toHaveBeenCalled();
  });

  it("serves exactly the cap", async () => {
    const many = Array.from({ length: SCHOLAR_EXPORT_CAP }, (_, i) => cand(`x${i}`));
    h.candidateFindMany.mockResolvedValue(many);
    const qs = many.map((c) => `cwid=${c.cwid}`).join("&");
    expect((await SELECTED(req(`/x?${qs}`), ctx)).status).toBe(200);
  });

  it("400s a CWID that isn't this center's candidate", async () => {
    const res = await SELECTED(req("/x?cwid=c1&cwid=outsider"), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "not_a_candidate" });
  });
});
