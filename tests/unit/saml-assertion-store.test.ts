/**
 * SAML assertion single-use ledger (#1439) — the shared, instance-independent
 * guard. A validated SAMLResponse must mint a session only on its first
 * presentation; a second presentation of the same assertion is rejected. The
 * guard is a primary-key INSERT: a duplicate (P2002) means already-consumed.
 *
 * These tests mock `@/lib/db` (the Prisma boundary) the way the rest of the
 * suite does, so the guard logic is exercised without a database.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockCreate, mockDeleteMany } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    write: {
      samlAssertionSeen: { create: mockCreate, deleteMany: mockDeleteMany },
    },
  },
}));

import { markAssertionConsumed } from "@/lib/auth/saml-assertion-store";

/** Prisma unique-constraint violation, simulated the way the suite does elsewhere. */
function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

const IDENTITY = {
  id: "assn:_abc123",
  expiresAt: new Date("2026-07-03T12:05:00.000Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
  mockDeleteMany.mockResolvedValue({ count: 0 });
});

describe("markAssertionConsumed", () => {
  it("records a first-use assertion and reports it is not a duplicate", async () => {
    mockCreate.mockResolvedValue({});
    const res = await markAssertionConsumed(IDENTITY);
    expect(res).toEqual({ duplicate: false });
    expect(mockCreate).toHaveBeenCalledWith({
      data: { id: IDENTITY.id, expiresAt: IDENTITY.expiresAt },
    });
  });

  it("reports a duplicate when the same id violates the primary key (P2002)", async () => {
    // The load-bearing assertion: a second insert of the same id is treated as
    // already-consumed, never as a fresh login. If the P2002 branch is removed
    // this throws/regresses.
    mockCreate.mockRejectedValue(uniqueViolation());
    const res = await markAssertionConsumed(IDENTITY);
    expect(res).toEqual({ duplicate: true });
  });

  it("does NOT prune when the insert hit the uniqueness guard (row must survive its window)", async () => {
    mockCreate.mockRejectedValue(uniqueViolation());
    await markAssertionConsumed(IDENTITY);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("re-throws a non-P2002 write error so the caller fails closed", async () => {
    mockCreate.mockRejectedValue(new Error("connection reset"));
    await expect(markAssertionConsumed(IDENTITY)).rejects.toThrow("connection reset");
  });

  it("opportunistically prunes rows past their validity horizon", async () => {
    mockCreate.mockResolvedValue({});
    const now = new Date("2026-07-03T13:00:00.000Z");
    await markAssertionConsumed(IDENTITY, now);
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: now } } });
  });

  it("still reports a clean first-use even if opportunistic pruning fails", async () => {
    mockCreate.mockResolvedValue({});
    mockDeleteMany.mockRejectedValue(new Error("prune failed"));
    const res = await markAssertionConsumed(IDENTITY);
    expect(res).toEqual({ duplicate: false });
  });
});
