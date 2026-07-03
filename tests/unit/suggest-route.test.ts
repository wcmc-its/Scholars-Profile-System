/**
 * Tests for GET /api/search/suggest (app/api/search/suggest/route.ts).
 *
 * Refs #1439 (auth-audit finding 6): the route mints an httpOnly telemetry
 * cookie (`sps_telemetry_session`) and its path matches the CloudFront
 * `/api/search*` behavior, which caches ~1s keyed on the query string only
 * and does not strip Set-Cookie. A Set-Cookie response must therefore carry
 * `Cache-Control: no-store` so it is never edge-cached and one viewer's minted
 * telemetry id can't be replayed to other cookieless viewers.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api/search", () => ({
  suggestEntities: vi.fn(async () => []),
}));
vi.mock("@/lib/api/suggest-log", () => ({
  hashSessionId: (raw: string) => `hashed-${raw}`,
  logAutocompleteShown: vi.fn(),
}));

import { GET } from "@/app/api/search/suggest/route";

const TELEMETRY_COOKIE = "sps_telemetry_session";

function makeRequest(cookie?: string): NextRequest {
  return new NextRequest("http://localhost/api/search/suggest?q=cancer", {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
}

describe("GET /api/search/suggest telemetry-cookie caching (Refs #1439)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the response no-store when it mints a telemetry Set-Cookie", async () => {
    const resp = await GET(makeRequest());

    // Cookie was minted...
    expect(resp.cookies.get(TELEMETRY_COOKIE)?.value).toBeTruthy();
    // ...so the response must not be edge-cacheable.
    expect(resp.headers.get("cache-control")).toBe("no-store");
  });

  it("does not mint a cookie (or force no-store) when one is already present", async () => {
    const resp = await GET(makeRequest(`${TELEMETRY_COOKIE}=existing-uuid`));

    // No fresh Set-Cookie for this request.
    expect(resp.cookies.get(TELEMETRY_COOKIE)).toBeUndefined();
    // The deliberate short-TTL `/api/search*` cache is left untouched here:
    // no Set-Cookie means nothing to protect, so the route adds no no-store.
    expect(resp.headers.get("cache-control")).toBeNull();
  });
});
