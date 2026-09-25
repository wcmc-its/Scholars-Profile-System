/**
 * POST /api/edit/functional-roles — gating, validation, and dispatch. The real
 * `readEditRequest` preamble runs (origin stubbed ok); the session seams are
 * mocked, and the lib's writes are mocked at the module boundary (their own
 * logic is covered in `functional-roles.test.ts`). The route answers with the
 * rows the WRITE returned, never a separate reader read.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getEffectiveEditSession: vi.fn(),
  getSession: vi.fn(),
  impersonationActive: vi.fn(),
  logEditDenial: vi.fn(),
  grant: vi.fn(),
  setScopes: vi.fn(),
  revoke: vi.fn(),
  runImport: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.getEffectiveEditSession,
  impersonationActive: h.impersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.getSession }));
vi.mock("@/lib/auth/session", () => ({ nowSeconds: () => 1_000 }));
vi.mock("@/lib/edit/authz", () => ({
  verifyRequestOrigin: () => ({ ok: true }),
  logEditDenial: h.logEditDenial,
}));
vi.mock("@/lib/edit/functional-roles.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/functional-roles.server")>();
  return {
    ...actual,
    grantFunctionalRole: h.grant,
    setFunctionalRoleScopes: h.setScopes,
    revokeFunctionalRole: h.revoke,
    importFunctionalRoles: h.runImport,
  };
});
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import { POST } from "@/app/api/edit/functional-roles/route";

const ADMIN = "adm0001";

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/edit/functional-roles", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

function as(cwid: string, roles: { isSuperuser?: boolean; isCommsSteward?: boolean } = {}) {
  h.getEffectiveEditSession.mockResolvedValue({
    cwid,
    isSuperuser: roles.isSuperuser ?? false,
    isCommsSteward: roles.isCommsSteward ?? false,
  });
  h.getSession.mockResolvedValue({ cwid, iat: 0, exp: 0 });
  h.impersonationActive.mockReturnValue(false);
}

const ROWS = [
  {
    role: "reporting",
    cwid: "fake001",
    source: "manual",
    scopes: ["*"],
    name: "Pat Example",
    title: null,
    granteeName: "Pat Example",
    grantedBy: ADMIN,
    grantedByName: null,
    grantedAt: "2026-09-25T12:00:00.000Z",
  },
];

const GRANT = {
  op: "grant",
  role: "reporting",
  cwid: "Fake001",
  scopes: ["article-count"],
  name: " Pat Example ",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  as(ADMIN, { isSuperuser: true });
  h.grant.mockResolvedValue({ changed: true, conflict: false, rows: ROWS });
  h.setScopes.mockResolvedValue({ found: true, changed: true, rows: ROWS });
  h.revoke.mockResolvedValue({ changed: true, rows: ROWS });
  h.runImport.mockResolvedValue({ added: 2, updated: 0, removed: 1, rows: ROWS });
});

describe("POST /api/edit/functional-roles — gating", () => {
  it("401 with no session", async () => {
    h.getEffectiveEditSession.mockResolvedValue(null);
    const res = await POST(post(GRANT));
    expect(res.status).toBe(401);
    expect(h.grant).not.toHaveBeenCalled();
  });

  it.each([
    ["a plain user", {}],
    ["a comms_steward (superuser-only surface)", { isCommsSteward: true }],
  ])("403 not_superuser for %s, before any field is validated", async (_label, roles) => {
    as("usr0001", roles);
    const res = await POST(post({ op: "bogus" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_superuser" });
    expect(h.logEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not_superuser" }),
    );
    expect(h.grant).not.toHaveBeenCalled();
    expect(h.runImport).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/functional-roles — validation", () => {
  it.each([
    [{ ...GRANT, op: "delete" }, "invalid_op"],
    [{ ...GRANT, role: "superuser" }, "invalid_role"],
    [{ ...GRANT, role: "toString" }, "invalid_role"],
    [{ ...GRANT, cwid: "1abc" }, "invalid_cwid"],
    [{ ...GRANT, cwid: 42 }, "invalid_cwid"],
    [{ ...GRANT, scopes: [] }, "invalid_scopes"],
    [{ ...GRANT, scopes: "article-count" }, "invalid_scopes"],
    [{ ...GRANT, scopes: ["nope"] }, "invalid_scopes"],
    [{ ...GRANT, scopes: [3] }, "invalid_scopes"],
    [{ ...GRANT, role: "external_affairs", scopes: ["article-count"] }, "invalid_scopes"],
    // External Affairs has no wildcard: functions are named explicitly.
    [{ ...GRANT, role: "external_affairs", scopes: ["*"] }, "invalid_scopes"],
    [{ ...GRANT, role: "external_affairs", scopes: ["communications", "x"] }, "invalid_scopes"],
    // The retired split roles are not in the vocabulary.
    [{ ...GRANT, role: "external_communications", scopes: ["*"] }, "invalid_role"],
    [{ ...GRANT, role: "development", scopes: ["*"] }, "invalid_role"],
    [{ ...GRANT, op: "set_scopes", scopes: [] }, "invalid_scopes"],
  ])("400 for %j → %s", async (body, error) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error });
    expect(h.grant).not.toHaveBeenCalled();
    expect(h.setScopes).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/functional-roles — dispatch", () => {
  it("grant: lowercases the cwid, normalizes scopes, trims the name, keys the audit on the real actor", async () => {
    const res = await POST(post({ ...GRANT, scopes: ["article-count", "*"] }));
    expect(res.status).toBe(200);
    expect(h.grant).toHaveBeenCalledWith({
      actorCwid: ADMIN,
      impersonatedCwid: null,
      requestId: expect.any(String),
      role: "reporting",
      cwid: "fake001",
      scopes: ["*"],
      granteeName: "Pat Example",
    });
    expect(await res.json()).toMatchObject({ ok: true, op: "grant", changed: true, rows: ROWS });
  });

  it("grant External Affairs: the functions are the scopes, normalized", async () => {
    const res = await POST(
      post({ ...GRANT, role: "external_affairs", scopes: ["development", "communications"] }),
    );
    expect(res.status).toBe(200);
    expect(h.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "external_affairs",
        cwid: "fake001",
        scopes: ["communications", "development"],
      }),
    );
  });

  it("grant for someone who already holds the role manually with other scopes → 409 already_granted", async () => {
    h.grant.mockResolvedValue({ changed: false, conflict: true, rows: ROWS });
    const res = await POST(post(GRANT));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "already_granted" });
  });

  it("grant repeating the same scopes stays an idempotent 200", async () => {
    h.grant.mockResolvedValue({ changed: false, conflict: false, rows: ROWS });
    const res = await POST(post(GRANT));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
  });

  it("set_scopes on a person with no manual row → 404 not_found", async () => {
    h.setScopes.mockResolvedValue({ found: false, changed: false, rows: ROWS });
    const res = await POST(post({ ...GRANT, op: "set_scopes" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });

  it("set_scopes → the scope write", async () => {
    const res = await POST(post({ ...GRANT, op: "set_scopes" }));
    expect(res.status).toBe(200);
    expect(h.setScopes).toHaveBeenCalledWith(
      expect.objectContaining({ role: "reporting", cwid: "fake001", scopes: ["article-count"] }),
    );
  });

  it("revoke needs no scopes", async () => {
    const res = await POST(post({ op: "revoke", role: "external_affairs", cwid: "fake001" }));
    expect(res.status).toBe(200);
    expect(h.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ role: "external_affairs", cwid: "fake001" }),
    );
  });

  it("import reads no role/cwid and reports the counts", async () => {
    const res = await POST(post({ op: "import" }));
    expect(res.status).toBe(200);
    expect(h.runImport).toHaveBeenCalledWith({
      actorCwid: ADMIN,
      impersonatedCwid: null,
      requestId: expect.any(String),
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      op: "import",
      changed: true,
      added: 2,
      removed: 1,
      rows: ROWS,
    });
  });

  it("a thrown write → 500 write_failed", async () => {
    h.grant.mockRejectedValue(new Error("db down"));
    const res = await POST(post(GRANT));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
