/**
 * cores-as-org-units P3 — /api/edit/core (description / url / visible /
 * CoreLeader CRUD).
 *
 *  - Owner/Curator set description / url / visible → 200, writes + audit.
 *  - Unchanged value → 200 no-op (no transaction).
 *  - Invalid description / url / visible → 400.
 *  - Curator adds / removes / reorders a leader; edits an open-string role.
 *  - add_leader on an existing leader → 200 no-op.
 *  - remove_leader of an absent leader → 200 no-op.
 *  - set_leader on an absent leader → 400 leader_not_found.
 *  - Non-admin → 403 not_core_owner (authz parity with the claim queue).
 *  - Superuser may act with no UnitAdmin row at all.
 *  - Unknown core → 404 core_not_found.
 *  - Every mutation writes a B03 audit row (field_override | roster_change).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockExecuteRaw,
  mockCoreFindUnique,
  mockUnitAdminFindUnique,
  mockCoreLeaderFindUnique,
  mockTxLeaderCreate,
  mockTxLeaderDelete,
  mockTxLeaderUpdate,
  mockTxCoreUpdate,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockCoreFindUnique: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockCoreLeaderFindUnique: vi.fn(),
  mockTxLeaderCreate: vi.fn(),
  mockTxLeaderDelete: vi.fn(),
  mockTxLeaderUpdate: vi.fn(),
  mockTxCoreUpdate: vi.fn(),
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
      core: { findUnique: mockCoreFindUnique },
      unitAdmin: { findUnique: mockUnitAdminFindUnique },
      coreLeader: { findUnique: mockCoreLeaderFindUnique },
    },
    write: { $transaction: mockTransaction },
  },
}));

import { POST } from "@/app/api/edit/core/route";

const OWNER = { cwid: "own001", isSuperuser: false };
const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };
const SUPERUSER = { cwid: "sup001", isSuperuser: true };

const fakeTx = {
  coreLeader: { create: mockTxLeaderCreate, delete: mockTxLeaderDelete, update: mockTxLeaderUpdate },
  core: { update: mockTxCoreUpdate },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/core", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const BASE = { coreId: "2" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(OWNER);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockExecuteRaw.mockResolvedValue(1);
  mockCoreFindUnique.mockResolvedValue({
    id: "2",
    description: "Old blurb.",
    url: "https://old.example.edu",
    visible: false,
  });
  // getCoreOwnerRole: OWNER owns core "2".
  mockUnitAdminFindUnique.mockResolvedValue({ role: "owner" });
  mockCoreLeaderFindUnique.mockResolvedValue(null);
  mockTxLeaderCreate.mockResolvedValue({
    cwid: "lead001",
    role: "director",
    interim: false,
    sortOrder: 0,
  });
  mockTxLeaderUpdate.mockResolvedValue({
    cwid: "lead001",
    role: "director",
    interim: true,
    sortOrder: 0,
  });
  mockTxLeaderDelete.mockResolvedValue({ cwid: "lead001" });
  mockTxCoreUpdate.mockResolvedValue({ id: "2" });
});

describe("/api/edit/core — leaders", () => {
  it("Owner adds a leader → 200, creates the row (default role) + audit", async () => {
    const res = await POST(post({ ...BASE, action: "add_leader", cwid: "lead001", sortOrder: 0 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxLeaderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { coreId: "2", cwid: "lead001", role: "director", interim: false, sortOrder: 0 },
      }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the audit INSERT
  });

  it("Owner adds a leader with a custom open-string role", async () => {
    const res = await POST(
      post({ ...BASE, action: "add_leader", cwid: "lead001", role: "co-director", sortOrder: 0 }),
    );
    expect(res.status).toBe(200);
    expect(mockTxLeaderCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "co-director" }) }),
    );
  });

  it("add_leader on an existing leader → 200 no-op (no write)", async () => {
    mockCoreLeaderFindUnique.mockResolvedValue({
      cwid: "lead001",
      role: "director",
      interim: false,
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
    mockCoreLeaderFindUnique.mockResolvedValue({
      cwid: "lead001",
      role: "director",
      interim: false,
      sortOrder: 0,
    });
    const res = await POST(post({ ...BASE, action: "remove_leader", cwid: "lead001" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxLeaderDelete).toHaveBeenCalled();
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("set_leader toggles interim on an existing leader → 200, updates only interim", async () => {
    mockCoreLeaderFindUnique.mockResolvedValue({
      cwid: "lead001",
      role: "director",
      interim: false,
      sortOrder: 0,
    });
    const res = await POST(post({ ...BASE, action: "set_leader", cwid: "lead001", interim: true }));
    expect(res.status).toBe(200);
    expect(mockTxLeaderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { interim: true } }),
    );
  });

  it("set_leader without `role` leaves an existing leader's role untouched (partial update)", async () => {
    mockCoreLeaderFindUnique.mockResolvedValue({
      cwid: "lead001",
      role: "co-director",
      interim: false,
      sortOrder: 0,
    });
    const res = await POST(post({ ...BASE, action: "set_leader", cwid: "lead001", interim: true }));
    expect(res.status).toBe(200);
    const data = mockTxLeaderUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect("role" in data).toBe(false);
  });

  it("set_leader changes an existing leader's open-string role", async () => {
    mockCoreLeaderFindUnique.mockResolvedValue({
      cwid: "lead001",
      role: "director",
      interim: false,
      sortOrder: 0,
    });
    const res = await POST(
      post({ ...BASE, action: "set_leader", cwid: "lead001", role: "associate director" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxLeaderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "associate director" } }),
    );
  });

  it("set_leader on an absent leader → 400 leader_not_found", async () => {
    const res = await POST(post({ ...BASE, action: "set_leader", cwid: "lead001", interim: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "leader_not_found" });
  });

  it("an empty role → 400 invalid_value (no write)", async () => {
    const res = await POST(post({ ...BASE, action: "add_leader", cwid: "lead001", role: "  " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_value", field: "role" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a role over 32 chars → 400 invalid_value", async () => {
    const res = await POST(
      post({ ...BASE, action: "add_leader", cwid: "lead001", role: "x".repeat(33) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_value", field: "role" });
  });

  it("an out-of-range sortOrder → 400 invalid_value", async () => {
    const res = await POST(
      post({ ...BASE, action: "add_leader", cwid: "lead001", sortOrder: -1 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_value", field: "sortOrder" });
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

describe("/api/edit/core — description / url / visible", () => {
  it("set_description writes the new value + audit", async () => {
    const res = await POST(post({ ...BASE, action: "set_description", description: "New blurb." }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxCoreUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "2" }, data: { description: "New blurb." } }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
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
    expect(mockTxCoreUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { description: null } }),
    );
  });

  it("an over-limit description → 400 description_too_long (no write)", async () => {
    const res = await POST(
      post({ ...BASE, action: "set_description", description: "x".repeat(4001) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "description_too_long" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("set_url writes the new value + audit", async () => {
    const res = await POST(
      post({ ...BASE, action: "set_url", url: "https://core.example.edu" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCoreUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { url: "https://core.example.edu" } }),
    );
  });

  it("a non-https url → 400 invalid_url (no write)", async () => {
    const res = await POST(post({ ...BASE, action: "set_url", url: "http://core.example.edu" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_url" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("set_url to the same value → 200 no-op", async () => {
    const res = await POST(
      post({ ...BASE, action: "set_url", url: "https://old.example.edu" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("set_visible flips the toggle + audit", async () => {
    const res = await POST(post({ ...BASE, action: "set_visible", visible: true }));
    expect(res.status).toBe(200);
    expect(mockTxCoreUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { visible: true } }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("set_visible to the current value → 200 no-op", async () => {
    const res = await POST(post({ ...BASE, action: "set_visible", visible: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a non-boolean visible → 400 invalid_value", async () => {
    const res = await POST(post({ ...BASE, action: "set_visible", visible: "yes" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_value", field: "visible" });
  });
});

describe("/api/edit/core — authz + existence", () => {
  it("Curator may edit content at the same parity as an Owner", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindUnique.mockResolvedValue({ role: "curator" });
    const res = await POST(post({ ...BASE, action: "set_description", description: "New blurb." }));
    expect(res.status).toBe(200);
  });

  it("Non-admin → 403 not_core_owner (no DB write)", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindUnique.mockResolvedValue(null);
    const res = await POST(post({ ...BASE, action: "set_description", description: "New blurb." }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_core_owner" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("Superuser may act with no UnitAdmin row on the core at all", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindUnique.mockResolvedValue(null);
    const res = await POST(post({ ...BASE, action: "set_visible", visible: true }));
    expect(res.status).toBe(200);
  });

  // 2026-08-26 policy widening (decision #6) — full curator-parity on cores,
  // with no UnitAdmin row of their own (cores were previously "a separate
  // domain" with no comms_steward parity at all).
  it("comms_steward may act with no UnitAdmin row on the core at all", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "stw001", isSuperuser: false, isCommsSteward: true });
    mockUnitAdminFindUnique.mockResolvedValue(null);
    const res = await POST(post({ ...BASE, action: "set_visible", visible: true }));
    expect(res.status).toBe(200);
  });

  it("Unknown core → 404 core_not_found", async () => {
    mockCoreFindUnique.mockResolvedValue(null);
    const res = await POST(post({ ...BASE, action: "set_description", description: "New blurb." }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "core_not_found" });
  });
});
