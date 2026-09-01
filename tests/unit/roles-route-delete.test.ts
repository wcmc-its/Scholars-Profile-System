/**
 * `DELETE /api/edit/roles` — the role-vocabulary console's delete follow-up
 * (#2542 Phase 3). Only a `manual`, zero-holder entry may be deleted; a
 * `seed` entry or one with any live holder (leadership `OrgUnitRoleAssignment`,
 * membership `CenterMembership.membershipRoleKey`, or — for `core` roles only —
 * `CoreLeader.role`) refuses with 409. See the route's DELETE docblock
 * (`app/api/edit/roles/route.ts`) for the exact gate order this file locks
 * down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  isOrgUnitRoleConsoleEnabled: vi.fn(),
  tx: {
    orgUnitRole: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    orgUnitRoleScope: {
      deleteMany: vi.fn(),
    },
    orgUnitRoleAssignment: {
      count: vi.fn(),
    },
    centerMembership: {
      count: vi.fn(),
    },
    coreLeader: {
      count: vi.fn(),
    },
  },
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/edit/org-unit-role-flags", () => ({
  isOrgUnitRoleConsoleEnabled: h.isOrgUnitRoleConsoleEnabled,
}));
vi.mock("@/lib/db", () => ({
  db: { write: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(h.tx)) } },
}));

import { DELETE } from "@/app/api/edit/roles/route";

const STEWARD = { cwid: "cur1001", isSuperuser: false, isCommsSteward: true };
const NON_STEWARD = { cwid: "non1001", isSuperuser: false, isCommsSteward: false };

const EXISTING_ROLE = {
  entityType: "center",
  key: "deputy_director",
  label: "Deputy Director",
  roleGroup: "leadership",
  scope: "unit",
  singleHolder: false,
  sortOrder: 100,
  profileTitle: true,
  source: "manual",
};

function del(body: unknown, ctx?: { session?: unknown; realCwid?: string }) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session: ctx?.session ?? STEWARD,
      realCwid: ctx?.realCwid ?? (ctx?.session as { cwid?: string } | undefined)?.cwid ?? "cur1001",
      impersonatedCwid: null,
      body,
      requestId: "req-del-1",
    },
  });
  return new Request("http://x/api/edit/roles", { method: "DELETE" });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isOrgUnitRoleConsoleEnabled.mockReturnValue(true);
  h.tx.orgUnitRole.findUnique.mockResolvedValue(EXISTING_ROLE);
  h.tx.orgUnitRole.delete.mockResolvedValue(EXISTING_ROLE);
  h.tx.orgUnitRoleScope.deleteMany.mockResolvedValue({ count: 0 });
  h.tx.orgUnitRoleAssignment.count.mockResolvedValue(0);
  h.tx.centerMembership.count.mockResolvedValue(0);
  h.tx.coreLeader.count.mockResolvedValue(0);
});

describe("DELETE /api/edit/roles — happy path", () => {
  it("deletes a manual, zero-holder role: removes scope rows, deletes the role, and audits it", async () => {
    h.tx.orgUnitRoleScope.deleteMany.mockResolvedValue({ count: 2 });
    const res = await DELETE(del({ entityType: "center", key: "deputy_director" }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, entityType: "center", key: "deputy_director" });

    expect(h.tx.orgUnitRoleScope.deleteMany).toHaveBeenCalledWith({
      where: { entityType: "center", roleKey: "deputy_director" },
    });
    expect(h.tx.orgUnitRole.delete).toHaveBeenCalledWith({
      where: { entityType_key: { entityType: "center", key: "deputy_director" } },
    });

    expect(h.appendAuditRow).toHaveBeenCalledTimes(1);
    const [tx, row] = h.appendAuditRow.mock.calls[0];
    expect(tx).toBe(h.tx); // same transaction as the delete
    expect(row).toMatchObject({
      actorCwid: "cur1001",
      targetEntityType: "org_unit_role",
      targetEntityId: "center:deputy_director",
      action: "role_vocabulary_delete",
      afterValues: null,
    });
    expect(row.beforeValues).toMatchObject({
      label: "Deputy Director",
      roleGroup: "leadership",
      scope: "unit",
      scopeRowsRemoved: 2,
    });
  });

  it("actorCwid is the REAL cwid, never the impersonated session cwid", async () => {
    h.readEditRequest.mockResolvedValue({
      ok: true,
      ctx: {
        session: { cwid: "target001", isSuperuser: false, isCommsSteward: true },
        realCwid: "realsteward1",
        impersonatedCwid: "target001",
        body: { entityType: "center", key: "deputy_director" },
        requestId: "req-del-2",
      },
    });
    await DELETE(new Request("http://x/api/edit/roles", { method: "DELETE" }) as never);
    const row = h.appendAuditRow.mock.calls[0][1];
    expect(row.actorCwid).toBe("realsteward1");
    expect(row.impersonatedCwid).toBe("target001");
  });
});

describe("DELETE /api/edit/roles — refusals", () => {
  it("409 seeded_default when source !== 'manual' — no write happens", async () => {
    h.tx.orgUnitRole.findUnique.mockResolvedValue({ ...EXISTING_ROLE, source: "seed" });
    const res = await DELETE(del({ entityType: "center", key: "director" }) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("seeded_default");
    expect(body.reason).toMatch(/re-seeds DEFAULT_ORG_UNIT_ROLES/);
    expect(h.tx.orgUnitRole.delete).not.toHaveBeenCalled();
    expect(h.tx.orgUnitRoleScope.deleteMany).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("409 role_has_holders with the live count when OrgUnitRoleAssignment rows exist", async () => {
    h.tx.orgUnitRoleAssignment.count.mockResolvedValue(3);
    const res = await DELETE(del({ entityType: "center", key: "deputy_director" }) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "role_has_holders", holderCount: 3 });
    expect(h.tx.orgUnitRole.delete).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("409 role_has_holders with the live count when CenterMembership rows exist", async () => {
    h.tx.centerMembership.count.mockResolvedValue(42);
    const res = await DELETE(del({ entityType: "center", key: "research" }) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "role_has_holders", holderCount: 42 });
    expect(h.tx.orgUnitRole.delete).not.toHaveBeenCalled();
  });

  it("409 role_has_holders sums BOTH sources", async () => {
    h.tx.orgUnitRoleAssignment.count.mockResolvedValue(2);
    h.tx.centerMembership.count.mockResolvedValue(5);
    const res = await DELETE(del({ entityType: "center", key: "deputy_director" }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).holderCount).toBe(7);
  });

  it("409 role_has_holders when the only holder is a CoreLeader row (entityType 'core')", async () => {
    h.tx.orgUnitRole.findUnique.mockResolvedValue({
      ...EXISTING_ROLE,
      entityType: "core",
      key: "co_director",
    });
    h.tx.coreLeader.count.mockResolvedValue(1);
    const res = await DELETE(del({ entityType: "core", key: "co_director" }) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "role_has_holders", holderCount: 1 });
    expect(h.tx.coreLeader.count).toHaveBeenCalledWith({ where: { role: "co_director" } });
    expect(h.tx.orgUnitRole.delete).not.toHaveBeenCalled();
  });

  it("does NOT consult coreLeader for a non-core entityType", async () => {
    h.tx.coreLeader.count.mockResolvedValue(9); // would 409 if wrongly consulted
    const res = await DELETE(del({ entityType: "center", key: "deputy_director" }) as never);
    expect(res.status).toBe(200);
    expect(h.tx.coreLeader.count).not.toHaveBeenCalled();
  });

  it("404 not_found when the role does not exist", async () => {
    h.tx.orgUnitRole.findUnique.mockResolvedValue(null);
    const res = await DELETE(del({ entityType: "center", key: "nope" }) as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_found" });
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("404 when ORG_UNIT_ROLE_CONSOLE is off, before any DB read", async () => {
    h.isOrgUnitRoleConsoleEnabled.mockReturnValue(false);
    const res = await DELETE(del({ entityType: "center", key: "deputy_director" }) as never);
    expect(res.status).toBe(404);
    expect(h.readEditRequest).not.toHaveBeenCalled();
    expect(h.tx.orgUnitRole.findUnique).not.toHaveBeenCalled();
  });

  it("403 not_comms_steward for a non-steward, non-superuser actor — no DB write", async () => {
    const res = await DELETE(
      del({ entityType: "center", key: "deputy_director" }, { session: NON_STEWARD }) as never,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_comms_steward" });
    expect(h.tx.orgUnitRole.findUnique).not.toHaveBeenCalled();
  });

  it("400 unexpected_field for an unrecognized top-level body field", async () => {
    const res = await DELETE(
      del({ entityType: "center", key: "deputy_director", label: "nope" }) as never,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unexpected_field", field: "label" });
  });

  it("400 invalid_entity_type for an unknown unit kind", async () => {
    const res = await DELETE(del({ entityType: "planet", key: "deputy_director" }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_entity_type" });
  });
});
