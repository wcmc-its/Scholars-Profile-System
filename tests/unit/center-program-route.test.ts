/**
 * #1117 — /api/edit/center-program (program leaders + description editor).
 *
 *  - Curator adds / removes / reorders a leader and edits the description.
 *  - add_leader on an existing leader → 200 no-op (no DB write).
 *  - remove_leader of an absent leader → 200 no-op.
 *  - set_leader on an absent leader → 400 leader_not_found.
 *  - set_description with the same value → 200 no-op.
 *  - unknown program for the center → 400 invalid_program_code.
 *  - non-admin → 403 not_curator (authz parity with the roster editor).
 *  - invalid cwid / action → 400.
 *  - every mutation writes a B03 audit row (roster_change | field_override).
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
  mockCenterProgramLeaderFindUnique,
  mockTxLeaderCreate,
  mockTxLeaderDelete,
  mockTxLeaderUpdate,
  mockTxProgramUpdate,
  mockReflectUnitChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockCenterProgramFindUnique: vi.fn(),
  mockCenterProgramLeaderFindUnique: vi.fn(),
  mockTxLeaderCreate: vi.fn(),
  mockTxLeaderDelete: vi.fn(),
  mockTxLeaderUpdate: vi.fn(),
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
      centerProgramLeader: { findUnique: mockCenterProgramLeaderFindUnique },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({ reflectUnitChange: mockReflectUnitChange }));

import { POST } from "@/app/api/edit/center-program/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };

const fakeTx = {
  centerProgramLeader: {
    create: mockTxLeaderCreate,
    delete: mockTxLeaderDelete,
    update: mockTxLeaderUpdate,
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
  mockCenterProgramLeaderFindUnique.mockResolvedValue(null);
  mockTxLeaderCreate.mockResolvedValue({
    cwid: "lead001",
    interim: false,
    role: "leader",
    sortOrder: 0,
  });
  mockTxLeaderUpdate.mockResolvedValue({
    cwid: "lead001",
    interim: true,
    role: "leader",
    sortOrder: 0,
  });
  mockTxLeaderDelete.mockResolvedValue({ cwid: "lead001" });
  mockTxProgramUpdate.mockResolvedValue({ code: "CB" });
});

describe("/api/edit/center-program — leaders", () => {
  it("Curator adds a leader → 200, creates the row + audit + revalidate", async () => {
    const res = await POST(
      post({ ...BASE, action: "add_leader", cwid: "lead001", interim: false, sortOrder: 0 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxLeaderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          centerCode: "meyer_cancer_center",
          programCode: "CB",
          cwid: "lead001",
          interim: false,
          role: "leader", // written explicitly, not left to the column default
          sortOrder: 0,
        },
      }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the audit INSERT
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
    mockCenterProgramLeaderFindUnique.mockResolvedValue({ cwid: "lead001", interim: false, sortOrder: 0 });
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
    mockCenterProgramLeaderFindUnique.mockResolvedValue({ cwid: "lead001", interim: false, sortOrder: 0 });
    const res = await POST(post({ ...BASE, action: "remove_leader", cwid: "lead001" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxLeaderDelete).toHaveBeenCalled();
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("set_leader toggles interim on an existing leader → 200, updates", async () => {
    mockCenterProgramLeaderFindUnique.mockResolvedValue({ cwid: "lead001", interim: false, sortOrder: 0 });
    const res = await POST(post({ ...BASE, action: "set_leader", cwid: "lead001", interim: true }));
    expect(res.status).toBe(200);
    expect(mockTxLeaderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { interim: true } }),
    );
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
    expect(mockTxLeaderCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "coe_liaison" }) }),
    );
  });

  it("set_leader changes an existing leader's role", async () => {
    mockCenterProgramLeaderFindUnique.mockResolvedValue({
      cwid: "lead001",
      interim: false,
      role: "leader",
      sortOrder: 0,
    });
    const res = await POST(
      post({ ...BASE, action: "set_leader", cwid: "lead001", role: "coe_liaison" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxLeaderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "coe_liaison" } }),
    );
  });

  it("set_leader without `role` leaves an existing liaison's role untouched", async () => {
    // The partial-update footgun: toggling interim (or reordering) on a COE liaison
    // must not silently demote them back to `leader`.
    mockCenterProgramLeaderFindUnique.mockResolvedValue({
      cwid: "liai001",
      interim: false,
      role: "coe_liaison",
      sortOrder: 0,
    });
    const res = await POST(post({ ...BASE, action: "set_leader", cwid: "liai001", interim: true }));
    expect(res.status).toBe(200);
    expect(mockTxLeaderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { interim: true } }), // no `role` key
    );
    const data = mockTxLeaderUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect("role" in data).toBe(false);
  });

  it("an unknown role → 400 invalid_value (no write)", async () => {
    mockCenterProgramLeaderFindUnique.mockResolvedValue({
      cwid: "lead001",
      interim: false,
      role: "leader",
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
