/**
 * Route tests for `DELETE /api/edit/biosketch/generations` (#1992) — pruning one biosketch
 * generation run out of the /edit history. The policy behind the hard delete is documented in
 * the route; these pin the three things that make it safe: the authorization key is the ROW'S OWN
 * `cwid` (nothing in the request body names a scholar), the found-vs-gone verdict is the WRITER'S,
 * and the delete + the B03 audit row land in ONE transaction with `beforeValues` carrying the
 * run's identity and none of the drafted prose.
 *
 * `authorizeOverviewWrite` is mocked so the `entityId` it is handed can be asserted exactly —
 * that argument IS the security property. The mock harness otherwise mirrors
 * `honor-route.test.ts`, the sibling surface that shares the predicate.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockEnabled,
  mockAuthorizeOverviewWrite,
  mockGenerationFindUnique,
  mockTransaction,
  mockTxGenerationDeleteMany,
  mockTxExecuteRaw,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockAuthorizeOverviewWrite: vi.fn(),
  mockGenerationFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxGenerationDeleteMany: vi.fn(),
  mockTxExecuteRaw: vi.fn(),
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
vi.mock("@/lib/edit/biosketch-generator", () => ({
  isBiosketchGenerateEnabled: mockEnabled,
}));
vi.mock("@/lib/edit/overview-authz", () => ({
  authorizeOverviewWrite: mockAuthorizeOverviewWrite,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: { biosketchGeneration: { findUnique: mockGenerationFindUnique } },
    write: { $transaction: mockTransaction },
  },
}));

import { DELETE } from "@/app/api/edit/biosketch/generations/route";

const SELF = { cwid: "abc1001", isSuperuser: false, isCommsSteward: false };

const fakeTx = {
  biosketchGeneration: { deleteMany: mockTxGenerationDeleteMany },
  $executeRaw: mockTxExecuteRaw,
};

/** A stored run owned by `cwid`. `entries` is the v7 `{ title, body }` shape. */
function run(cwid: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "gen-1",
    cwid,
    mode: "contributions",
    model: "us.anthropic.claude-opus-4-8",
    promptVersion: "v7",
    entries: [
      { title: "CAR-T resistance", body: "We defined the resistance program." },
      { title: "Trial design", body: "We ran the first-in-human study." },
    ],
    createdByCwid: cwid,
    impersonatedCwid: null,
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    ...overrides,
  };
}

function del(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/biosketch/generations", {
    method: "DELETE",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockGetEditSession.mockResolvedValue(SELF);
  mockAuthorizeOverviewWrite.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
  mockGenerationFindUnique.mockResolvedValue(run("abc1001"));
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxGenerationDeleteMany.mockResolvedValue({ count: 1 });
  mockTxExecuteRaw.mockResolvedValue(1);
});

describe("DELETE /api/edit/biosketch/generations", () => {
  it("404s while the flag is off, before any session or DB work", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await DELETE(del({ generationId: "gen-1" }));
    expect(res.status).toBe(404);
    expect(mockGenerationFindUnique).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await DELETE(del({ generationId: "gen-1" }));
    expect(res.status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400s on a missing generationId, before reading anything", async () => {
    const res = await DELETE(del({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_generation_id",
      field: "generationId",
    });
    expect(mockGenerationFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-string id", { generationId: 12 }],
    ["an empty id", { generationId: "" }],
    ["an over-length id", { generationId: "g".repeat(65) }],
  ])("400s on %s", async (_label, body) => {
    const res = await DELETE(del(body));
    expect(res.status).toBe(400);
    expect(mockGenerationFindUnique).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404s when the run is already gone (a double-click or a retry, not a 500)", async () => {
    mockGenerationFindUnique.mockResolvedValue(null);
    const res = await DELETE(del({ generationId: "ghost" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    // The predicate never runs for a row that isn't there — no probe of who owns what.
    expect(mockAuthorizeOverviewWrite).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404s — not 500 — when the READER still sees the row but the WRITER deletes nothing", async () => {
    // The replication window: a retry lands while the replica still carries the row the first
    // request already deleted on the writer. The reader answers "found", so the whole delete
    // branch runs; only the writer's own count can tell the truth.
    mockTxGenerationDeleteMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(del({ generationId: "gen-1" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    // And no audit row for a delete that erased nothing — the transaction rolled back.
    expect(mockTxExecuteRaw).not.toHaveBeenCalled();
  });

  it("authorizes against the ROW'S OWN cwid, never anything in the body", async () => {
    // The body carries a `cwid` the caller DOES own; the row belongs to someone else. If the
    // route ever keyed off the body, this would be allowed.
    mockGenerationFindUnique.mockResolvedValue(run("xyz9001"));
    mockAuthorizeOverviewWrite.mockResolvedValue({ ok: false, reason: "not_self" });
    const res = await DELETE(del({ generationId: "gen-1", cwid: "abc1001" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockAuthorizeOverviewWrite).toHaveBeenCalledTimes(1);
    expect(mockAuthorizeOverviewWrite.mock.calls[0][0]).toMatchObject({ entityId: "xyz9001" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("deletes the owner's own run — 200, one tx, delete keyed on the row id", async () => {
    const res = await DELETE(del({ generationId: "gen-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: "gen-1" });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // Keyed on the row id — one run, not every run of the same settings (cf. the Matcha DELETE,
    // which fans out over the paste hash because the PASTE is what the officer names there).
    expect(mockTxGenerationDeleteMany).toHaveBeenCalledWith({ where: { id: "gen-1" } });
  });

  it("appends exactly one B03 audit row, inside the same transaction", async () => {
    await DELETE(del({ generationId: "gen-1" }));
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[1]).toBe("abc1001"); // actor_cwid — the accountable human
    expect(args[2]).toBe("biosketch_generation"); // target_entity_type (SQL ENUM value)
    expect(args[3]).toBe("gen-1"); // target_entity_id
    expect(args[4]).toBe("biosketch_generation_delete"); // action (SQL ENUM value)
    expect(args[7]).toBeNull(); // after_values — nothing exists afterwards
  });

  it("records WHAT was erased and none of the drafted prose", async () => {
    await DELETE(del({ generationId: "gen-1" }));
    const before = JSON.parse(String((mockTxExecuteRaw.mock.calls[0] as unknown[])[6]));
    expect(before).toMatchObject({
      cwid: "abc1001",
      mode: "contributions",
      model: "us.anthropic.claude-opus-4-8",
      promptVersion: "v7",
      entryCount: 2,
      createdByCwid: "abc1001",
      generatedAsCwid: null,
      createdAt: "2026-07-20T12:00:00.000Z",
    });
    // NOT `impersonatedCwid`: the audit row's own column of that name is the overlay THIS DELETE
    // ran under, and one record cannot name two different actors the same way.
    expect(before).not.toHaveProperty("impersonatedCwid");
    // The narrative is the thing the scholar asked us to stop keeping — re-persisting it in an
    // append-only log would defeat the delete.
    expect(JSON.stringify(before)).not.toContain("resistance program");
    expect(before).not.toHaveProperty("entries");
  });

  it("500s write_failed when the transaction throws (nothing claimed deleted)", async () => {
    mockTransaction.mockRejectedValue(new Error("deadlock"));
    const res = await DELETE(del({ generationId: "gen-1" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
