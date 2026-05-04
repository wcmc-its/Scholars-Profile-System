/**
 * RED unit tests for app/robots.ts (Phase 5 / SEO-02).
 *
 * These tests define the contract that Plan 02 must satisfy. They FAIL now
 * because app/robots.ts does not yet exist. That is the expected RED state.
 *
 * Contract (D-19 + D-20):
 *   - Default export is a synchronous function returning MetadataRoute.Robots
 *   - rules.userAgent === '*'
 *   - rules.allow === '/'
 *   - rules.disallow includes '/api/' and '/admin/'
 *   - rules.disallow does NOT include '/_next/' (D-20 critical — Googlebot needs /_next/static/)
 *   - rules.disallow does NOT include '/' (would block the entire site)
 *   - sitemap === `${NEXT_PUBLIC_SITE_URL}/sitemap.xml`
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: vi.fn() },
    topic: { findMany: vi.fn() },
    department: { findMany: vi.fn() },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  process.env.NEXT_PUBLIC_SITE_URL = "https://scholars.weill.cornell.edu";
});

describe("app/robots.ts — robots function", () => {
  it("default export is a function", async () => {
    // Will fail with module-not-found until Plan 02 creates app/robots.ts
    const { default: robots } = await import("@/app/robots");
    expect(typeof robots).toBe("function");
  });

  it("returns an object with rules targeting all user agents", async () => {
    const { default: robots } = await import("@/app/robots");
    const out = robots();
    const rules = Array.isArray(out.rules) ? out.rules[0] : out.rules;
    expect(rules.userAgent).toBe("*");
  });

  it("rules.allow includes '/' allowing all public pages", async () => {
    const { default: robots } = await import("@/app/robots");
    const out = robots();
    const rules = Array.isArray(out.rules) ? out.rules[0] : out.rules;
    const allow = Array.isArray(rules.allow) ? rules.allow : [rules.allow];
    expect(allow).toContain("/");
  });

  it("rules.disallow includes /api/ and /admin/", async () => {
    const { default: robots } = await import("@/app/robots");
    const out = robots();
    const rules = Array.isArray(out.rules) ? out.rules[0] : out.rules;
    const disallow = Array.isArray(rules.disallow) ? rules.disallow : [rules.disallow];
    expect(disallow).toEqual(expect.arrayContaining(["/api/", "/admin/"]));
  });

  it("rules.disallow does NOT include /_next/ (D-20 critical)", async () => {
    // Googlebot needs access to /_next/static/ to render JavaScript pages.
    // If /_next/ is disallowed, Google cannot hydrate JS and will not index content.
    const { default: robots } = await import("@/app/robots");
    const out = robots();
    const rules = Array.isArray(out.rules) ? out.rules[0] : out.rules;
    const disallow = Array.isArray(rules.disallow) ? rules.disallow : [rules.disallow];
    expect(disallow).not.toContain("/_next/");
  });

  it("rules.disallow does NOT include '/' (would block the entire site)", async () => {
    const { default: robots } = await import("@/app/robots");
    const out = robots();
    const rules = Array.isArray(out.rules) ? out.rules[0] : out.rules;
    const disallow = Array.isArray(rules.disallow) ? rules.disallow : [rules.disallow];
    expect(disallow).not.toContain("/");
  });

  it("sitemap field is absolute URL using NEXT_PUBLIC_SITE_URL", async () => {
    const { default: robots } = await import("@/app/robots");
    const out = robots();
    expect(out.sitemap).toBe("https://scholars.weill.cornell.edu/sitemap.xml");
  });

  it("sitemap field updates when NEXT_PUBLIC_SITE_URL changes", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3002";
    // Re-import to pick up env change (dynamic import with module reset)
    vi.resetModules();
    const { default: robots } = await import("@/app/robots");
    const out = robots();
    // Should use the env var, not a hardcoded production URL
    expect(out.sitemap).toBe("http://localhost:3002/sitemap.xml");
  });
});
