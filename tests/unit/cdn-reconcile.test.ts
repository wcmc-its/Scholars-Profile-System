import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #353 — `reconcileCdnInvalidations` (ADR-005 failure-model layer 3) unit tests.
 * Mocks the collaborators at the module boundary, NO live DB / NO real AWS:
 *   - `@/lib/db` — the `cdnInvalidation.findMany` (read) + `.update` (write) the
 *       reconciler touches.
 *   - `@/lib/edit/revalidation` — `sendCloudFrontInvalidation` (the shared
 *       low-level send whose resolve/reject drives the reflected/failed tally).
 *
 * Covers: dormant no-op (no distribution id), pending-row predicate (sentinel
 * NULL, grace cutoff, attempts < max, batch bound), paths JSON round-trip,
 * success stamps invalidatedAt, failure increments attempts + lastError and
 * stays pending, grace-window exclusion is delegated to the query filter, and
 * max-attempts exhaustion emits the alarm-shaped line.
 */
const hoisted = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockSend: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: { cdnInvalidation: { findMany: hoisted.mockFindMany } },
    write: { cdnInvalidation: { update: hoisted.mockUpdate } },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  sendCloudFrontInvalidation: hoisted.mockSend,
}));

import { reconcileCdnInvalidations } from "@/lib/edit/cdn-reconcile";

const NOW = new Date("2026-06-10T12:00:00.000Z");
const DIST = "E1234567890ABC";

beforeEach(() => {
  for (const m of Object.values(hoisted)) m.mockReset();
  hoisted.mockFindMany.mockResolvedValue([]);
  hoisted.mockUpdate.mockResolvedValue({});
  hoisted.mockSend.mockResolvedValue(undefined);
  process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = DIST;
  // Silence the run-summary line; failure tests spy console.error locally.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("reconcileCdnInvalidations — dormancy", () => {
  it("no-ops with a zeroed summary when no distribution id is set (never queries)", async () => {
    delete process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID;
    const summary = await reconcileCdnInvalidations({ now: NOW });
    expect(summary).toEqual({ scanned: 0, reflected: 0, failed: 0 });
    expect(hoisted.mockFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockSend).not.toHaveBeenCalled();
  });
});

describe("reconcileCdnInvalidations — pending-row selection", () => {
  it("scopes to sentinel NULL, grace cutoff, attempts < max, and batch bound", async () => {
    await reconcileCdnInvalidations({
      batchSize: 50,
      graceSeconds: 120,
      maxAttempts: 7,
      now: NOW,
    });

    expect(hoisted.mockFindMany).toHaveBeenCalledTimes(1);
    const arg = hoisted.mockFindMany.mock.calls[0][0];
    expect(arg.where.invalidatedAt).toBeNull();
    expect(arg.where.createdAt).toEqual({ lt: new Date("2026-06-10T11:58:00.000Z") }); // NOW - 120s
    expect(arg.where.attempts).toEqual({ lt: 7 });
    expect(arg.take).toBe(50);
    expect(arg.orderBy).toEqual({ createdAt: "asc" });
  });

  it("defaults to batch 200, a 60s grace, and a 10-attempt cap", async () => {
    await reconcileCdnInvalidations({ now: NOW });
    const arg = hoisted.mockFindMany.mock.calls[0][0];
    expect(arg.take).toBe(200);
    expect(arg.where.createdAt).toEqual({ lt: new Date("2026-06-10T11:59:00.000Z") });
    expect(arg.where.attempts).toEqual({ lt: 10 });
  });

  it("empty pending set → no send calls, zero summary", async () => {
    const summary = await reconcileCdnInvalidations({ now: NOW });
    expect(summary).toEqual({ scanned: 0, reflected: 0, failed: 0 });
    expect(hoisted.mockSend).not.toHaveBeenCalled();
  });
});

describe("reconcileCdnInvalidations — replay each pending row", () => {
  it("round-trips the persisted paths JSON and replays them verbatim, stamping invalidatedAt", async () => {
    const paths = ["/browse", "/scholars/ann", "/scholars/bob"];
    hoisted.mockFindMany.mockResolvedValue([
      { id: "r1", paths: JSON.stringify(paths), attempts: 0 },
    ]);

    const summary = await reconcileCdnInvalidations({ now: NOW });

    expect(summary).toEqual({ scanned: 1, reflected: 1, failed: 0 });
    // Replayed verbatim — NOT recomputed.
    expect(hoisted.mockSend).toHaveBeenCalledWith(DIST, paths);
    expect(hoisted.mockUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { invalidatedAt: NOW },
    });
  });

  it("reflects each of a batch and tallies reflected", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "r1", paths: '["/a"]', attempts: 0 },
      { id: "r2", paths: '["/b"]', attempts: 3 },
    ]);

    const summary = await reconcileCdnInvalidations({ now: NOW });

    expect(summary).toEqual({ scanned: 2, reflected: 2, failed: 0 });
    expect(hoisted.mockSend).toHaveBeenNthCalledWith(1, DIST, ["/a"]);
    expect(hoisted.mockSend).toHaveBeenNthCalledWith(2, DIST, ["/b"]);
  });

  it("a failed send increments attempts + records lastError and stays pending (sentinel left NULL)", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "r1", paths: '["/scholars/ann"]', attempts: 2 },
    ]);
    hoisted.mockSend.mockRejectedValue(new Error("cloudfront 503"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await reconcileCdnInvalidations({ now: NOW });

    expect(summary).toEqual({ scanned: 1, reflected: 0, failed: 1 });
    // attempts bumped, lastError recorded, invalidatedAt NOT set → still pending.
    expect(hoisted.mockUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { attempts: 3, lastError: "cloudfront 503" },
    });
    const failLog = consoleError.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((l) => l.event === "edit_cdn_reconcile_failed");
    expect(failLog).toMatchObject({ id: "r1", attempts: 3 });
    consoleError.mockRestore();
  });

  it("emits an alarm-shaped exhausted line when attempts reach maxAttempts", async () => {
    // attempts 9, maxAttempts 10 → this failed retry makes it 10 = exhausted.
    hoisted.mockFindMany.mockResolvedValue([
      { id: "stuck", paths: '["/scholars/eve"]', attempts: 9 },
    ]);
    hoisted.mockSend.mockRejectedValue(new Error("AccessDenied"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await reconcileCdnInvalidations({ now: NOW, maxAttempts: 10 });

    expect(summary).toEqual({ scanned: 1, reflected: 0, failed: 1 });
    const logs = consoleError.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(logs.find((l) => l.event === "edit_cdn_reconcile_failed")).toMatchObject({
      id: "stuck",
      attempts: 10,
    });
    expect(logs.find((l) => l.event === "edit_cdn_reconcile_exhausted")).toMatchObject({
      id: "stuck",
      attempts: 10,
    });
    consoleError.mockRestore();
  });

  it("does NOT emit exhausted while still under the cap", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "r1", paths: '["/a"]', attempts: 0 },
    ]);
    hoisted.mockSend.mockRejectedValue(new Error("transient"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await reconcileCdnInvalidations({ now: NOW, maxAttempts: 10 });

    const logs = consoleError.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(logs.find((l) => l.event === "edit_cdn_reconcile_exhausted")).toBeUndefined();
    consoleError.mockRestore();
  });

  it("treats a malformed paths payload as a failed attempt without sending", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "bad", paths: "not json", attempts: 0 },
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await reconcileCdnInvalidations({ now: NOW });

    expect(summary).toEqual({ scanned: 1, reflected: 0, failed: 1 });
    expect(hoisted.mockSend).not.toHaveBeenCalled();
    expect(hoisted.mockUpdate).toHaveBeenCalledWith({
      where: { id: "bad" },
      data: { attempts: 1, lastError: "unparseable paths payload" },
    });
    consoleError.mockRestore();
  });

  it("mixes success and failure in one run", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "ok1", paths: '["/a"]', attempts: 0 },
      { id: "bad", paths: '["/b"]', attempts: 0 },
    ]);
    hoisted.mockSend
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await reconcileCdnInvalidations({ now: NOW });
    expect(summary).toEqual({ scanned: 2, reflected: 1, failed: 1 });
  });

  it("never throws even when the bookkeeping update itself fails", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "r1", paths: '["/a"]', attempts: 0 },
    ]);
    hoisted.mockSend.mockRejectedValue(new Error("send failed"));
    hoisted.mockUpdate.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await reconcileCdnInvalidations({ now: NOW });
    expect(summary).toEqual({ scanned: 1, reflected: 0, failed: 1 });
  });
});
