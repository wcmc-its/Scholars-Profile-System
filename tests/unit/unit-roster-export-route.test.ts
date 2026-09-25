/**
 * GET /edit/center/[code]/export — roster .xlsx download gating + headers + body
 * (#1102). The unit CODE is the authorization boundary: the route re-derives the
 * actor's role via `loadUnitEditContext` and 404s when that returns null.
 */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSession, mockEnabled, mockCtx } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockCtx: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/api/unit-edit-context", () => ({ loadUnitEditContext: mockCtx }));
vi.mock("@/lib/edit/unit-roster-export", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/edit/unit-roster-export")>();
  // Keep the real row projection / status derivation; mock only the flag gate.
  return { ...actual, isUnitRosterExportEnabled: mockEnabled };
});
// The route joins the faculty block (email / role / dept / division) via
// `loadRosterFacultyMeta(…, db.read)`. Returns [] so these gating tests keep
// asserting on status/authz alone — the email carve itself is covered in
// unit-roster-export-lib.test.ts.
vi.mock("@/lib/db", () => ({ db: { read: { scholar: { findMany: async () => [] } } } }));

import { GET } from "@/app/edit/center/[code]/export/route";

const PAST = "2000-01-01";
const FUTURE = "2999-01-01";

const ctxFixture = {
  unit: { unitType: "center", code: "MCC" },
  roster: [
    {
      cwid: "act1",
      name: "Active Person",
      title: "Professor",
      source: "manual",
      membershipType: "research",
      programCode: "CPC",
      startDate: null,
      endDate: null,
    },
    {
      cwid: "pen1",
      name: "Pending Person, MD",
      title: null,
      source: "manual",
      membershipType: "clinical",
      programCode: null,
      startDate: FUTURE,
      endDate: null,
    },
    {
      cwid: "ina1",
      name: "Inactive Person",
      title: "Lecturer",
      source: "ED",
      membershipType: null,
      programCode: "CPC",
      startDate: null,
      endDate: PAST,
    },
  ],
  programs: [{ code: "CPC", label: "Cancer Prevention & Control", sortOrder: 0 }],
} as const;

const req = (qs = "") =>
  new NextRequest(`http://localhost/edit/center/MCC/export${qs}`);
const ctx = (code = "MCC") => ({ params: Promise.resolve({ code }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockSession.mockResolvedValue({ cwid: "edt1", isSuperuser: true, isCommsSteward: false });
  mockEnabled.mockReturnValue(true);
  mockCtx.mockResolvedValue(ctxFixture);
});

/** The Roster sheet's rows as strings, header first. */
async function sheetRows(res: Response): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  const ws = wb.getWorksheet("Roster")!;
  const out: string[][] = [];
  ws.eachRow((row) => {
    const cells: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = row.getCell(c).value;
      cells.push(v == null ? "" : String(v));
    }
    out.push(cells);
  });
  return out;
}

describe("/edit/center/[code]/export gating", () => {
  it("404s when the flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    expect(mockCtx).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
    expect(mockCtx).not.toHaveBeenCalled();
  });

  it("404s when the actor can't edit this center (loadUnitEditContext null)", async () => {
    mockCtx.mockResolvedValue(null);
    const res = await GET(req(), ctx("NOPE"));
    expect(res.status).toBe(404);
    // The code from the path — not a query param — is the scope passed to the loader.
    expect(mockCtx).toHaveBeenCalledWith(
      "center",
      "NOPE",
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns an .xlsx attachment with the roster header + rows for an authorized actor", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="center-MCC-roster-\d{4}-\d{2}-\d{2}\.xlsx"/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");

    const rows = await sheetRows(res);
    // Same columns the CSV had — the format changed, nothing else.
    expect(rows[0]).toEqual(
      "cwid,name,title,membership_type,program_code,program_label,start_date,end_date,status,source,email,role_category,department,division,scholar_state,institution".split(","),
    );
    // All three members present (active + pending + inactive) by default.
    expect(rows).toHaveLength(4);
    // program_label resolved from the taxonomy; status derived.
    expect(rows[1].slice(0, 10)).toEqual([
      "act1", "Active Person", "Professor", "research", "CPC", "Cancer Prevention & Control", "", "", "active", "manual",
    ]);
    expect(rows[2][8]).toBe("pending");
    expect(rows[3].slice(8, 10)).toEqual(["inactive", "ED"]);
  });

  it("honors ?activeOnly=1 — drops pending + inactive rows", async () => {
    const res = await GET(req("?activeOnly=1"), ctx());
    const rows = await sheetRows(res);
    expect(rows).toHaveLength(2); // header + the one active member
    expect(rows[1][0]).toBe("act1");
  });

  it("emits one structured export_unit_members access-log line", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await GET(req(), ctx());
    const logged = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("export_unit_members"));
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged as string);
    expect(parsed).toMatchObject({
      event: "export_unit_members",
      cwid: "edt1",
      unitType: "center",
      unitCode: "MCC",
      rows: 3,
    });
  });
});
