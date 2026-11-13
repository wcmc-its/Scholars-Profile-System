/**
 * POST /api/impersonation — the target gate (step 5). A profile-less proxy
 * editor (only a `scholar_proxy` row) must be assumable; the Profile editors tab
 * offers View as on them. The R2 guard is stubbed to reject so the test stops
 * right after the gate: 403 = gate passed, 404 = gate refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { proxyFindFirst } = vi.hoisted(() => ({ proxyFindFirst: vi.fn() }));

vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => ({ cwid: "su001", iat: 0, exp: 0 })),
}));
vi.mock("@/lib/auth/effective-identity", () => ({
  canImpersonate: vi.fn(async () => true),
  assertImpersonable: vi.fn(async () => ({ ok: false, reason: "guard_reached" })),
}));
vi.mock("@/lib/auth/comms-steward", () => ({ isCommsSteward: vi.fn(async () => false) }));
vi.mock("@/lib/auth/global-roles", () => ({ resolveGlobalRole: vi.fn(async () => null) }));
vi.mock("@/lib/edit/authz", () => ({ verifyRequestOrigin: () => ({ ok: true }) }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findFirst: vi.fn(async () => null) },
      unitAdmin: { findFirst: vi.fn(async () => null) },
      scholarProxy: { findFirst: proxyFindFirst },
    },
  },
}));

import { POST } from "@/app/api/impersonation/route";

const post = () =>
  POST(
    new NextRequest("http://localhost/api/impersonation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCwid: "prx001" }),
    }),
  );

beforeEach(() => {
  vi.stubEnv("IMPERSONATION_ENABLED", "true");
  proxyFindFirst.mockReset();
});

describe("impersonation POST — target gate", () => {
  it("accepts a proxy editor with no other role", async () => {
    proxyFindFirst.mockResolvedValueOnce({ proxyCwid: "prx001" });
    const res = await post();
    expect(res.status).toBe(403);
    expect(proxyFindFirst.mock.calls[0][0].where).toEqual({ proxyCwid: "prx001" });
  });

  it("404s someone with no scholar row, unit grant, role, or proxy grant", async () => {
    proxyFindFirst.mockResolvedValueOnce(null);
    const res = await post();
    expect(res.status).toBe(404);
  });
});
