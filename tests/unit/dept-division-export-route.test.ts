/**
 * GET /edit/{department,division}/[code]/export — faculty CSV download gating +
 * headers + body (extends #1102 to departments/divisions).
 *
 * The unit CODE is the authorization boundary: the route re-derives the actor's
 * role via `loadUnitEditContext` and 404s when that returns null. The flag is the
 * shared `EDIT_UNIT_ROSTER_EXPORT`. The division route passes the unit's `source`
 * (from the edit context, never the client) to the loader.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSession, mockEnabled, mockCtx, mockLoadDept, mockLoadDiv } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockCtx: vi.fn(),
  mockLoadDept: vi.fn(),
  mockLoadDiv: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/api/unit-edit-context", () => ({ loadUnitEditContext: mockCtx }));
vi.mock("@/lib/edit/unit-roster-export", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/edit/unit-roster-export")>();
  return { ...actual, isUnitRosterExportEnabled: mockEnabled };
});
vi.mock("@/lib/edit/unit-faculty-export", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/edit/unit-faculty-export")>();
  // Keep the real CSV builder; mock only the DB loaders.
  return {
    ...actual,
    loadDepartmentRosterForExport: mockLoadDept,
    loadDivisionRosterForExport: mockLoadDiv,
  };
});
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { GET as GET_DEPT } from "@/app/edit/department/[code]/export/route";
import { GET as GET_DIV } from "@/app/edit/division/[code]/export/route";

const FAC = [
  {
    cwid: "abc1234",
    preferredName: "Jane Smith",
    primaryTitle: "Professor",
    roleCategory: "full_time_faculty",
    divisionName: "Cardiology",
    departmentName: "Medicine",
  },
];

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}
const deptParams = { params: Promise.resolve({ code: "N1280" }) };
const divParams = { params: Promise.resolve({ code: "D1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockSession.mockResolvedValue({ cwid: "cur001", isSuperuser: false });
  mockCtx.mockResolvedValue({ unit: { unitType: "department", code: "N1280", source: "ED" } });
  mockLoadDept.mockResolvedValue(FAC);
  mockLoadDiv.mockResolvedValue(FAC);
});

describe("/edit/department/[code]/export", () => {
  it("flag off → 404 (no edit-context lookup)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET_DEPT(req("/edit/department/N1280/export"), deptParams);
    expect(res.status).toBe(404);
    expect(mockCtx).not.toHaveBeenCalled();
  });

  it("no session → 401", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET_DEPT(req("/edit/department/N1280/export"), deptParams);
    expect(res.status).toBe(401);
  });

  it("not editable (loadUnitEditContext null) → 404, no export", async () => {
    mockCtx.mockResolvedValue(null);
    const res = await GET_DEPT(req("/edit/department/N1280/export"), deptParams);
    expect(res.status).toBe(404);
    expect(mockLoadDept).not.toHaveBeenCalled();
  });

  it("editable → 200 text/csv attachment with the faculty header + rows", async () => {
    const res = await GET_DEPT(req("/edit/department/N1280/export"), deptParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="department-N1280-faculty-');
    const body = await res.text();
    expect(body.split("\r\n")[0]).toBe("cwid,name,title,role_category,division,department");
    expect(body).toContain("abc1234");
    expect(body).not.toContain("email");
  });
});

describe("/edit/division/[code]/export", () => {
  beforeEach(() => {
    mockCtx.mockResolvedValue({ unit: { unitType: "division", code: "D1", source: "manual" } });
  });

  it("editable → 200 + passes the unit's source to the loader", async () => {
    const res = await GET_DIV(req("/edit/division/D1/export"), divParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain('filename="division-D1-faculty-');
    // source comes from the authorized edit context, never the request.
    expect(mockLoadDiv).toHaveBeenCalledWith(expect.anything(), "D1", "manual");
  });

  it("not editable → 404", async () => {
    mockCtx.mockResolvedValue(null);
    const res = await GET_DIV(req("/edit/division/D1/export"), divParams);
    expect(res.status).toBe(404);
    expect(mockLoadDiv).not.toHaveBeenCalled();
  });

  it("flag off → 404", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET_DIV(req("/edit/division/D1/export"), divParams);
    expect(res.status).toBe(404);
  });
});
