/**
 * GET /api/auth/session resolves its role verdicts concurrently. Each is a live
 * LDAPS round trip (~230 ms); awaited one by one they made this route half the
 * prod ALB p99 tail (2026-10-13). With every lookup held pending, all of them
 * must already have STARTED -- sequential code would start only the first.
 */
import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const gates: Array<() => void> = [];
  const pending = <T>(v: T) => vi.fn(() => new Promise<T>((r) => gates.push(() => r(v))));
  return {
    gates,
    isSuperuser: pending(false),
    isDeveloper: pending(true),
    isContentEditor: pending(false),
    isObserver: pending(true),
    isCommsSteward: pending(false),
    loadManageableUnits: pending({ total: 0 }),
  };
});
vi.mock("@/lib/auth/session-server", () => ({
  getSession: async () => ({ cwid: "abc1234", iat: 0, exp: 0 }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: async () => ({ slug: "a-b", preferredName: "A B" }) },
      stewardDirectory: { findUnique: async () => null },
    },
  },
}));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: h.isSuperuser }));
vi.mock("@/lib/auth/development", () => ({ isDeveloper: h.isDeveloper }));
vi.mock("@/lib/auth/content-editor", () => ({ isContentEditor: h.isContentEditor }));
vi.mock("@/lib/auth/observer", () => ({ isObserver: h.isObserver }));
vi.mock("@/lib/auth/comms-steward", () => ({ isCommsSteward: h.isCommsSteward }));
vi.mock("@/lib/edit/manageable-units", () => ({ loadManageableUnits: h.loadManageableUnits }));

import { GET } from "@/app/api/auth/session/route";

it("starts every role lookup before any of them resolves", async () => {
  process.env.IMPERSONATION_ENABLED = "true";
  const res = GET();
  await vi.waitFor(() => expect(h.gates).toHaveLength(6));
  h.gates.forEach((open) => open());
  const body = await (await res).json();
  expect(body.isSuperuser).toBe(false);
  expect(body.canAccessFundingMatcher).toBe(true); // developer
  expect(body.canImpersonate).toBe(true); // observer
  expect(h.isObserver).toHaveBeenCalledTimes(1);
});
