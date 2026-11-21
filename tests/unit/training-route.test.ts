/** Route tests for `/api/edit/training`: add / remove scholar-entered postgraduate training. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTrFindUnique,
  mockScholarProxyFindUnique,
  mockScholarFindUnique,
  mockDivisionMembershipFindMany,
  mockDivisionFindMany,
  mockUnitAdminFindMany,
  mockTransaction,
  mockTxTrCreate,
  mockTxTrDelete,
  mockTxExecuteRaw,
  mockResolveProfiles,
  mockReflectVisibilityChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTrFindUnique: vi.fn(),
  mockScholarProxyFindUnique: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxTrCreate: vi.fn(),
  mockTxTrDelete: vi.fn(),
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
      training: { findUnique: mockTrFindUnique },
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

import { POST } from "@/app/api/edit/training/route";

const SELF = { cwid: "self01", isSuperuser: false, isCommsSteward: false };
const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };

const fakeTx = {
  training: { create: mockTxTrCreate, delete: mockTxTrDelete },
  $executeRaw: mockTxExecuteRaw,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "SPS-TRAIN-1",
    cwid: "self01",
    type: "Fellowship",
    institution: "Massachusetts General Hospital",
    specialty: "Infectious Diseases",
    yearFrom: 2021,
    yearTo: 2024,
    source: "SELF",
    ...overrides,
  };
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/training", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const CREATE = {
  action: "create",
  cwid: "self01",
  type: "Fellowship",
  institution: "Massachusetts General Hospital",
  specialty: "Infectious Diseases",
  yearFrom: 2021,
  yearTo: 2024,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(SELF);
  mockTrFindUnique.mockResolvedValue(row());
  mockScholarProxyFindUnique.mockResolvedValue(null);
  mockScholarFindUnique.mockResolvedValue(null);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
  mockUnitAdminFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxTrCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
  mockTxTrDelete.mockResolvedValue({});
  mockTxExecuteRaw.mockResolvedValue(1);
  mockResolveProfiles.mockResolvedValue([{ slug: "self01-slug", cwid: "self01" }]);
  mockReflectVisibilityChange.mockResolvedValue(undefined);
});

describe("POST /api/edit/training", () => {
  it("401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    expect((await POST(post(CREATE))).status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a scholar adds their OWN row: SELF, SPS-TRAIN id, one audit row, profile reflected", async () => {
    const res = await POST(post(CREATE));
    expect(res.status).toBe(200);
    const data = mockTxTrCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      cwid: "self01",
      source: "SELF",
      enteredByCwid: "self01",
      type: "Fellowship",
      yearFrom: 2021,
      yearTo: 2024,
    });
    expect(String(data.externalId)).toMatch(/^SPS-TRAIN-/);
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[1]).toBe("self01"); // actor_cwid
    expect(args[2]).toBe("training"); // target_entity_type
    expect(args[3]).toBe(data.externalId); // target_entity_id
    expect(args[4]).toBe("training_create"); // action
    expect(mockReflectVisibilityChange).toHaveBeenCalledWith(["self01-slug"]);
  });

  it("a superuser adds for another scholar: CURATOR, entered by the admin", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    expect((await POST(post({ ...CREATE, cwid: "sch777" }))).status).toBe(200);
    const data = mockTxTrCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.source).toBe("CURATOR");
    expect(data.enteredByCwid).toBe("adm001");
  });

  it("a scholar may NOT add to another scholar's profile: 403, nothing written", async () => {
    const res = await POST(post({ ...CREATE, cwid: "other9" }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown type before any write: 400", async () => {
    const res = await POST(post({ ...CREATE, type: "Other" }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("type");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("removes a scholar-entered row with a delete audit row", async () => {
    const res = await POST(post({ action: "delete", externalId: "SPS-TRAIN-1" }));
    expect(res.status).toBe(200);
    expect(mockTxTrDelete).toHaveBeenCalledWith({ where: { externalId: "SPS-TRAIN-1" } });
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[4]).toBe("training_delete");
  });

  it("refuses to remove an ASMS row (it is hidden instead): 409", async () => {
    mockTrFindUnique.mockResolvedValue(row({ externalId: "ASMS-TRAIN-9", source: "ASMS" }));
    const res = await POST(post({ action: "delete", externalId: "ASMS-TRAIN-9" }));
    expect(res.status).toBe(409);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a scholar may NOT remove another scholar's row: 403", async () => {
    mockTrFindUnique.mockResolvedValue(row({ cwid: "other9" }));
    const res = await POST(post({ action: "delete", externalId: "SPS-TRAIN-1" }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404 when the row does not exist", async () => {
    mockTrFindUnique.mockResolvedValue(null);
    expect((await POST(post({ action: "delete", externalId: "nope" }))).status).toBe(404);
  });
});
