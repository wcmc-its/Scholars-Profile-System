import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #393 — `reconcileSearchSuppressions` (ADR-005 failure-model layer 3) unit
 * tests. Mocks the three collaborators at the module boundary:
 *   - `@/lib/db` — only the `suppression.findMany` the reconciler queries.
 *   - `@/lib/edit/revalidation` — `resolveAffectedProfiles` (re-derivation).
 *   - `@/lib/edit/search-suppression` — `reflectSearchSuppression` (the
 *       idempotent reflect whose `{ ok }` drives the reflected/failed tally).
 *
 * Asserts the stale-row predicate (entity-type scope, sentinel NULL, grace
 * cutoff, batch bound), per-row re-derivation, the tally, and alarm-shaped
 * failure logging.
 */
const hoisted = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockResolveAffected: vi.fn(),
  mockReflect: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { read: { suppression: { findMany: hoisted.mockFindMany } } },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  resolveAffectedProfiles: hoisted.mockResolveAffected,
}));
vi.mock("@/lib/edit/search-suppression", () => ({
  reflectSearchSuppression: hoisted.mockReflect,
}));

import { reconcileSearchSuppressions } from "@/lib/edit/search-reconcile";

const NOW = new Date("2026-05-29T12:00:00.000Z");

beforeEach(() => {
  for (const m of Object.values(hoisted)) m.mockReset();
  hoisted.mockFindMany.mockResolvedValue([]);
  hoisted.mockResolveAffected.mockResolvedValue([]);
  hoisted.mockReflect.mockResolvedValue({ ok: true });
  // Silence the run-summary line; failure tests spy console.error locally.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("reconcileSearchSuppressions — stale-row selection", () => {
  it("scopes to fast-path entity types, sentinel NULL, grace cutoff, and batch", async () => {
    await reconcileSearchSuppressions({ batchSize: 50, graceSeconds: 120, now: NOW });

    expect(hoisted.mockFindMany).toHaveBeenCalledTimes(1);
    const arg = hoisted.mockFindMany.mock.calls[0][0];
    // #481(a) — grant joins scholar/publication now that it has a fast-path.
    expect(arg.where.entityType).toEqual({ in: ["scholar", "publication", "grant"] });
    expect(arg.where.searchReflectedAt).toBeNull();
    const cutoff = new Date("2026-05-29T11:58:00.000Z"); // NOW - 120s
    expect(arg.where.OR).toEqual([
      { revokedAt: { not: null, lt: cutoff } },
      { revokedAt: null, createdAt: { lt: cutoff } },
    ]);
    expect(arg.take).toBe(50);
    expect(arg.orderBy).toEqual({ createdAt: "asc" });
  });

  it("defaults to batch 200 and a 60s grace", async () => {
    await reconcileSearchSuppressions({ now: NOW });
    const arg = hoisted.mockFindMany.mock.calls[0][0];
    expect(arg.take).toBe(200);
    expect(arg.where.OR[0].revokedAt.lt).toEqual(new Date("2026-05-29T11:59:00.000Z"));
  });

  it("empty stale set → no reflect calls, zero summary", async () => {
    const summary = await reconcileSearchSuppressions({ now: NOW });
    expect(summary).toEqual({ scanned: 0, reflected: 0, failed: 0 });
    expect(hoisted.mockReflect).not.toHaveBeenCalled();
  });
});

describe("reconcileSearchSuppressions — reflect each stale row", () => {
  it("re-derives affected profiles and reflects each row; tallies reflected", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "s1", entityType: "scholar", entityId: "ann", contributorCwid: null },
      { id: "s2", entityType: "publication", entityId: "999", contributorCwid: "bob" },
    ]);
    hoisted.mockResolveAffected
      .mockResolvedValueOnce([{ slug: "ann", cwid: "ann" }])
      .mockResolvedValueOnce([{ slug: "bob", cwid: "bob" }]);

    const summary = await reconcileSearchSuppressions({ now: NOW });

    expect(summary).toEqual({ scanned: 2, reflected: 2, failed: 0 });
    expect(hoisted.mockResolveAffected).toHaveBeenNthCalledWith(1, "scholar", "ann", null);
    expect(hoisted.mockResolveAffected).toHaveBeenNthCalledWith(2, "publication", "999", "bob");
    expect(hoisted.mockReflect).toHaveBeenNthCalledWith(1, {
      suppressionId: "s1",
      entityType: "scholar",
      entityId: "ann",
      contributorCwid: null,
      affectedCwids: ["ann"],
    });
    expect(hoisted.mockReflect).toHaveBeenNthCalledWith(2, {
      suppressionId: "s2",
      entityType: "publication",
      entityId: "999",
      contributorCwid: "bob",
      affectedCwids: ["bob"],
    });
  });

  it("reflects a stale grant row (#481(a) funding fast-path)", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "g1", entityType: "grant", entityId: "INFOED-ACCT1-ann", contributorCwid: null },
    ]);
    hoisted.mockResolveAffected.mockResolvedValue([]);

    const summary = await reconcileSearchSuppressions({ now: NOW });

    expect(summary).toEqual({ scanned: 1, reflected: 1, failed: 0 });
    expect(hoisted.mockReflect).toHaveBeenCalledWith({
      suppressionId: "g1",
      entityType: "grant",
      entityId: "INFOED-ACCT1-ann",
      contributorCwid: null,
      affectedCwids: [],
    });
  });

  it("counts a failed reflect and logs alarm-shaped, without throwing", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "s1", entityType: "scholar", entityId: "ann", contributorCwid: null },
    ]);
    hoisted.mockResolveAffected.mockResolvedValue([{ slug: "ann", cwid: "ann" }]);
    hoisted.mockReflect.mockResolvedValue({ ok: false, error: new Error("opensearch down") });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await reconcileSearchSuppressions({ now: NOW });

    expect(summary).toEqual({ scanned: 1, reflected: 0, failed: 1 });
    const failLog = consoleError.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((l) => l.event === "edit_search_reconcile_failed");
    expect(failLog).toMatchObject({
      suppressionId: "s1",
      entityType: "scholar",
      entityId: "ann",
    });
    consoleError.mockRestore();
  });

  it("mixes success and failure in one run", async () => {
    hoisted.mockFindMany.mockResolvedValue([
      { id: "ok1", entityType: "scholar", entityId: "ann", contributorCwid: null },
      { id: "bad", entityType: "scholar", entityId: "eve", contributorCwid: null },
    ]);
    hoisted.mockResolveAffected.mockResolvedValue([{ slug: "x", cwid: "x" }]);
    hoisted.mockReflect
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "boom" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await reconcileSearchSuppressions({ now: NOW });
    expect(summary).toEqual({ scanned: 2, reflected: 1, failed: 1 });
  });
});
