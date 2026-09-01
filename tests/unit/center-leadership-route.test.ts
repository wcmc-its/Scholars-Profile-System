/**
 * #2542 Phase C — /api/edit/center-leadership (the vocabulary-driven
 * leadership editor, replacing the old director-only path on
 * `/api/edit/unit`).
 *
 *  - Curator adds / removes a holder and toggles interim.
 *  - add on an existing holder → 200 no-op (no DB write).
 *  - remove of an absent holder → 200 no-op.
 *  - set_interim on an absent holder → 400 holder_not_found.
 *  - lazy vocabulary seed runs before the write, every mutating action.
 *  - isRoleAllowedAtUnit gate → 400 role_not_allowed_at_unit (scope rejection
 *    happens before any write).
 *  - an unknown / non-leadership roleKey → 400 invalid_role.
 *  - singleHolder: a second holder without `replace` → 409
 *    role_single_holder_conflict, naming the incumbent; `replace: true`
 *    vacates the incumbent and grants the new holder, carrying `interim`
 *    across, in ONE transaction and ONE combined audit row.
 *  - a non-singleHolder role never conflicts — multiple holders coexist.
 *  - unknown center → 400 unit_not_found. non-admin → 403 not_curator.
 *  - every mutation writes a B03 audit row (roster_change | field_override)
 *    against targetEntityType "center" with actorCwid = realCwid.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockExecuteRaw,
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockAssignmentFindUnique,
  mockScholarFindMany,
  mockTxRoleCreateMany,
  mockTxRoleFindUnique,
  mockTxScopeFindMany,
  mockTxAssignmentCreate,
  mockTxAssignmentDelete,
  mockTxAssignmentUpdate,
  mockTxAssignmentFindMany,
  mockReflectUnitChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockAssignmentFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockTxRoleCreateMany: vi.fn(),
  mockTxRoleFindUnique: vi.fn(),
  mockTxScopeFindMany: vi.fn(),
  mockTxAssignmentCreate: vi.fn(),
  mockTxAssignmentDelete: vi.fn(),
  mockTxAssignmentUpdate: vi.fn(),
  mockTxAssignmentFindMany: vi.fn(),
  mockReflectUnitChange: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
  impersonationActive: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => {
    const s = await mockGetEditSession();
    return s ? { cwid: s.cwid, iat: 0, exp: 0 } : null;
  }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      center: { findUnique: mockCenterFindUnique },
      unitAdmin: { findMany: mockUnitAdminFindMany },
      orgUnitRoleAssignment: { findUnique: mockAssignmentFindUnique },
      scholar: { findMany: mockScholarFindMany },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({ reflectUnitChange: mockReflectUnitChange }));

import { POST } from "@/app/api/edit/center-leadership/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };

const fakeTx = {
  orgUnitRole: { createMany: mockTxRoleCreateMany, findUnique: mockTxRoleFindUnique },
  orgUnitRoleScope: { findMany: mockTxScopeFindMany },
  orgUnitRoleAssignment: {
    create: mockTxAssignmentCreate,
    delete: mockTxAssignmentDelete,
    update: mockTxAssignmentUpdate,
    findMany: mockTxAssignmentFindMany,
  },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/center-leadership", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const BASE = { centerCode: "meyer_cancer_center", roleKey: "director" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(CURATOR);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockExecuteRaw.mockResolvedValue(1);
  mockCenterFindUnique.mockResolvedValue({ code: "meyer_cancer_center", slug: "meyer-cancer-center" });
  mockUnitAdminFindMany.mockResolvedValue([
    { entityType: "center", entityId: "meyer_cancer_center", role: "curator" },
  ]);
  mockAssignmentFindUnique.mockResolvedValue(null);
  mockScholarFindMany.mockResolvedValue([]);
  mockTxRoleCreateMany.mockResolvedValue({ count: 0 });
  mockTxRoleFindUnique.mockResolvedValue({ roleGroup: "leadership", singleHolder: true });
  mockTxScopeFindMany.mockResolvedValue([]);
  mockTxAssignmentFindMany.mockResolvedValue([]);
  mockTxAssignmentCreate.mockImplementation(
    async (args: { data: { cwid: string; interim: boolean } }) => ({
      cwid: args.data.cwid,
      interim: args.data.interim,
    }),
  );
  mockTxAssignmentUpdate.mockResolvedValue({ cwid: "dir001", interim: true });
  mockTxAssignmentDelete.mockResolvedValue({ cwid: "dir001" });
});

describe("/api/edit/center-leadership — add", () => {
  it("adds a holder to an empty singleHolder role → 200, seeds + creates + audits", async () => {
    mockScholarFindMany.mockResolvedValue([
      { cwid: "dir001", preferredName: "Dana Director", primaryTitle: "MD", deletedAt: null },
    ]);
    const res = await POST(post({ ...BASE, action: "add", cwid: "dir001" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      changed: true,
      holder: { cwid: "dir001", name: "Dana Director", title: "MD", interim: false },
    });
    expect(mockTxRoleCreateMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(mockTxAssignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          entityType: "center",
          entityId: "meyer_cancer_center",
          cwid: "dir001",
          roleKey: "director",
          interim: false,
        },
      }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const auditCall = mockExecuteRaw.mock.calls[0] as unknown[];
    expect(auditCall[1]).toBe("cur001"); // actor_cwid = realCwid
    expect(auditCall[2]).toBe("center"); // target_entity_type
    expect(auditCall[3]).toBe("meyer_cancer_center"); // target_entity_id
    expect(auditCall[4]).toBe("roster_change"); // an EXISTING action
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "center", unitSlug: "meyer-cancer-center" }),
    );
  });

  it("adding an existing holder → 200 no-op, no transaction opened", async () => {
    mockAssignmentFindUnique.mockResolvedValue({ cwid: "dir001", interim: false });
    const res = await POST(post({ ...BASE, action: "add", cwid: "dir001" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a non-singleHolder role adds a second holder with no conflict", async () => {
    mockTxRoleFindUnique.mockResolvedValue({ roleGroup: "leadership", singleHolder: false });
    mockTxAssignmentFindMany.mockResolvedValue([{ cwid: "cod001", interim: false }]);
    const res = await POST(
      post({ ...BASE, roleKey: "co_director", action: "add", cwid: "cod002" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxAssignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cwid: "cod002", roleKey: "co_director" }),
      }),
    );
    // No vacate — the existing co-director is untouched.
    expect(mockTxAssignmentDelete).not.toHaveBeenCalled();
  });
});

describe("/api/edit/center-leadership — singleHolder conflict + replace", () => {
  it("a second holder of a singleHolder role without replace → 409, names the incumbent", async () => {
    mockTxAssignmentFindMany.mockResolvedValue([{ cwid: "old001", interim: false }]);
    const res = await POST(post({ ...BASE, action: "add", cwid: "new001" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "role_single_holder_conflict",
      incumbentCwid: "old001",
    });
    expect(mockTxAssignmentCreate).not.toHaveBeenCalled();
    expect(mockTxAssignmentDelete).not.toHaveBeenCalled();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("replace:true vacates an INTERIM incumbent and grants the new holder as non-interim by default", async () => {
    mockTxAssignmentFindMany.mockResolvedValue([{ cwid: "old001", interim: true }]);
    const res = await POST(
      post({ ...BASE, action: "add", cwid: "new001", replace: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      changed: true,
      replacedCwid: "old001",
      holder: { cwid: "new001", interim: false },
    });
    expect(mockTxAssignmentDelete).toHaveBeenCalledWith({
      where: {
        entityType_entityId_cwid_roleKey: {
          entityType: "center",
          entityId: "meyer_cancer_center",
          cwid: "old001",
          roleKey: "director",
        },
      },
    });
    // The incumbent's interim=true is NOT inherited — the replacement is
    // written as interim=false, the request's default.
    expect(mockTxAssignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cwid: "new001", interim: false }),
      }),
    );
    // ONE combined audit row for the replace, not two.
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const auditCall = mockExecuteRaw.mock.calls[0] as unknown[];
    expect(auditCall[4]).toBe("roster_change");
    // before_values still names the incumbent's actual (interim=true) state.
    expect(JSON.parse(auditCall[6] as string)).toEqual({
      roleKey: "director",
      cwid: "old001",
      interim: true,
    });
    // after_values reflects what was ACTUALLY written, not a carried-over flag.
    expect(JSON.parse(auditCall[7] as string)).toEqual({
      roleKey: "director",
      cwid: "new001",
      interim: false,
    });
  });

  it("replace:true with interim:true requested writes the replacement as interim", async () => {
    mockTxAssignmentFindMany.mockResolvedValue([{ cwid: "old001", interim: false }]);
    const res = await POST(
      post({ ...BASE, action: "add", cwid: "new001", replace: true, interim: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      changed: true,
      replacedCwid: "old001",
      holder: { cwid: "new001", interim: true },
    });
    expect(mockTxAssignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cwid: "new001", interim: true }),
      }),
    );
    const auditCall = mockExecuteRaw.mock.calls[0] as unknown[];
    expect(JSON.parse(auditCall[7] as string)).toEqual({
      roleKey: "director",
      cwid: "new001",
      interim: true,
    });
  });

  it("plain add (no replace) with interim:true requested writes the new holder as interim", async () => {
    const res = await POST(
      post({ ...BASE, action: "add", cwid: "dir001", interim: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      changed: true,
      holder: { cwid: "dir001", interim: true },
    });
    expect(mockTxAssignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cwid: "dir001", interim: true }),
      }),
    );
  });

  it("interim not a boolean on add → 400 invalid_value, no transaction", async () => {
    const res = await POST(
      post({ ...BASE, action: "add", cwid: "dir001", interim: "yes" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_value", field: "interim" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("/api/edit/center-leadership — remove", () => {
  it("removes an existing holder → 200 { ok: true } with no holder, deletes + audits", async () => {
    mockAssignmentFindUnique.mockResolvedValue({ cwid: "dir001", interim: false });
    const res = await POST(post({ ...BASE, action: "remove", cwid: "dir001" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, changed: true });
    expect(json).not.toHaveProperty("holder");
    expect(mockScholarFindMany).not.toHaveBeenCalled();
    expect(mockTxAssignmentDelete).toHaveBeenCalledWith({
      where: {
        entityType_entityId_cwid_roleKey: {
          entityType: "center",
          entityId: "meyer_cancer_center",
          cwid: "dir001",
          roleKey: "director",
        },
      },
    });
    const auditCall = mockExecuteRaw.mock.calls[0] as unknown[];
    expect(auditCall[4]).toBe("roster_change");
    expect(JSON.parse(auditCall[7] as string)).toBeNull(); // after_values
  });

  it("removing an absent holder → 200 no-op, no transaction opened", async () => {
    const res = await POST(post({ ...BASE, action: "remove", cwid: "dir001" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("/api/edit/center-leadership — set_interim", () => {
  it("toggles interim on an existing holder → 200, updates + audits field_override", async () => {
    mockAssignmentFindUnique.mockResolvedValue({ cwid: "dir001", interim: false });
    mockTxAssignmentUpdate.mockResolvedValue({ cwid: "dir001", interim: true });
    mockScholarFindMany.mockResolvedValue([
      { cwid: "dir001", preferredName: "Dana Director", primaryTitle: "MD", deletedAt: null },
    ]);
    const res = await POST(
      post({ ...BASE, action: "set_interim", cwid: "dir001", interim: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      holder: { cwid: "dir001", name: "Dana Director", title: "MD", interim: true },
    });
    expect(mockTxAssignmentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { interim: true } }),
    );
    const auditCall = mockExecuteRaw.mock.calls[0] as unknown[];
    expect(auditCall[4]).toBe("field_override"); // an EXISTING action, not roster_change
    expect(JSON.parse(auditCall[5] as string)).toEqual(["interim"]); // fields_changed
  });

  it("set_interim on an absent holder → 400 holder_not_found, no transaction", async () => {
    const res = await POST(
      post({ ...BASE, action: "set_interim", cwid: "dir001", interim: true }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "holder_not_found" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("interim not a boolean → 400 invalid_value", async () => {
    const res = await POST(
      post({ ...BASE, action: "set_interim", cwid: "dir001", interim: "yes" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_value", field: "interim" });
  });
});

describe("/api/edit/center-leadership — vocabulary + scope gates", () => {
  it("an unknown roleKey → 400 invalid_role (no write persists)", async () => {
    mockTxRoleFindUnique.mockResolvedValue(null);
    const res = await POST(post({ ...BASE, roleKey: "ghost_role", action: "add", cwid: "dir001" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_role" });
    expect(mockTxAssignmentCreate).not.toHaveBeenCalled();
  });

  it("a MEMBERSHIP-group roleKey is rejected on this route → 400 invalid_role", async () => {
    mockTxRoleFindUnique.mockResolvedValue({ roleGroup: "membership", singleHolder: false });
    const res = await POST(post({ ...BASE, roleKey: "member", action: "add", cwid: "dir001" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_role" });
  });

  it("isRoleAllowedAtUnit refuses → 400 role_not_allowed_at_unit, rolls back (no audit)", async () => {
    mockTxScopeFindMany.mockResolvedValue([{ entityId: "some_other_center" }]);
    const res = await POST(post({ ...BASE, action: "add", cwid: "dir001" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "role_not_allowed_at_unit" });
    expect(mockTxAssignmentCreate).not.toHaveBeenCalled();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("a scope allowlist that DOES name this center still allows the write", async () => {
    mockTxScopeFindMany.mockResolvedValue([{ entityId: "meyer_cancer_center" }]);
    const res = await POST(post({ ...BASE, action: "add", cwid: "dir001" }));
    expect(res.status).toBe(200);
  });
});

describe("/api/edit/center-leadership — validation + authz", () => {
  it("unknown center → 400 unit_not_found", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    const res = await POST(post({ ...BASE, action: "add", cwid: "dir001" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unit_not_found" });
  });

  it("non-admin → 403 not_curator (no DB write)", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(post({ ...BASE, action: "add", cwid: "dir001" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_curator" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("invalid cwid → 400 invalid_cwid", async () => {
    const res = await POST(post({ ...BASE, action: "add", cwid: "bad cwid!" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_cwid" });
  });

  it("invalid action → 400 invalid_action", async () => {
    const res = await POST(post({ ...BASE, action: "nuke", cwid: "dir001" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_action" });
  });

  it("empty roleKey → 400 invalid_role", async () => {
    const res = await POST(post({ ...BASE, roleKey: "", action: "add", cwid: "dir001" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_role" });
  });
});
