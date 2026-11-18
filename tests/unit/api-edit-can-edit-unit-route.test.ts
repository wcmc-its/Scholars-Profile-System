/**
 * `GET /api/edit/can-edit-unit` — the probe behind the public unit pages'
 * "Edit this department / division / center" link. Runs the REAL
 * `getEffectiveUnitRole` + `canEditUnit` over an in-memory `unit_admin` table,
 * so the dept→division cascade is exercised end to end.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Grant = {
  cwid: string;
  entityType: "department" | "division" | "center";
  entityId: string;
  role: "owner" | "curator";
};

const { mockGetSession, grants, divisions } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  grants: [] as Grant[],
  divisions: new Map<string, string | null>(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetSession,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      division: {
        findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
          divisions.has(where.code) ? { deptCode: divisions.get(where.code) ?? null } : null,
        ),
      },
      unitAdmin: {
        findMany: vi.fn(
          async ({
            where,
          }: {
            where: { cwid: string; OR: Array<{ entityType: string; entityId: string }> };
          }) =>
            grants.filter(
              (g) =>
                g.cwid === where.cwid &&
                where.OR.some((o) => o.entityType === g.entityType && o.entityId === g.entityId),
            ),
        ),
      },
    },
  },
}));

import { GET } from "@/app/api/edit/can-edit-unit/route";

function session(cwid: string, extra: Record<string, boolean> = {}) {
  return { cwid, isSuperuser: false, isCommsSteward: false, ...extra };
}

async function probe(
  kind: string,
  code: string,
): Promise<{ status: number; body: unknown; cache: string | null }> {
  const res = await GET(
    new NextRequest(
      `http://localhost/api/edit/can-edit-unit?kind=${encodeURIComponent(kind)}&code=${encodeURIComponent(code)}`,
    ),
  );
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
}

beforeEach(() => {
  vi.clearAllMocks();
  grants.length = 0;
  divisions.clear();
  grants.push(
    { cwid: "own001", entityType: "department", entityId: "D100", role: "owner" },
    { cwid: "cur001", entityType: "department", entityId: "D100", role: "curator" },
    { cwid: "ctr001", entityType: "center", entityId: "C100", role: "curator" },
    { cwid: "div001", entityType: "division", entityId: "V100", role: "curator" },
  );
  divisions.set("V100", "D100");
  divisions.set("V200", "D200");
});

describe("GET /api/edit/can-edit-unit", () => {
  it("unauthenticated → canEdit false, 200, no-store", async () => {
    mockGetSession.mockResolvedValue(null);
    const r = await probe("department", "D100");
    expect(r).toEqual({ status: 200, body: { ok: true, canEdit: false }, cache: "no-store" });
  });

  it("department owner → true", async () => {
    mockGetSession.mockResolvedValue(session("own001"));
    expect((await probe("department", "D100")).body).toEqual({ ok: true, canEdit: true });
  });

  it("department curator → true", async () => {
    mockGetSession.mockResolvedValue(session("cur001"));
    const r = await probe("department", "D100");
    expect(r.body).toEqual({ ok: true, canEdit: true });
    expect(r.cache).toBe("no-store");
  });

  it("center curator → true for that center only", async () => {
    mockGetSession.mockResolvedValue(session("ctr001"));
    expect((await probe("center", "C100")).body).toEqual({ ok: true, canEdit: true });
    expect((await probe("center", "C999")).body).toEqual({ ok: true, canEdit: false });
  });

  it("department curator edits a child division (cascade), not another department's", async () => {
    mockGetSession.mockResolvedValue(session("cur001"));
    expect((await probe("division", "V100")).body).toEqual({ ok: true, canEdit: true });
    expect((await probe("division", "V200")).body).toEqual({ ok: true, canEdit: false });
  });

  it("a division grant does not cascade up to the department", async () => {
    mockGetSession.mockResolvedValue(session("div001"));
    expect((await probe("division", "V100")).body).toEqual({ ok: true, canEdit: true });
    expect((await probe("department", "D100")).body).toEqual({ ok: true, canEdit: false });
  });

  it("superuser → true on any unit, with no grant", async () => {
    mockGetSession.mockResolvedValue(session("sup001", { isSuperuser: true }));
    expect((await probe("department", "D200")).body).toEqual({ ok: true, canEdit: true });
    expect((await probe("center", "C999")).body).toEqual({ ok: true, canEdit: true });
  });

  it("signed-in with no role → false", async () => {
    mockGetSession.mockResolvedValue(session("nob001"));
    expect((await probe("department", "D100")).body).toEqual({ ok: true, canEdit: false });
    expect((await probe("division", "V100")).body).toEqual({ ok: true, canEdit: false });
  });

  it("an observer's read-only steward view does not count as edit rights", async () => {
    mockGetSession.mockResolvedValue(session("obs001", { isCommsSteward: true, isObserver: true }));
    expect((await probe("department", "D100")).body).toEqual({ ok: true, canEdit: false });
  });

  it("bad kind, empty code, or unknown division → false without a role lookup", async () => {
    mockGetSession.mockResolvedValue(session("sup001", { isSuperuser: true }));
    expect((await probe("core", "X")).body).toEqual({ ok: true, canEdit: false });
    expect((await probe("department", "")).body).toEqual({ ok: true, canEdit: false });
    expect((await probe("division", "NOPE")).body).toEqual({ ok: true, canEdit: false });
  });

  it("a session lookup failure fails closed", async () => {
    mockGetSession.mockRejectedValue(new Error("ldap down"));
    expect((await probe("department", "D100")).body).toEqual({ ok: true, canEdit: false });
  });
});
