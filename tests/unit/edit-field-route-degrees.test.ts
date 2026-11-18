import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  session: vi.fn(),
  authz: vi.fn(),
  scholarFindUnique: vi.fn(),
  educationFindMany: vi.fn(),
  txFindUnique: vi.fn(),
  txUpsert: vi.fn(),
  txDelete: vi.fn(),
  txScholarUpdate: vi.fn(),
  audit: vi.fn(),
  reflect: vi.fn(),
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
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeOverviewWrite: m.authz }));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: m.audit }));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectOverviewEdit: m.reflect,
  resolveAffectedProfiles: vi.fn(async () => [{ slug: "s-slug", cwid: "s01" }]),
}));
const tx = {
  fieldOverride: { findUnique: m.txFindUnique, upsert: m.txUpsert, delete: m.txDelete },
  scholar: { update: m.txScholarUpdate },
};
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: m.scholarFindUnique },
      education: { findMany: m.educationFindMany },
    },
    write: { $transaction: async (cb: (t: typeof tx) => unknown) => cb(tx) },
  },
}));

import { POST } from "@/app/api/edit/field/route";

function post(value: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/field", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({
      op: "set",
      entityType: "scholar",
      entityId: "s01",
      fieldName: "postnominal",
      value,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("SCHOLAR_DEGREE_PICKER", "on");
  m.session.mockResolvedValue({ cwid: "s01", isSuperuser: false });
  m.authz.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
  m.scholarFindUnique.mockResolvedValue({ directoryPostnominal: "PhD, MD" });
  m.educationFindMany.mockResolvedValue([
    { degree: "B.S.", year: 2004 },
    { degree: "M.P.H.", year: 2009 },
    { degree: "Ph.D.", year: 2016 },
    { degree: "M.D.", year: 2018 },
  ]);
  m.txFindUnique.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/edit/field — postnominal (degree picker)", () => {
  it("stores the pick in display order and writes Scholar.postnominal now", async () => {
    const res = await POST(post(["MPH", "PhD", "MD"]));
    expect(res.status).toBe(200);
    expect(m.txUpsert.mock.calls[0][0].create.value).toBe('["MD","PhD","MPH"]');
    expect(m.txScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "s01" },
      data: { postnominal: "MD, PhD, MPH" },
    });
    expect(m.audit.mock.calls[0][1].action).toBe("field_override");
    expect(m.reflect).toHaveBeenCalledWith("s-slug");
  });

  it("rejects a degree not in the scholar's ASMS record (no free text)", async () => {
    const res = await POST(post(["MD", "FACS"]));
    expect(res.status).toBe(400);
    expect(m.txUpsert).not.toHaveBeenCalled();
  });

  it("rejects a bachelor's even though ASMS holds it", async () => {
    const res = await POST(post(["MD", "BS"]));
    expect(res.status).toBe(400);
  });

  it('clears with "" and restores the directory value', async () => {
    m.txFindUnique.mockResolvedValue({ value: '["MD","PhD","MPH"]' });
    const res = await POST(post(""));
    expect(res.status).toBe(200);
    expect(m.txDelete).toHaveBeenCalled();
    expect(m.txScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "s01" },
      data: { postnominal: "PhD, MD" },
    });
    expect(m.audit.mock.calls[0][1].action).toBe("field_override_clear");
  });

  it("403s when the caller may not edit this scholar", async () => {
    m.authz.mockResolvedValue({ ok: false, reason: "not_owner" });
    const res = await POST(post(["MD"]));
    expect(res.status).toBe(403);
    expect(m.txUpsert).not.toHaveBeenCalled();
  });

  it("is dark when SCHOLAR_DEGREE_PICKER is off", async () => {
    vi.stubEnv("SCHOLAR_DEGREE_PICKER", "off");
    const res = await POST(post(["MD"]));
    expect(res.status).toBe(400);
    expect(m.authz).not.toHaveBeenCalled();
  });
});
