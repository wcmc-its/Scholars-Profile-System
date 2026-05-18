/**
 * Tests for app/api/revalidate/route.ts — Phase 2 Wave 4 ETL → ISR webhook.
 *
 * Threat coverage (Phase 2 Plan 09 threat register):
 *   - T-02-09-01 Spoofing — auth gate via `Authorization: Bearer` token
 *   - T-02-09-02 Tampering — path traversal / injection rejected by whitelist
 *   - T-02-09-03 Information disclosure — token never echoed in error body
 *
 * `revalidatePath` is mocked out of `next/cache`; the route's contract is that
 * a valid call results in exactly one `revalidatePath(path)` invocation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockRevalidatePath } = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

import { POST } from "@/app/api/revalidate/route";
import { NextRequest } from "next/server";
import { resetRevalidateTokenCache } from "@/lib/revalidate-auth";

function makeRequest(
  opts: {
    path?: string;
    /** Wrapped as `Authorization: Bearer <token>`. */
    token?: string;
    /** Raw `Authorization` header value, for malformed-header cases. */
    authorization?: string;
    method?: string;
  } = {},
): NextRequest {
  const url = new URL("http://localhost/api/revalidate");
  if (opts.path !== undefined) url.searchParams.set("path", opts.path);
  const headers = new Headers();
  if (opts.authorization !== undefined) {
    headers.set("authorization", opts.authorization);
  } else if (opts.token !== undefined) {
    headers.set("authorization", `Bearer ${opts.token}`);
  }
  return new NextRequest(url, { method: opts.method ?? "POST", headers });
}

describe("POST /api/revalidate", () => {
  beforeEach(() => {
    mockRevalidatePath.mockReset();
    process.env.SCHOLARS_REVALIDATE_TOKEN = "test-token-abc";
    delete process.env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS;
    resetRevalidateTokenCache();
  });

  it("401 when token missing", async () => {
    const req = makeRequest({ path: "/" });
    const resp = await POST(req);
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error).toBe("unauthorized");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("401 when token wrong", async () => {
    const req = makeRequest({ path: "/", token: "wrong" });
    const resp = await POST(req);
    expect(resp.status).toBe(401);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("400 when path missing", async () => {
    const req = makeRequest({ token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/missing path/i);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("400 when path not in whitelist", async () => {
    const req = makeRequest({ path: "/some/random/path", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/not allowed/i);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("200 + revalidates / when path is /", async () => {
    const req = makeRequest({ path: "/", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.revalidated).toBe("/");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("200 + revalidates /about", async () => {
    const req = makeRequest({ path: "/about", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/about");
  });

  it("200 + revalidates /about/methodology", async () => {
    const req = makeRequest({ path: "/about/methodology", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/about/methodology");
  });

  it("200 + revalidates /browse", async () => {
    const req = makeRequest({ path: "/browse", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.revalidated).toBe("/browse");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/browse");
  });

  it("200 + revalidates /scholars/{slug}", async () => {
    const req = makeRequest({ path: "/scholars/jane-smith", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/scholars/jane-smith");
  });

  it("200 + revalidates /topics/{slug}", async () => {
    const req = makeRequest({ path: "/topics/cardiovascular-disease", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/topics/cardiovascular-disease");
  });

  it("400 on path with traversal/injection chars (../)", async () => {
    const req = makeRequest({ path: "/scholars/../etc/passwd", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("400 on slug with dots/slashes", async () => {
    const req = makeRequest({ path: "/topics/foo.bar/baz", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("does not echo the received token in 401 body", async () => {
    const req = makeRequest({ path: "/", token: "leaked-secret-attempt" });
    const resp = await POST(req);
    expect(resp.status).toBe(401);
    const body = await resp.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("leaked-secret-attempt");
    expect(serialized).not.toContain("test-token-abc");
  });
});

describe("POST /api/revalidate — Phase 5 sitemap path", () => {
  beforeEach(() => {
    mockRevalidatePath.mockReset();
    process.env.SCHOLARS_REVALIDATE_TOKEN = "test-token-abc";
    delete process.env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS;
    resetRevalidateTokenCache();
  });

  it("200 + revalidates /sitemap.xml (D-07 — ETL triggers sitemap ISR)", async () => {
    // This test is RED until /sitemap.xml is added to ALLOWED_EXACT in route.ts.
    // Plan 02 adds the entry; until then, the route returns 400 "path not allowed".
    const req = makeRequest({ path: "/sitemap.xml", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.revalidated).toBe("/sitemap.xml");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/sitemap.xml");
  });

  it("400 on /_next/static/foo (not a revalidatable path)", async () => {
    const req = makeRequest({ path: "/_next/static/foo", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("POST /api/revalidate — Phase 3 department paths", () => {
  beforeEach(() => {
    mockRevalidatePath.mockReset();
    process.env.SCHOLARS_REVALIDATE_TOKEN = "test-token-abc";
    delete process.env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS;
    resetRevalidateTokenCache();
  });

  it("200 + revalidates /departments/{slug}", async () => {
    const req = makeRequest({ path: "/departments/medicine", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/departments/medicine");
  });

  it("200 + revalidates /departments/{slug}/divisions/{div}", async () => {
    const req = makeRequest({ path: "/departments/medicine/divisions/cardiology", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/departments/medicine/divisions/cardiology");
  });

  it("400 on /departments/ (bare, no slug)", async () => {
    const req = makeRequest({ path: "/departments/", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("400 on /departments/{slug}/divisions (no div slug)", async () => {
    const req = makeRequest({ path: "/departments/medicine/divisions", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("400 on path-traversal in dept path", async () => {
    const req = makeRequest({ path: "/departments/../etc/passwd", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("401 regression — wrong token still rejected for dept path", async () => {
    const req = makeRequest({ path: "/departments/medicine", token: "WRONG" });
    const resp = await POST(req);
    expect(resp.status).toBe(401);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("POST /api/revalidate — Phase 5 sitemap revalidation (SEO-01)", () => {
  beforeEach(() => {
    mockRevalidatePath.mockReset();
    process.env.SCHOLARS_REVALIDATE_TOKEN = "test-token-abc";
    delete process.env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS;
    resetRevalidateTokenCache();
  });

  it("200 + revalidates /sitemap.xml when ETL calls after run", async () => {
    const req = makeRequest({ path: "/sitemap.xml", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.revalidated).toBe("/sitemap.xml");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/sitemap.xml");
  });

  it("400 on /_next/static/foo — static asset paths must not be revalidatable", async () => {
    const req = makeRequest({ path: "/_next/static/foo", token: "test-token-abc" });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("401 regression — wrong token still rejected for sitemap path", async () => {
    const req = makeRequest({ path: "/sitemap.xml", token: "WRONG" });
    const resp = await POST(req);
    expect(resp.status).toBe(401);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("POST /api/revalidate — bearer auth + rotation (#103 / B04)", () => {
  beforeEach(() => {
    mockRevalidatePath.mockReset();
    process.env.SCHOLARS_REVALIDATE_TOKEN = "current-token";
    delete process.env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS;
    resetRevalidateTokenCache();
  });

  it("401 when the Authorization header is absent", async () => {
    const resp = await POST(makeRequest({ path: "/" }));
    expect(resp.status).toBe(401);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("401 on a non-Bearer Authorization scheme", async () => {
    const resp = await POST(
      makeRequest({ path: "/", authorization: "Basic dXNlcjpwYXNz" }),
    );
    expect(resp.status).toBe(401);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("401 on a Bearer header with an empty token", async () => {
    const resp = await POST(makeRequest({ path: "/", authorization: "Bearer " }));
    expect(resp.status).toBe(401);
  });

  it("401 on the raw token sent without the Bearer scheme", async () => {
    const resp = await POST(
      makeRequest({ path: "/", authorization: "current-token" }),
    );
    expect(resp.status).toBe(401);
  });

  it("200 with the current token", async () => {
    const resp = await POST(makeRequest({ path: "/", token: "current-token" }));
    expect(resp.status).toBe(200);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("accepts a case-insensitive Bearer scheme", async () => {
    const resp = await POST(
      makeRequest({ path: "/", authorization: "bearer current-token" }),
    );
    expect(resp.status).toBe(200);
  });

  it("200 with the previous token during a rotation window", async () => {
    process.env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS = "previous-token";
    resetRevalidateTokenCache();
    const resp = await POST(makeRequest({ path: "/", token: "previous-token" }));
    expect(resp.status).toBe(200);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("401 for a token that is neither current nor previous", async () => {
    process.env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS = "previous-token";
    resetRevalidateTokenCache();
    const resp = await POST(
      makeRequest({ path: "/", token: "two-rotations-ago" }),
    );
    expect(resp.status).toBe(401);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("500 when no token is configured at all", async () => {
    delete process.env.SCHOLARS_REVALIDATE_TOKEN;
    delete process.env.SCHOLARS_REVALIDATE_TOKEN_PREVIOUS;
    resetRevalidateTokenCache();
    const resp = await POST(makeRequest({ path: "/", token: "current-token" }));
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.error).toMatch(/misconfigured/i);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("does not echo the presented token in the 401 body", async () => {
    const resp = await POST(
      makeRequest({ path: "/", token: "leaked-attempt-xyz" }),
    );
    expect(resp.status).toBe(401);
    const serialized = JSON.stringify(await resp.json());
    expect(serialized).not.toContain("leaked-attempt-xyz");
    expect(serialized).not.toContain("current-token");
  });
});
