/**
 * Route tests for `/api/edit/appointment` (#1568) — the CRUD surface for a
 * scholar's SELF-ASSERTED appointments (`profile_appointment`).
 *
 * These pin the SECURITY boundary (`authorizeOverviewWrite`, keyed on the owning
 * scholar) and the write wiring (one transaction + one B03 audit row per
 * mutation, its own `profile_appointment_*` action). The mock harness mirrors
 * `appointment-visibility-route.test.ts`, the sibling route that shares the same
 * authz predicate.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockPaFindUnique,
  mockPaFindMany,
  mockScholarProxyFindUnique,
  mockScholarFindUnique,
  mockDivisionMembershipFindMany,
  mockDivisionFindMany,
  mockUnitAdminFindMany,
  mockTransaction,
  mockTxPaCreate,
  mockTxPaUpdate,
  mockTxPaDelete,
  mockTxExecuteRaw,
  mockResolveProfiles,
  mockReflectVisibilityChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockPaFindUnique: vi.fn(),
  mockPaFindMany: vi.fn(),
  mockScholarProxyFindUnique: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxPaCreate: vi.fn(),
  mockTxPaUpdate: vi.fn(),
  mockTxPaDelete: vi.fn(),
  mockTxExecuteRaw: vi.fn(),
  mockResolveProfiles: vi.fn(),
  mockReflectVisibilityChange: vi.fn(),
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
      profileAppointment: { findUnique: mockPaFindUnique, findMany: mockPaFindMany },
      // authorizeOverviewWrite delegated legs — default to "no grant".
      scholarProxy: { findUnique: mockScholarProxyFindUnique },
      scholar: { findUnique: mockScholarFindUnique },
      divisionMembership: { findMany: mockDivisionMembershipFindMany },
      division: { findMany: mockDivisionFindMany },
      unitAdmin: { findMany: mockUnitAdminFindMany },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  resolveAffectedProfiles: mockResolveProfiles,
  reflectVisibilityChange: mockReflectVisibilityChange,
}));

import { GET, POST } from "@/app/api/edit/appointment/route";

const SELF = { cwid: "self01", isSuperuser: false, isCommsSteward: false };
const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };

const fakeTx = {
  profileAppointment: { create: mockTxPaCreate, update: mockTxPaUpdate, delete: mockTxPaDelete },
  $executeRaw: mockTxExecuteRaw,
};

/** A stored row owned by `cwid`. */
function row(cwid: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "pa-1",
    cwid,
    category: "WCM_LEADERSHIP",
    title: "Program Director",
    organization: "Weill Cornell Medicine",
    unit: null,
    location: null,
    startDate: null,
    endDate: null,
    sortOrder: 0,
    showOnProfile: true,
    source: "SELF",
    enteredByCwid: cwid,
    createdAt: new Date("2026-07-07T00:00:00.000Z"),
    updatedAt: new Date("2026-07-07T00:00:00.000Z"),
    ...overrides,
  };
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/appointment", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

function get(url = "http://localhost/api/edit/appointment"): NextRequest {
  return new NextRequest(url, { method: "GET", headers: { "sec-fetch-site": "same-origin" } });
}

const CREATE_BODY = {
  action: "create",
  cwid: "self01",
  category: "WCM_LEADERSHIP",
  title: "Program Director",
  organization: "Weill Cornell Medicine",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(SELF);
  mockPaFindUnique.mockResolvedValue(row("self01"));
  mockPaFindMany.mockResolvedValue([row("self01")]);
  mockScholarProxyFindUnique.mockResolvedValue(null);
  mockScholarFindUnique.mockResolvedValue(null);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
  mockUnitAdminFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxPaCreate.mockResolvedValue(row("self01"));
  mockTxPaUpdate.mockResolvedValue(row("self01", { title: "Head of Section" }));
  mockTxPaDelete.mockResolvedValue({});
  mockTxExecuteRaw.mockResolvedValue(1);
  mockResolveProfiles.mockResolvedValue([{ slug: "self01-slug", cwid: "self01" }]);
  mockReflectVisibilityChange.mockResolvedValue(undefined);
});

describe("POST /api/edit/appointment — create", () => {
  it("401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await POST(post(CREATE_BODY));
    expect(res.status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a scholar creates their OWN row — 200, one tx + audit row, source SELF", async () => {
    const res = await POST(post(CREATE_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.appointment.id).toBe("pa-1");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxPaCreate).toHaveBeenCalledTimes(1);
    // The create payload carries the owning cwid + SELF provenance + the human.
    const data = mockTxPaCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.cwid).toBe("self01");
    expect(data.source).toBe("SELF");
    expect(data.enteredByCwid).toBe("self01");
    // Exactly one B03 audit row: actor = the scholar, action = create.
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[1]).toBe("self01"); // actor_cwid
    expect(args[2]).toBe("profile_appointment"); // target_entity_type
    expect(args[3]).toBe("pa-1"); // target_entity_id
    expect(args[4]).toBe("profile_appointment_create"); // action
    expect(mockReflectVisibilityChange).toHaveBeenCalled();
  });

  it("a superuser creates on ANOTHER scholar — 200, source CURATOR", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ ...CREATE_BODY, cwid: "sch777" }));
    expect(res.status).toBe(200);
    const data = mockTxPaCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.source).toBe("CURATOR");
    expect(data.enteredByCwid).toBe("adm001"); // the accountable human
  });

  it("a scholar may NOT create on ANOTHER scholar — 403, writes nothing", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const res = await POST(post({ ...CREATE_BODY, cwid: "other9" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_self");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid category before any write — 400", async () => {
    const res = await POST(post({ ...CREATE_BODY, category: "BOGUS" }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("category");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects a malformed cwid — 400", async () => {
    const res = await POST(post({ ...CREATE_BODY, cwid: "!!" }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("cwid");
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/appointment — update / delete", () => {
  it("a scholar updates their OWN row — 200, update action", async () => {
    mockPaFindUnique.mockResolvedValue(row("self01"));
    const res = await POST(
      post({
        action: "update",
        id: "pa-1",
        category: "WCM_LEADERSHIP",
        title: "Head of Section",
        organization: "Weill Cornell Medicine",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxPaUpdate).toHaveBeenCalledTimes(1);
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[4]).toBe("profile_appointment_update");
  });

  it("a scholar may NOT update ANOTHER scholar's row — 403", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    mockPaFindUnique.mockResolvedValue(row("other9")); // owned by other9
    const res = await POST(
      post({
        action: "update",
        id: "pa-foreign",
        category: "EXTERNAL",
        title: "Assistant Professor",
        organization: "Other University",
      }),
    );
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404 when the row does not exist", async () => {
    mockPaFindUnique.mockResolvedValue(null);
    const res = await POST(post({ action: "delete", id: "ghost" }));
    expect(res.status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a scholar deletes their OWN row — 200, delete action, tx.delete called", async () => {
    mockPaFindUnique.mockResolvedValue(row("self01"));
    const res = await POST(post({ action: "delete", id: "pa-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(true);
    expect(mockTxPaDelete).toHaveBeenCalledWith({ where: { id: "pa-1" } });
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[4]).toBe("profile_appointment_delete");
    // delete → after_values is NULL (positional arg 7 in the audit INSERT).
    expect(args[7]).toBeNull();
    expect(mockReflectVisibilityChange).toHaveBeenCalled();
  });

  it("rejects an unknown action — 400", async () => {
    const res = await POST(post({ action: "frobnicate", id: "pa-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("action");
  });
});

describe("GET /api/edit/appointment — list", () => {
  it("401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET(get());
    expect(res.status).toBe(401);
  });

  it("lists the authed scholar's rows — 200", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.appointments).toHaveLength(1);
    expect(body.appointments[0].id).toBe("pa-1");
    expect(mockPaFindMany).toHaveBeenCalledWith({
      where: { cwid: "self01" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  });

  it("a scholar may NOT list ANOTHER scholar's rows — 403", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const res = await GET(get("http://localhost/api/edit/appointment?cwid=other9"));
    expect(res.status).toBe(403);
    expect(mockPaFindMany).not.toHaveBeenCalled();
  });
});
