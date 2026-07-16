/**
 * Route tests for `/api/edit/honor` (#1760) — the CRUD surface for a scholar's
 * honors & distinctions (`honor`).
 *
 * These pin the SECURITY boundary (`authorizeOverviewWrite`, keyed on the owning
 * scholar) and the write wiring (one transaction + one B03 audit row per
 * mutation, its own `honor_*` action). The mock harness mirrors
 * `profile-appointment-route.test.ts`, the sibling route that shares the same
 * authz predicate.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockHonorFindUnique,
  mockHonorFindMany,
  mockScholarProxyFindUnique,
  mockScholarFindUnique,
  mockDivisionMembershipFindMany,
  mockDivisionFindMany,
  mockUnitAdminFindMany,
  mockTransaction,
  mockTxHonorCreate,
  mockTxHonorUpdate,
  mockTxHonorDelete,
  mockTxExecuteRaw,
  mockResolveProfiles,
  mockReflectVisibilityChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockHonorFindUnique: vi.fn(),
  mockHonorFindMany: vi.fn(),
  mockScholarProxyFindUnique: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxHonorCreate: vi.fn(),
  mockTxHonorUpdate: vi.fn(),
  mockTxHonorDelete: vi.fn(),
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
      honor: { findUnique: mockHonorFindUnique, findMany: mockHonorFindMany },
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

import { GET, POST } from "@/app/api/edit/honor/route";

const SELF = { cwid: "abc1001", isSuperuser: false, isCommsSteward: false };
const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };

const fakeTx = {
  honor: { create: mockTxHonorCreate, update: mockTxHonorUpdate, delete: mockTxHonorDelete },
  $executeRaw: mockTxExecuteRaw,
};

/** A stored row owned by `cwid`. */
function row(cwid: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "hon-1",
    cwid,
    category: "ACADEMY_MEMBERSHIP",
    name: "Member",
    organization: "National Academy of Sciences",
    year: 2019,
    status: "published",
    showOnProfile: true,
    source: "SELF",
    sourceRef: null,
    enteredByCwid: cwid,
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
    updatedAt: new Date("2026-07-16T00:00:00.000Z"),
    ...overrides,
  };
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/honor", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

function get(url = "http://localhost/api/edit/honor"): NextRequest {
  return new NextRequest(url, { method: "GET", headers: { "sec-fetch-site": "same-origin" } });
}

const CREATE_BODY = {
  action: "create",
  cwid: "abc1001",
  category: "ACADEMY_MEMBERSHIP",
  name: "Member",
  organization: "National Academy of Sciences",
  year: 2019,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(SELF);
  mockHonorFindUnique.mockResolvedValue(row("abc1001"));
  mockHonorFindMany.mockResolvedValue([row("abc1001")]);
  mockScholarProxyFindUnique.mockResolvedValue(null);
  mockScholarFindUnique.mockResolvedValue(null);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
  mockUnitAdminFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxHonorCreate.mockResolvedValue(row("abc1001"));
  mockTxHonorUpdate.mockResolvedValue(row("abc1001", { name: "Foreign Associate" }));
  mockTxHonorDelete.mockResolvedValue({});
  mockTxExecuteRaw.mockResolvedValue(1);
  mockResolveProfiles.mockResolvedValue([{ slug: "ada-lovelace", cwid: "abc1001" }]);
  mockReflectVisibilityChange.mockResolvedValue(undefined);
});

describe("POST /api/edit/honor — create", () => {
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
    expect(body.honor.id).toBe("hon-1");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxHonorCreate).toHaveBeenCalledTimes(1);
    // The create payload carries the owning cwid + SELF provenance + the human.
    const data = mockTxHonorCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.cwid).toBe("abc1001");
    expect(data.source).toBe("SELF");
    expect(data.enteredByCwid).toBe("abc1001");
    expect(data.year).toBe(2019);
    // Exactly one B03 audit row: actor = the scholar, action = create.
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[1]).toBe("abc1001"); // actor_cwid
    expect(args[2]).toBe("honor"); // target_entity_type
    expect(args[3]).toBe("hon-1"); // target_entity_id
    expect(args[4]).toBe("honor_create"); // action
    expect(mockReflectVisibilityChange).toHaveBeenCalled();
  });

  it("pins status=published — Phase 1 exposes no approval affordance", async () => {
    // Even when a caller tries to smuggle `pending` in, the route pins published.
    const res = await POST(post({ ...CREATE_BODY, status: "pending" }));
    expect(res.status).toBe(200);
    const data = mockTxHonorCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("published");
  });

  it("a year is optional — omitting it stores null, not undefined", async () => {
    mockTxHonorCreate.mockResolvedValue(row("abc1001", { year: null }));
    const res = await POST(post({ ...CREATE_BODY, year: undefined }));
    expect(res.status).toBe(200);
    const data = mockTxHonorCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.year).toBeNull();
    expect((await res.json()).honor.year).toBeNull();
  });

  it("a superuser creates on ANOTHER scholar — 200, source CURATOR", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ ...CREATE_BODY, cwid: "xyz9001" }));
    expect(res.status).toBe(200);
    const data = mockTxHonorCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.source).toBe("CURATOR");
    expect(data.enteredByCwid).toBe("adm001"); // the accountable human
  });

  it("a scholar may NOT create on ANOTHER scholar — 403, writes nothing", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const res = await POST(post({ ...CREATE_BODY, cwid: "xyz9001" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_self");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid category before any write — 400", async () => {
    const res = await POST(post({ ...CREATE_BODY, category: "HONORARY_DEGREE" }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("category");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range year before any write — 400", async () => {
    const res = await POST(post({ ...CREATE_BODY, year: 1492 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("year");
    expect(body.error).toBe("invalid_year");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an over-length name before any write — 400", async () => {
    const res = await POST(post({ ...CREATE_BODY, name: "x".repeat(256) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("name");
    expect(body.error).toBe("too_long");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects a malformed cwid — 400", async () => {
    const res = await POST(post({ ...CREATE_BODY, cwid: "!!" }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("cwid");
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/honor — update / delete", () => {
  it("a scholar updates their OWN row — 200, update action", async () => {
    mockHonorFindUnique.mockResolvedValue(row("abc1001"));
    const res = await POST(
      post({
        action: "update",
        id: "hon-1",
        category: "ACADEMY_MEMBERSHIP",
        name: "Foreign Associate",
        organization: "National Academy of Sciences",
        year: 2019,
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxHonorUpdate).toHaveBeenCalledTimes(1);
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[4]).toBe("honor_update");
  });

  it("update never moves status / source / enteredByCwid", async () => {
    mockHonorFindUnique.mockResolvedValue(row("abc1001"));
    await POST(
      post({
        action: "update",
        id: "hon-1",
        category: "PRIZE",
        name: "Lasker Award",
        organization: "Albert and Mary Lasker Foundation",
        status: "rejected",
        source: "FEED",
        enteredByCwid: "xyz9001",
      }),
    );
    const data = mockTxHonorUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("source");
    expect(data).not.toHaveProperty("enteredByCwid");
  });

  // `sourceRef` is the key Phase 3 de-dups a feed row on. The card carries the
  // field but never echoes it back, so an absent `sourceRef` normalises to null —
  // if `buildData` ever returns it again, a curator retitling a feed-surfaced
  // honor silently wipes the roster URL and the next annual sweep re-emits that
  // honor as a brand-new `pending` row. This test is the tripwire for that.
  it("update never wipes sourceRef, even though the card omits the field", async () => {
    mockHonorFindUnique.mockResolvedValue(row("abc1001"));
    await POST(
      post({
        action: "update",
        id: "hon-1",
        category: "ACADEMY_MEMBERSHIP",
        name: "Member",
        organization: "National Academy of Sciences",
        // no sourceRef — exactly what components/edit/honors-card.tsx sends
      }),
    );
    const data = mockTxHonorUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("sourceRef");
  });

  it("a scholar may NOT update ANOTHER scholar's row — 403", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    mockHonorFindUnique.mockResolvedValue(row("xyz9001")); // owned by xyz9001
    const res = await POST(
      post({
        action: "update",
        id: "hon-foreign",
        category: "PRIZE",
        name: "Lasker Award",
        organization: "Albert and Mary Lasker Foundation",
      }),
    );
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404 when the row does not exist", async () => {
    mockHonorFindUnique.mockResolvedValue(null);
    const res = await POST(post({ action: "delete", id: "ghost" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("honor_not_found");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a scholar deletes their OWN row — 200, delete action, tx.delete called", async () => {
    mockHonorFindUnique.mockResolvedValue(row("abc1001"));
    const res = await POST(post({ action: "delete", id: "hon-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(true);
    expect(mockTxHonorDelete).toHaveBeenCalledWith({ where: { id: "hon-1" } });
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[4]).toBe("honor_delete");
    // delete → after_values is NULL (positional arg 7 in the audit INSERT).
    expect(args[7]).toBeNull();
    expect(mockReflectVisibilityChange).toHaveBeenCalled();
  });

  it("rejects an unknown action — 400", async () => {
    const res = await POST(post({ action: "approve", id: "hon-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("action");
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("GET /api/edit/honor — list", () => {
  it("401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET(get());
    expect(res.status).toBe(401);
  });

  it("lists the authed scholar's rows in category → year order — 200", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.honors).toHaveLength(1);
    expect(body.honors[0].id).toBe("hon-1");
    expect(mockHonorFindMany).toHaveBeenCalledWith({
      where: { cwid: "abc1001" },
      orderBy: [{ category: "asc" }, { year: "desc" }, { createdAt: "asc" }],
    });
  });

  it("returns HIDDEN and NON-PUBLISHED rows — the curator view is unfiltered", async () => {
    mockHonorFindMany.mockResolvedValue([
      row("abc1001", { id: "hon-hidden", showOnProfile: false }),
      row("abc1001", { id: "hon-pending", status: "pending" }),
      row("abc1001", { id: "hon-rejected", status: "rejected" }),
    ]);
    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.honors.map((h: { id: string }) => h.id)).toEqual([
      "hon-hidden",
      "hon-pending",
      "hon-rejected",
    ]);
    // The where-clause filters on cwid ONLY — no status / showOnProfile predicate.
    expect(mockHonorFindMany.mock.calls[0][0].where).toEqual({ cwid: "abc1001" });
  });

  it("a scholar may NOT list ANOTHER scholar's rows — 403", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const res = await GET(get("http://localhost/api/edit/honor?cwid=xyz9001"));
    expect(res.status).toBe(403);
    expect(mockHonorFindMany).not.toHaveBeenCalled();
  });

  it("a superuser may list ANOTHER scholar's rows — 200", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await GET(get("http://localhost/api/edit/honor?cwid=xyz9001"));
    expect(res.status).toBe(200);
    expect(mockHonorFindMany).toHaveBeenCalledWith({
      where: { cwid: "xyz9001" },
      orderBy: [{ category: "asc" }, { year: "desc" }, { createdAt: "asc" }],
    });
  });
});
