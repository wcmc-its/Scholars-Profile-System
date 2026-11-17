/**
 * /api/edit/unit-leadership — a department's Vice Chair roles.
 *
 *  - flag off → 404; non-admin → 403; unknown department → 400.
 *  - add writes a live `steward` row and one `roster_change` audit row on the
 *    department, actor = realCwid.
 *  - a holder who is not full-time faculty → 400 note_required without a note,
 *    200 with one.
 *  - a departed / unknown holder → 400 scholar_not_found.
 *  - same person + tier + function set → 409 duplicate_role (not on the row
 *    being updated itself).
 *  - update / remove refuse a row that belongs to another department.
 *  - field validation: clinical_area needs areaText; a title naming an area
 *    needs a function.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  session: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  deptFindUnique: vi.fn(),
  unitAdminFindMany: vi.fn(),
  scholarFindUnique: vi.fn(),
  roleFindUnique: vi.fn(),
  roleFindMany: vi.fn(),
  txCreate: vi.fn(),
  txUpdate: vi.fn(),
  txDelete: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: m.session }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: m.session,
  impersonationActive: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => {
    const s = await m.session();
    return s ? { cwid: s.cwid, iat: 0, exp: 0 } : null;
  }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      department: { findUnique: m.deptFindUnique },
      unitAdmin: { findMany: m.unitAdminFindMany },
      scholar: { findUnique: m.scholarFindUnique },
      unitLeadershipRole: { findUnique: m.roleFindUnique, findMany: m.roleFindMany },
    },
    write: { $transaction: m.transaction },
  },
}));

import { POST } from "@/app/api/edit/unit-leadership/route";

const fakeTx = {
  unitLeadershipRole: { create: m.txCreate, update: m.txUpdate, delete: m.txDelete },
  $executeRaw: m.executeRaw,
};

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/edit/unit-leadership", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });

const FT = {
  preferredName: "Ann Example",
  primaryTitle: "Professor of Medicine",
  roleCategory: "full_time_faculty",
  deletedAt: null,
  status: "active",
  campus: "wcm",
};
const ADD = {
  departmentCode: "N1280",
  action: "add",
  cwid: "aex1001",
  displayTitle: "Vice Chair for Research",
  tier: "vice",
  functions: ["research"],
};
const ROW = {
  id: "r1",
  cwid: "aex1001",
  entityType: "department",
  entityId: "N1280",
  displayTitle: "Vice Chair for Research",
  tier: "vice",
  functions: "research",
  areaText: null,
  site: null,
  startDate: null,
  source: "audit_seed",
  sourceUrl: "https://example.org/leadership",
  note: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.UNIT_LEADERSHIP_ROLES = "on";
  m.session.mockResolvedValue({ cwid: "cur001", isSuperuser: false });
  m.transaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  m.executeRaw.mockResolvedValue(1);
  m.deptFindUnique.mockResolvedValue({ code: "N1280" });
  m.unitAdminFindMany.mockResolvedValue([{ entityType: "department", entityId: "N1280", role: "curator" }]);
  m.scholarFindUnique.mockResolvedValue(FT);
  m.roleFindUnique.mockResolvedValue(ROW);
  m.roleFindMany.mockResolvedValue([]);
  m.txCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "new1",
    sourceUrl: null,
    ...data,
  }));
  m.txUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...ROW, ...data }));
  m.txDelete.mockResolvedValue(ROW);
});
afterEach(() => {
  delete process.env.UNIT_LEADERSHIP_ROLES;
});

describe("/api/edit/unit-leadership — gates", () => {
  it("404s when the flag is off, before reading anything", async () => {
    delete process.env.UNIT_LEADERSHIP_ROLES;
    expect((await POST(post(ADD))).status).toBe(404);
    expect(m.deptFindUnique).not.toHaveBeenCalled();
  });

  it("403s a user with no role on the department", async () => {
    m.unitAdminFindMany.mockResolvedValue([]);
    const res = await POST(post(ADD));
    expect(res.status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("400s an unknown department", async () => {
    m.deptFindUnique.mockResolvedValue(null);
    const res = await POST(post(ADD));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unit_not_found" });
  });
});

describe("/api/edit/unit-leadership — add", () => {
  it("writes a live steward row and one audit row on the department", async () => {
    const res = await POST(post({ ...ADD, startDate: "2026-07-01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      role: {
        id: "new1",
        cwid: "aex1001",
        name: "Ann Example",
        fullTimeFaculty: true,
        displayTitle: "Vice Chair for Research",
        tier: "vice",
        functions: ["research"],
        startDate: "2026-07-01",
        source: "steward",
      },
    });
    expect(m.txCreate).toHaveBeenCalledWith({
      data: {
        cwid: "aex1001",
        entityType: "department",
        entityId: "N1280",
        source: "steward",
        displayTitle: "Vice Chair for Research",
        tier: "vice",
        functions: "research",
        areaText: null,
        site: null,
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        note: null,
      },
    });
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
    const audit = m.executeRaw.mock.calls[0] as unknown[];
    expect(audit.slice(1, 5)).toEqual(["cur001", "department", "N1280", "roster_change"]);
  });

  it("asks for a note when the holder is not full-time faculty, then accepts one", async () => {
    m.scholarFindUnique.mockResolvedValue({ ...FT, roleCategory: "part_time_faculty" });
    const refused = await POST(post(ADD));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "note_required", field: "note" });
    expect(m.transaction).not.toHaveBeenCalled();

    const ok = await POST(post({ ...ADD, note: "Voluntary faculty; named by the chair." }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      role: { fullTimeFaculty: false, note: "Voluntary faculty; named by the chair." },
    });
  });

  it.each([
    ["unknown", null],
    ["deleted", { ...FT, deletedAt: new Date() }],
    ["suppressed", { ...FT, status: "suppressed" }],
    ["Ithaca", { ...FT, campus: "ithaca" }],
  ])("refuses a holder who is %s", async (_label, scholar) => {
    m.scholarFindUnique.mockResolvedValue(scholar);
    const res = await POST(post(ADD));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "scholar_not_found" });
  });

  it("409s a second row with the same person, tier and function set", async () => {
    m.roleFindMany.mockResolvedValue([{ id: "r1", tier: "vice", functions: "research" }]);
    const res = await POST(post(ADD));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "duplicate_role" });
    // A different function set is a different role (two Vice Chair titles).
    expect((await POST(post({ ...ADD, displayTitle: "Vice Chair of Innovation", functions: ["innovation"] }))).status).toBe(200);
  });

  it.each([
    [{ tier: "deputy" }, "invalid_value", "tier"],
    [{ functions: ["research", "nope"] }, "invalid_value", "functions"],
    [{ displayTitle: "  " }, "invalid_value", "displayTitle"],
    [{ site: "nyp_mars" }, "invalid_value", "site"],
    [{ startDate: "July 1" }, "invalid_value", "startDate"],
    [{ functions: ["clinical_area"], displayTitle: "Vice Chair for Hematopathology" }, "area_text_required", "areaText"],
    [{ functions: [] }, "area_unmapped", "functions"],
  ])("validates %j", async (patch, error, field) => {
    const res = await POST(post({ ...ADD, ...patch }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error, field });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("accepts a general Vice Chair with no functions", async () => {
    const res = await POST(post({ ...ADD, displayTitle: "Vice Chair, Department of Surgery", functions: [] }));
    expect(res.status).toBe(200);
  });
});

describe("/api/edit/unit-leadership — update and remove", () => {
  it("updates the fields, keeps the holder, and does not flag itself as a duplicate", async () => {
    m.roleFindMany.mockResolvedValue([{ id: "r1", tier: "vice", functions: "research" }]);
    const res = await POST(
      post({ ...ADD, action: "update", id: "r1", cwid: "someoneelse", displayTitle: "Vice Chair of Research" }),
    );
    expect(res.status).toBe(200);
    expect(m.scholarFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { cwid: "aex1001" } }));
    expect(m.txUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: expect.objectContaining({ displayTitle: "Vice Chair of Research", functions: "research" }),
    });
    expect(m.txUpdate.mock.calls[0][0].data).not.toHaveProperty("cwid");
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("removes a row and audits it", async () => {
    const res = await POST(post({ departmentCode: "N1280", action: "remove", id: "r1" }));
    expect(res.status).toBe(200);
    expect(m.txDelete).toHaveBeenCalledWith({ where: { id: "r1" } });
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
  });

  it.each(["update", "remove"])("%s refuses a row from another department", async (action) => {
    m.roleFindUnique.mockResolvedValue({ ...ROW, entityId: "N9999" });
    const res = await POST(post({ ...ADD, action, id: "r1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "role_not_found" });
    expect(m.transaction).not.toHaveBeenCalled();
  });
});
