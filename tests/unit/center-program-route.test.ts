/**
 * #1117 / #2558 — /api/edit/center-program (program leaders + description editor).
 *
 * #2558 contract PR: the route writes `OrgUnitRoleAssignment` rows
 * (`entityType: "center_program"`, `entityId: "{centerCode}:{programCode}"`)
 * instead of the retired per-program leader table, and audits against
 * `targetEntityType: "center_program"` instead of `"center"`.
 *
 *  - Curator adds / removes / reorders a leader and edits the description.
 *  - add_leader on an existing leader → 200 no-op (no DB write).
 *  - remove_leader of an absent leader → 200 no-op.
 *  - set_leader on an absent leader → 400 leader_not_found.
 *  - set_description with the same value → 200 no-op.
 *  - unknown program for the center → 400 invalid_program_code.
 *  - non-admin → 403 not_curator (authz parity with the roster editor).
 *  - invalid cwid / action → 400.
 *  - every mutation writes a B03 audit row (roster_change | field_override)
 *    against `targetEntityType: "center_program"`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockExecuteRaw,
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockCenterProgramFindUnique,
  mockAssignmentFindFirst,
  mockTxRoleCreateMany,
  mockTxAssignmentCreate,
  mockTxAssignmentDelete,
  mockTxAssignmentUpdate,
  mockTxProgramUpdate,
  mockReflectUnitChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockCenterProgramFindUnique: vi.fn(),
  mockAssignmentFindFirst: vi.fn(),
  mockTxRoleCreateMany: vi.fn(),
  mockTxAssignmentCreate: vi.fn(),
  mockTxAssignmentDelete: vi.fn(),
  mockTxAssignmentUpdate: vi.fn(),
  mockTxProgramUpdate: vi.fn(),
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
      centerProgram: { findUnique: mockCenterProgramFindUnique },
      orgUnitRoleAssignment: { findFirst: mockAssignmentFindFirst },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({ reflectUnitChange: mockReflectUnitChange }));

import { POST } from "@/app/api/edit/center-program/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };

const fakeTx = {
  orgUnitRole: { createMany: mockTxRoleCreateMany },
  orgUnitRoleAssignment: {
    create: mockTxAssignmentCreate,
    delete: mockTxAssignmentDelete,
    update: mockTxAssignmentUpdate,
  },
  centerProgram: { update: mockTxProgramUpdate },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/center-program", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const BASE = { centerCode: "meyer_cancer_center", programCode: "CB" };
const ENTITY_ID = "meyer_cancer_center:CB";

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
  mockCenterProgramFindUnique.mockResolvedValue({ code: "CB", description: "Old blurb." });
  mockAssignmentFindFirst.mockResolvedValue(null);
  mockTxRoleCreateMany.mockResolvedValue({ count: 0 });
  mockTxAssignmentCreate.mockResolvedValue({
    cwid: "lead001",
    interim: false,
    roleKey: "leader",
    sortOrder: 0,
  });
  mockTxAssignmentUpdate.mockResolvedValue({
    cwid: "lead001",
    interim: true,
    roleKey: "leader",
    sortOrder: 0,
  });
  mockTxAssignmentDelete.mockResolvedValue({ cwid: "lead001" });
  mockTxProgramUpdate.mockResolvedValue({ code: "CB" });
});

describe("/api/edit/center-program — leaders", () => {
  it("Curator adds a leader → 200, creates the row + audit + revalidate", async () => {
    const res = await POST(
      post({ ...BASE, action: "add_leader", cwid: "lead001", interim: false, sortOrder: 0 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    // Seeds the vocabulary first (idempotent — mirrors the director write path).
    expect(mockTxRoleCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(mockTxAssignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          entityType: "center_program",
          entityId: ENTITY_ID,
          cwid: "lead001",
          roleKey: "leader", // written explicitly, not left to a column default
          interim: false,
          sortOrder: 0,
        },
      }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the audit INSERT
    // Audits against the program, not the center (#2558).
    const auditCall = mockExecuteRaw.mock.calls[0] as unknown[];
    expect(auditCall[2]).toBe("center_program"); // target_entity_type
    expect(auditCall[3]).toBe(ENTITY_ID); // target_entity_id
    expect(auditCall[4]).toBe("roster_change"); // action — an EXISTING value
    // Purges the center page AND the program's own ISR page (#1117).
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        unitKind: "center",
        unitSlug: "meyer-cancer-center",
        programCode: "CB",
      }),
    );
  });

  it("add_leader on an existing leader → 200 no-op (no write)", async () => {
    mockAssignmentFindFirst.mockResolvedValue({
      cwid: "lead001",
      interim: false,
      roleKey: "leader",
      sortOrder: 0,
    });
    const res = await POST(post({ ...BASE, action: "add_leader", cwid: "lead001" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("remove_leader of an absent leader → 200 no-op", async () => {
    const res = await POST(post({ ...BASE, action: "remove_leader", cwid: "lead001" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("remove_leader of an existing leader → 200, deletes + audit", async () => {
    mockAssignmentFindFirst.mockResolvedValue({
      cwid: "lead001",
      interim: false,
      roleKey: "leader",
      sortOrder: 0,
    });
    const res = await POST(post({ ...BASE, action: "remove_leader", cwid: "lead001" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxAssignmentDelete).toHaveBeenCalledWith({
      where: {
        entityType_entityId_cwid_roleKey: {
          entityType: "center_program",
          entityId: ENTITY_ID,
          cwid: "lead001",
          roleKey: "leader",
        },
      },
    });
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("set_leader toggles interim on an existing leader → 200, updates", async () => {
    mockAssignmentFindFirst.mockResolvedValue({
      cwid: "lead001",
      interim: false,
      roleKey: "leader",
      sortOrder: 0,
    });
    const res = await POST(post({ ...BASE, action: "set_leader", cwid: "lead001", interim: true }));
    expect(res.status).toBe(200);
    expect(mockTxAssignmentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { interim: true } }),
    );
    // Same-role update never moves the row — no delete/create pair.
    expect(mockTxAssignmentDelete).not.toHaveBeenCalled();
    expect(mockTxAssignmentCreate).not.toHaveBeenCalled();
  });

  it("set_leader on an absent leader → 400 leader_not_found", async () => {
    const res = await POST(post({ ...BASE, action: "set_leader", cwid: "lead001", interim: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "leader_not_found" });
  });

  // -------------------------------------------------------- #1570 leadership type

  it("add_leader accepts role=coe_liaison", async () => {
    const res = await POST(
      post({ ...BASE, action: "add_leader", cwid: "liai001", role: "coe_liaison", sortOrder: 0 }),
    );
    expect(res.status).toBe(200);
    expect(mockTxAssignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roleKey: "coe_liaison" }) }),
    );
  });

  it("set_leader changes an existing leader's role — moves the assignment (delete + create)", async () => {
    // `roleKey` is part of the assignment's composite id, so a role change
    // cannot be a plain UPDATE; it must delete the old (…, "leader") row and
    // create a new (…, "coe_liaison") one, carrying interim/sortOrder across.
    mockAssignmentFindFirst.mockResolvedValue({
      cwid: "lead001",
      interim: true,
      roleKey: "leader",
      sortOrder: 3,
    });
    const res = await POST(
      post({ ...BASE, action: "set_leader", cwid: "lead001", role: "coe_liaison" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxAssignmentDelete).toHaveBeenCalledWith({
      where: {
        entityType_entityId_cwid_roleKey: {
          entityType: "center_program",
          entityId: ENTITY_ID,
          cwid: "lead001",
          roleKey: "leader",
        },
      },
    });
    expect(mockTxAssignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          entityType: "center_program",
          entityId: ENTITY_ID,
          cwid: "lead001",
          roleKey: "coe_liaison",
          // Carried across from the existing row — this request didn't set them.
          interim: true,
          sortOrder: 3,
        },
      }),
    );
    expect(mockTxAssignmentUpdate).not.toHaveBeenCalled();
  });

  it("set_leader without `role` leaves an existing liaison's role untouched", async () => {
    // The partial-update footgun: toggling interim (or reordering) on a COE liaison
    // must not silently demote them back to `leader`.
    mockAssignmentFindFirst.mockResolvedValue({
      cwid: "liai001",
      interim: false,
      roleKey: "coe_liaison",
      sortOrder: 0,
    });
    const res = await POST(post({ ...BASE, action: "set_leader", cwid: "liai001", interim: true }));
    expect(res.status).toBe(200);
    expect(mockTxAssignmentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { interim: true } }), // no `sortOrder` key
    );
    const data = mockTxAssignmentUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect("sortOrder" in data).toBe(false);
    expect(mockTxAssignmentDelete).not.toHaveBeenCalled();
  });

  it("an unknown role → 400 invalid_value (no write)", async () => {
    mockAssignmentFindFirst.mockResolvedValue({
      cwid: "lead001",
      interim: false,
      roleKey: "leader",
      sortOrder: 0,
    });
    const res = await POST(
      post({ ...BASE, action: "set_leader", cwid: "lead001", role: "director" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_value", field: "role" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("/api/edit/center-program — description", () => {
  it("set_description writes the new value + audit", async () => {
    const res = await POST(post({ ...BASE, action: "set_description", description: "New blurb." }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxProgramUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { description: "New blurb." } }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const auditCall = mockExecuteRaw.mock.calls[0] as unknown[];
    expect(auditCall[2]).toBe("center_program"); // target_entity_type
    expect(auditCall[3]).toBe(ENTITY_ID); // target_entity_id
    expect(auditCall[4]).toBe("field_override"); // action — an EXISTING value
    // Must purge the program's ISR page too — description renders there (#1117).
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "center", unitSlug: "meyer-cancer-center", programCode: "CB" }),
    );
  });

  it("set_description to the same value → 200 no-op (no write)", async () => {
    const res = await POST(post({ ...BASE, action: "set_description", description: "Old blurb." }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('clearing the description ("") writes null', async () => {
    const res = await POST(post({ ...BASE, action: "set_description", description: "" }));
    expect(res.status).toBe(200);
    expect(mockTxProgramUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { description: null } }),
    );
  });
});

describe("/api/edit/center-program — validation + authz", () => {
  it("unknown program for the center → 400 invalid_program_code", async () => {
    mockCenterProgramFindUnique.mockResolvedValue(null);
    const res = await POST(post({ ...BASE, action: "add_leader", cwid: "lead001" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_program_code" });
  });

  it("unknown center → 400 unit_not_found", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    const res = await POST(post({ ...BASE, action: "add_leader", cwid: "lead001" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unit_not_found" });
  });

  it("non-admin → 403 not_curator (no DB write)", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(post({ ...BASE, action: "add_leader", cwid: "lead001" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_curator" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("invalid cwid → 400 invalid_cwid", async () => {
    const res = await POST(post({ ...BASE, action: "add_leader", cwid: "bad cwid!" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_cwid" });
  });

  it("invalid action → 400 invalid_action", async () => {
    const res = await POST(post({ ...BASE, action: "nuke_leader", cwid: "lead001" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_action" });
  });
});
