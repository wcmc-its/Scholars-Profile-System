/**
 * GET /api/impersonation/candidates — the "Org unit roles" scope. A unit filter
 * must narrow the scholar query to grant holders BEFORE the 50-row `take`;
 * filtering only in memory after an alphabetical page dropped every grant holder
 * past row 50, so the tab came back near-empty for a short query.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { scholarFindMany, unitAdminFindMany } = vi.hoisted(() => ({
  scholarFindMany: vi.fn(),
  unitAdminFindMany: vi.fn(),
}));

vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => ({ cwid: "su001", iat: 0, exp: 0 })),
}));
vi.mock("@/lib/auth/effective-identity", () => ({ canImpersonate: vi.fn(async () => true) }));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/comms-steward", () => ({ listCommsStewardCwids: () => [] }));
vi.mock("@/lib/db", () => {
  const none = { findMany: vi.fn(async () => []) };
  return {
    db: {
      read: {
        scholar: { findMany: scholarFindMany },
        unitAdmin: { findMany: unitAdminFindMany },
        department: none,
        division: none,
        center: none,
        core: none,
        stewardDirectory: none,
      },
    },
  };
});

import { GET } from "@/app/api/impersonation/candidates/route";

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/impersonation/candidates?${qs}`));

beforeEach(() => {
  vi.stubEnv("IMPERSONATION_ENABLED", "true");
  scholarFindMany.mockReset().mockResolvedValue([]);
  unitAdminFindMany.mockReset().mockResolvedValue([]);
});

describe("candidates route — unit scope", () => {
  it("kind=unit scopes the scholar query to grant holders of any unit kind", async () => {
    unitAdminFindMany.mockResolvedValueOnce([{ cwid: "own001" }, { cwid: "cur002" }]);
    await get("kind=unit&q=a");

    expect(unitAdminFindMany.mock.calls[0][0].where).toEqual({
      entityType: { in: ["department", "division", "center", "core", "institution"] },
    });
    expect(scholarFindMany.mock.calls[0][0].where.cwid).toEqual({ in: ["own001", "cur002"] });
  });

  it("a single kind scopes to that kind's grant holders", async () => {
    unitAdminFindMany.mockResolvedValueOnce([{ cwid: "own001" }]);
    await get("kind=center");

    expect(unitAdminFindMany.mock.calls[0][0].where).toEqual({ entityType: "center" });
    expect(scholarFindMany.mock.calls[0][0].where.cwid).toEqual({ in: ["own001"] });
  });

  it("People (no kind) does not scope the scholar query", async () => {
    await get("q=a");

    expect(scholarFindMany.mock.calls[0][0].where.cwid).toBeUndefined();
  });

  it("returns the scoped grant holder with their role", async () => {
    unitAdminFindMany
      .mockResolvedValueOnce([{ cwid: "own001" }]) // the scope pass
      .mockResolvedValueOnce([
        { cwid: "own001", role: "owner", entityType: "department", entityId: "D1" },
      ]); // the per-page grants pass
    scholarFindMany.mockResolvedValueOnce([
      { cwid: "own001", preferredName: "Jane Owner", slug: "jane-owner", department: null, division: null },
    ]);

    const rows = await (await get("kind=unit")).json();
    expect(rows).toEqual([
      expect.objectContaining({ cwid: "own001", role: "owner", unitKind: "department" }),
    ]);
  });
});
