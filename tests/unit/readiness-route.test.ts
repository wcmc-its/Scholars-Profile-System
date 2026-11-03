/**
 * Unit tests for app/readiness/route.ts — the deep readiness probe.
 *
 * The OpenSearch check must exercise what search needs (a read on the people
 * alias with the app's own client), never ping() — `HEAD /` needs the
 * cluster-level `cluster:monitor/main` permission, which the app's read-only
 * OpenSearch role does not hold, so ping() 403'd while search worked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQueryRaw, mockSearch, mockPing } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockSearch: vi.fn(),
  mockPing: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: mockQueryRaw } }));
vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  searchClient: () => ({ search: mockSearch, ping: mockPing }),
}));

import { GET } from "@/app/readiness/route";

describe("GET /readiness", () => {
  beforeEach(() => {
    mockQueryRaw.mockReset().mockResolvedValue([{ 1: 1 }]);
    mockSearch.mockReset().mockResolvedValue({ statusCode: 200, body: { hits: { hits: [] } } });
    // A cluster-level call the app role can't make: must not be what readiness relies on.
    mockPing.mockReset().mockRejectedValue(
      Object.assign(new Error("Response Error"), { meta: { statusCode: 403 } }),
    );
  });

  it("is ready when the DB answers and a zero-hit search on the people alias succeeds", async () => {
    const resp = await GET();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      status: "ok",
      checks: { db: { ok: true }, opensearch: { ok: true } },
    });
    expect(mockPing).not.toHaveBeenCalled();
    expect(mockSearch).toHaveBeenCalledTimes(1);
    const [params] = mockSearch.mock.calls[0];
    expect(params.index).toBe("scholars-people");
    expect(params.body.size).toBe(0);
  });

  it("is degraded (503) with the HTTP status when the search fails", async () => {
    mockSearch.mockRejectedValue(
      Object.assign(new Error("Response Error"), { meta: { statusCode: 403 } }),
    );
    const resp = await GET();
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({
      status: "degraded",
      checks: { db: { ok: true }, opensearch: { ok: false, error: "Response Error (HTTP 403)" } },
    });
  });

  it("is degraded (503) when the DB fails", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
    const resp = await GET();
    expect(resp.status).toBe(503);
    const json = await resp.json();
    expect(json.checks.db).toEqual({ ok: false, error: "connection refused" });
    expect(json.checks.opensearch).toEqual({ ok: true });
  });
});
