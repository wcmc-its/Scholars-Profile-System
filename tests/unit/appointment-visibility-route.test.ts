/**
 * POST /api/edit/appointment-visibility — self-serve reveal (#1323 + #1557).
 *
 * The reveal/hide of a historical (`source = "ED-HISTORICAL"`) appointment now
 * rides the SAME `authorizeOverviewWrite` predicate as the bio + section-
 * visibility (#1554), keyed on the OWNING scholar (`appointment.cwid`). These
 * route-level tests pin the SECURITY boundary that keying enforces:
 *
 *   - a scholar MAY toggle their OWN historical appointment (self-serve, 200);
 *   - a scholar may NOT toggle ANOTHER scholar's appointment (403, no write);
 *   - a comms_steward / superuser / unit-admin curator retain the reveal power
 *     they had before the widening (200), unit-admin attributed in the audit.
 *
 * The mock harness mirrors `edit-field-route.test.ts` (the overview / section-
 * visibility surface that shares `authorizeOverviewWrite`).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockAppointmentFindUnique,
  mockScholarProxyFindUnique,
  mockScholarFindUnique,
  mockDivisionMembershipFindMany,
  mockDivisionFindMany,
  mockUnitAdminFindMany,
  mockTransaction,
  mockTxAppointmentUpdate,
  mockTxExecuteRaw,
  mockResolveProfiles,
  mockReflectVisibilityChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockAppointmentFindUnique: vi.fn(),
  mockScholarProxyFindUnique: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxAppointmentUpdate: vi.fn(),
  mockTxExecuteRaw: vi.fn(),
  mockResolveProfiles: vi.fn(),
  mockReflectVisibilityChange: vi.fn(),
}));

// Identity resolves through the #637 effective-identity seam (non-impersonating:
// real == effective, so realCwid is this cwid and impersonatedCwid stays null).
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
      appointment: { findUnique: mockAppointmentFindUnique },
      // authorizeOverviewWrite legs — proxy (#779) then unit-admin (#728). These
      // default to "no delegated grant" so a non-self actor denies unless a test
      // supplies a role.
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

import { POST } from "@/app/api/edit/appointment-visibility/route";

const SELF = { cwid: "self01", isSuperuser: false, isCommsSteward: false };
const OTHER_SELF = { cwid: "other9", isSuperuser: false, isCommsSteward: false };
const STEWARD = { cwid: "stew01", isSuperuser: false, isCommsSteward: true };
const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };
const UNIT_ADMIN = { cwid: "uadm01", isSuperuser: false, isCommsSteward: false };

const fakeTx = {
  appointment: { update: mockTxAppointmentUpdate },
  $executeRaw: mockTxExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/appointment-visibility", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

/** A historical appointment owned by `cwid`. */
function historical(cwid: string) {
  return { cwid, source: "ED-HISTORICAL", title: "Assistant Professor" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(SELF);
  // Default appointment: a historical row owned by self01.
  mockAppointmentFindUnique.mockResolvedValue(historical("self01"));
  // Delegated legs default to "no grant" (deny) — a self-owner short-circuits
  // before they run, but a non-owner falls through to these.
  mockScholarProxyFindUnique.mockResolvedValue(null);
  mockScholarFindUnique.mockResolvedValue(null);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
  mockUnitAdminFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxAppointmentUpdate.mockResolvedValue({});
  mockTxExecuteRaw.mockResolvedValue(1);
  mockResolveProfiles.mockResolvedValue([{ slug: "self01-slug", cwid: "self01" }]);
  mockReflectVisibilityChange.mockResolvedValue(undefined);
});

describe("POST /api/edit/appointment-visibility — self-serve boundary (#1557)", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await POST(post({ appointmentExternalId: "appt1", showOnProfile: true }));
    expect(res.status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a scholar MAY reveal their OWN historical appointment — 200, one tx + audit row", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    mockAppointmentFindUnique.mockResolvedValue(historical("self01"));
    const res = await POST(post({ appointmentExternalId: "appt1", showOnProfile: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.showOnProfile).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxAppointmentUpdate).toHaveBeenCalledWith({
      where: { externalId: "appt1" },
      data: { showOnProfile: true },
    });
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1); // the B03 audit row
    // The audit attributes the acting scholar (actor_cwid is positional arg 1),
    // and is NOT tagged as a unit-admin edit (self path).
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[1]).toBe("self01"); // actor_cwid — the scholar themselves
    const editedVia = args.find(
      (v): v is string => typeof v === "string" && v.includes("edited_via"),
    );
    expect(editedVia).toBeUndefined();
    expect(mockReflectVisibilityChange).toHaveBeenCalled();
  });

  it("a scholar MAY re-hide their OWN historical appointment (showOnProfile=false) — 200", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    mockAppointmentFindUnique.mockResolvedValue(historical("self01"));
    const res = await POST(post({ appointmentExternalId: "appt1", showOnProfile: false }));
    expect(res.status).toBe(200);
    expect(mockTxAppointmentUpdate).toHaveBeenCalledWith({
      where: { externalId: "appt1" },
      data: { showOnProfile: false },
    });
  });

  it("a scholar may NOT toggle ANOTHER scholar's historical appointment — 403, writes nothing", async () => {
    mockGetEditSession.mockResolvedValue(SELF); // self01
    mockAppointmentFindUnique.mockResolvedValue(historical("other9")); // owned by other9
    // No proxy grant and no unit-admin role over other9 (defaults) → deny.
    const res = await POST(post({ appointmentExternalId: "appt-foreign", showOnProfile: true }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("not_self");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("the OWNER scholar of a foreign appointment can still reveal it (proves keying is on the row's owner)", async () => {
    // The very appointment self01 was refused above is toggleable by its owner.
    mockGetEditSession.mockResolvedValue(OTHER_SELF); // other9
    mockAppointmentFindUnique.mockResolvedValue(historical("other9"));
    const res = await POST(post({ appointmentExternalId: "appt-foreign", showOnProfile: true }));
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("a comms_steward retains the reveal power on any scholar's appointment — 200", async () => {
    mockGetEditSession.mockResolvedValue(STEWARD);
    mockAppointmentFindUnique.mockResolvedValue(historical("sch777"));
    const res = await POST(post({ appointmentExternalId: "appt2", showOnProfile: true }));
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("a superuser retains the reveal power on any scholar's appointment — 200", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockAppointmentFindUnique.mockResolvedValue(historical("sch777"));
    const res = await POST(post({ appointmentExternalId: "appt3", showOnProfile: true }));
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("a unit-admin curator of the scholar's unit retains the reveal power — 200 + unit in the audit", async () => {
    mockGetEditSession.mockResolvedValue(UNIT_ADMIN);
    mockAppointmentFindUnique.mockResolvedValue(historical("sch001"));
    // The scholar belongs to DEPT-MED; the actor holds a curator row over it.
    mockScholarFindUnique.mockResolvedValue({ deptCode: "DEPT-MED", divCode: null, deletedAt: null });
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "department", entityId: "DEPT-MED", role: "curator" },
    ]);
    const res = await POST(post({ appointmentExternalId: "appt4", showOnProfile: true }));
    expect(res.status).toBe(200);
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    const afterJson = args.find(
      (v): v is string => typeof v === "string" && v.includes("edited_via"),
    );
    expect(afterJson).toContain("unit_admin");
    expect(afterJson).toContain("DEPT-MED");
  });

  it("a non-owner with NO delegated role is denied even for a well-formed request — 403", async () => {
    mockGetEditSession.mockResolvedValue(UNIT_ADMIN);
    mockAppointmentFindUnique.mockResolvedValue(historical("sch001"));
    mockScholarFindUnique.mockResolvedValue({ deptCode: "DEPT-MED", divCode: null, deletedAt: null });
    mockUnitAdminFindMany.mockResolvedValue([]); // holds no role over the scholar's unit
    const res = await POST(post({ appointmentExternalId: "appt4", showOnProfile: true }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("refuses to toggle a NON-historical (active) appointment before any authz — 409", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    mockAppointmentFindUnique.mockResolvedValue({
      cwid: "self01",
      source: "ED",
      title: "Professor",
    });
    const res = await POST(post({ appointmentExternalId: "active1", showOnProfile: true }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("not_historical");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404s when the appointment does not exist", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    mockAppointmentFindUnique.mockResolvedValue(null);
    const res = await POST(post({ appointmentExternalId: "ghost", showOnProfile: true }));
    expect(res.status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
