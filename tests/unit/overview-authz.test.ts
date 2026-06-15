/**
 * authorizeOverviewWrite (#844 follow-up) — the shared overview-write predicate
 * behind both `/api/edit/field` (scholar overview) and
 * `/api/edit/overview/generate`. The real (pure) `authorizeFieldEdit` runs; the
 * proxy and unit-admin legs are mocked so each branch is driven directly.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ProxyLookup } from "@/lib/edit/proxy-authz";
import type { UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

const { mockIsGrantedProxy, mockCheckConflict, mockResolveUnit } = vi.hoisted(() => ({
  mockIsGrantedProxy: vi.fn(),
  mockCheckConflict: vi.fn(),
  mockResolveUnit: vi.fn(),
}));

vi.mock("@/lib/edit/proxy-authz", () => ({
  isGrantedProxy: mockIsGrantedProxy,
  checkProxyConflictingRole: mockCheckConflict,
}));
vi.mock("@/lib/edit/unit-scholar-authz", () => ({
  resolveEditableUnitViaUnitAdmin: mockResolveUnit,
}));

import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";

const SELF = "self01";
const OTHER = "other9";
const PROXY_DB = {} as unknown as ProxyLookup; // the mocked legs ignore the db arg
const UNIT_DB = {} as unknown as UnitScholarLookup;

function call(over: Partial<Parameters<typeof authorizeOverviewWrite>[0]> = {}) {
  return authorizeOverviewWrite({
    session: { cwid: SELF, isSuperuser: false, isCommsSteward: false },
    realCwid: SELF,
    impersonatedCwid: null,
    entityId: SELF,
    proxyDb: PROXY_DB,
    unitDb: UNIT_DB,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsGrantedProxy.mockResolvedValue(false);
  mockCheckConflict.mockResolvedValue({ ok: true });
  mockResolveUnit.mockResolvedValue(null);
});

describe("authorizeOverviewWrite", () => {
  it("allows self — no proxy / unit lookup", async () => {
    expect(await call({ entityId: SELF })).toEqual({ ok: true, viaUnitAdminUnit: null });
    expect(mockIsGrantedProxy).not.toHaveBeenCalled();
    expect(mockResolveUnit).not.toHaveBeenCalled();
  });

  it("allows a superuser editing another scholar — no proxy / unit lookup", async () => {
    const r = await call({
      session: { cwid: "adm001", isSuperuser: true, isCommsSteward: false },
      realCwid: "adm001",
      entityId: OTHER,
    });
    expect(r).toEqual({ ok: true, viaUnitAdminUnit: null });
    expect(mockIsGrantedProxy).not.toHaveBeenCalled();
  });

  it("denies not_self when impersonating — the delegated legs are skipped (IS-1)", async () => {
    const r = await call({
      session: { cwid: "ovl", isSuperuser: false, isCommsSteward: false },
      realCwid: "real1",
      entityId: OTHER,
      impersonatedCwid: "ovl",
    });
    expect(r).toEqual({ ok: false, reason: "not_self" });
    expect(mockIsGrantedProxy).not.toHaveBeenCalled();
    expect(mockResolveUnit).not.toHaveBeenCalled();
  });

  it("allows a granted proxy whose conflict re-check passes — short-circuits unit leg", async () => {
    mockIsGrantedProxy.mockResolvedValue(true);
    const r = await call({
      session: { cwid: "px", isSuperuser: false, isCommsSteward: false },
      realCwid: "px",
      entityId: OTHER,
    });
    expect(r).toEqual({ ok: true, viaUnitAdminUnit: null });
    expect(mockCheckConflict).toHaveBeenCalledWith("px", PROXY_DB);
    expect(mockResolveUnit).not.toHaveBeenCalled();
  });

  it("denies proxy_conflict for a granted proxy that fails the re-check — no unit fallthrough", async () => {
    mockIsGrantedProxy.mockResolvedValue(true);
    mockCheckConflict.mockResolvedValue({ ok: false, reason: "proxy_is_superuser" });
    const r = await call({
      session: { cwid: "px", isSuperuser: false, isCommsSteward: false },
      realCwid: "px",
      entityId: OTHER,
    });
    expect(r).toEqual({ ok: false, reason: "proxy_conflict" });
    expect(mockResolveUnit).not.toHaveBeenCalled();
  });

  it("falls through to the unit-admin leg and returns the resolved unit on allow", async () => {
    mockResolveUnit.mockResolvedValue({ kind: "department", code: "MED" });
    const r = await call({
      session: { cwid: "ua", isSuperuser: false, isCommsSteward: false },
      realCwid: "ua",
      entityId: OTHER,
    });
    expect(r).toEqual({ ok: true, viaUnitAdminUnit: { kind: "department", code: "MED" } });
    expect(mockResolveUnit).toHaveBeenCalledWith("ua", OTHER, UNIT_DB);
  });

  it("denies not_self when the actor is neither proxy nor unit-admin", async () => {
    const r = await call({
      session: { cwid: "nobody", isSuperuser: false, isCommsSteward: false },
      realCwid: "nobody",
      entityId: OTHER,
    });
    expect(r).toEqual({ ok: false, reason: "not_self" });
    expect(mockResolveUnit).toHaveBeenCalledWith("nobody", OTHER, UNIT_DB);
  });
});
