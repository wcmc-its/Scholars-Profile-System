/**
 * RED unit tests for app/robots.ts — Phase 5 / SEO-02.
 *
 * Contract:
 *   - Default export is function returning MetadataRoute.Robots
 *   - rules.userAgent === '*'
 *   - rules.allow === '/' (or includes '/')
 *   - rules.disallow includes '/api/' and '/admin/'
 *   - rules.disallow does NOT include '/_next/' (D-20 critical — Googlebot must
 *     access /_next/static/* to render JS/CSS or SEO tanks)
 *   - rules.disallow does NOT include '/' (would block whole site)
 *   - sitemap field is `${NEXT_PUBLIC_SITE_URL}/sitemap.xml`
 *
 * Mocks: none needed (robots.ts is static, no DB).
 */
import { describe, it, expect, beforeEach } from "vitest";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://scholars.weill.cornell.edu";
});

import robots from "@/app/robots";

describe("app/robots — basic shape", () => {
  it("returns an object with rules and sitemap fields", () => {
    const out = robots();
    expect(out).toHaveProperty("rules");
    expect(out).toHaveProperty("sitemap");
  });

  it("rules targets userAgent *", () => {
    const { rules } = robots();
    const r = Array.isArray(rules) ? rules[0] : rules;
    expect(r.userAgent).toBe("*");
  });

  it("rules.allow includes / so the site is crawlable", () => {
    const { rules } = robots();
    const r = Array.isArray(rules) ? rules[0] : rules;
    const allow = r.allow;
    if (Array.isArray(allow)) {
      expect(allow).toContain("/");
    } else {
      expect(allow).toBe("/");
    }
  });
});

describe("app/robots — disallow list", () => {
  it("disallows /api/ (server routes must not be indexed)", () => {
    const { rules } = robots();
    const r = Array.isArray(rules) ? rules[0] : rules;
    const disallow = Array.isArray(r.disallow) ? r.disallow : [r.disallow];
    expect(disallow).toContain("/api/");
  });

  it("disallows /admin/ (admin paths must not be indexed)", () => {
    const { rules } = robots();
    const r = Array.isArray(rules) ? rules[0] : rules;
    const disallow = Array.isArray(r.disallow) ? r.disallow : [r.disallow];
    expect(disallow).toContain("/admin/");
  });

  it("CRITICAL D-20: does NOT disallow /_next/ (Googlebot needs JS/CSS access)", () => {
    const { rules } = robots();
    const r = Array.isArray(rules) ? rules[0] : rules;
    const disallow = Array.isArray(r.disallow) ? r.disallow : [r.disallow];
    expect(disallow).not.toContain("/_next/");
    // Also check no substring match
    expect(disallow.some((d) => d && d.includes("_next"))).toBe(false);
  });

  it("does NOT disallow / (would block entire site from indexing)", () => {
    const { rules } = robots();
    const r = Array.isArray(rules) ? rules[0] : rules;
    const disallow = Array.isArray(r.disallow) ? r.disallow : [r.disallow];
    expect(disallow).not.toContain("/");
  });
});

describe("app/robots — sitemap directive", () => {
  it("sitemap points to NEXT_PUBLIC_SITE_URL/sitemap.xml", () => {
    const out = robots();
    expect(out.sitemap).toBe("https://scholars.weill.cornell.edu/sitemap.xml");
  });

  it("uses NEXT_PUBLIC_SITE_URL env var for sitemap URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://staging.example.com";
    const out = robots();
    expect(out.sitemap).toBe("https://staging.example.com/sitemap.xml");
  });

  it("falls back to default domain when NEXT_PUBLIC_SITE_URL is unset", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const out = robots();
    const sitemap = Array.isArray(out.sitemap) ? out.sitemap[0] : out.sitemap;
    expect(sitemap).toMatch(/https:\/\/scholars\.weill\.cornell\.edu\/sitemap\.xml/);
  });
});
