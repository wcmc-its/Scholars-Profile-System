/**
 * `/edit/center/[code]` for a Cornell Ithaca partner session (Ithaca login
 * step 4): a center curator grant on the eppn gets that center's Members
 * roster alone; anything else reads as no such page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockWcm: vi.fn(),
  mockPartner: vi.fn(),
  mockCtx: vi.fn(),
  mockRenderRoster: vi.fn(() => "ROSTER"),
  mockUnitEditPage: vi.fn(() => null),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ notFound: h.mockNotFound, redirect: h.mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.mockWcm }));
vi.mock("@/lib/auth/partner-login", () => ({
  getPartnerEditSession: h.mockPartner,
  PARTNER_HOME: "/edit/cornell",
}));
vi.mock("@/lib/api/unit-edit-context", () => ({ loadUnitEditContext: h.mockCtx }));
vi.mock("@/components/edit/unit-edit-page", () => ({
  UnitEditPage: h.mockUnitEditPage,
  renderRoster: h.mockRenderRoster,
}));
vi.mock("@/components/edit/console-top-bar", () => ({ ConsoleTopBar: () => null }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: () => null }));
vi.mock("@/lib/db", () => ({ db: { read: { center: { findUnique: vi.fn() } } } }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/edit/console-tabs.server", () => ({ loadConsoleTabs: vi.fn() }));
vi.mock("@/lib/auth/observer-view", () => ({ stripObserverView: (s: unknown) => s }));

import EditCenterPage from "@/app/edit/center/[code]/page";

const PARTNER = { cwid: "zq99@cornell.edu", isSuperuser: false, isCommsSteward: false };
const page = () => EditCenterPage({ params: Promise.resolve({ code: "MEYER" }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.mockWcm.mockResolvedValue(null);
  h.mockPartner.mockResolvedValue(PARTNER);
});

describe("/edit/center/[code] — Cornell Ithaca partner", () => {
  it("a curator grant renders the roster alone, never the full editor", async () => {
    const ctx = { unit: { name: "Meyer Cancer Center" } };
    h.mockCtx.mockResolvedValue(ctx);
    const tree = (await page()) as React.ReactElement;
    expect(h.mockCtx).toHaveBeenCalledWith("center", "MEYER", PARTNER, expect.anything());
    expect(h.mockRenderRoster).toHaveBeenCalledWith(ctx);
    expect(h.mockUnitEditPage).not.toHaveBeenCalled();
    expect(tree.type).toBe("main");
  });

  it("no grant on this center: 404, no forbidden page or denial", async () => {
    h.mockCtx.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("__NOT_FOUND__");
    expect(h.mockRenderRoster).not.toHaveBeenCalled();
  });

  it("signed out entirely: SSO, as before", async () => {
    h.mockPartner.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("__REDIRECT__:/api/auth/saml/login?return=/edit/center/MEYER");
  });
});
