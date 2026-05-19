import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
} from "@/lib/security-headers";

/** Split a CSP value into a `directive → sources` map for assertions. */
function parseCsp(csp: string): Record<string, string> {
  const entries = csp
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part): [string, string] => {
      const spaceAt = part.indexOf(" ");
      if (spaceAt === -1) return [part, ""];
      return [part.slice(0, spaceAt), part.slice(spaceAt + 1).trim()];
    });
  return Object.fromEntries(entries);
}

describe("buildSecurityHeaders", () => {
  const headers = buildSecurityHeaders({ isProduction: true });
  const valueOf = (key: string): string | undefined =>
    headers.find((header) => header.key === key)?.value;

  it("emits the four headers named by issue #120, plus Permissions-Policy", () => {
    expect(valueOf("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains; preload",
    );
    expect(valueOf("X-Frame-Options")).toBe("DENY");
    expect(valueOf("X-Content-Type-Options")).toBe("nosniff");
    expect(valueOf("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(valueOf("Permissions-Policy")).toContain("camera=()");
  });

  it("ships CSP as report-only, never as the enforcing header", () => {
    expect(valueOf("Content-Security-Policy-Report-Only")).toBeDefined();
    expect(valueOf("Content-Security-Policy")).toBeUndefined();
  });

  it("names the csp-report collector via the Reporting-Endpoints header", () => {
    expect(valueOf("Reporting-Endpoints")).toBe(
      'csp-endpoint="/api/csp-report"',
    );
  });

  it("has no duplicate header keys", () => {
    const keys = headers.map((header) => header.key);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("restricts the production policy to first-party origins by default", () => {
    const csp = parseCsp(buildContentSecurityPolicy({ isProduction: true }));
    expect(csp["default-src"]).toBe("'self'");
    expect(csp["base-uri"]).toBe("'self'");
    expect(csp["form-action"]).toBe("'self'");
    expect(csp["object-src"]).toBe("'none'");
    expect(csp["frame-ancestors"]).toBe("'none'");
    expect(csp["frame-src"]).toBe("'none'");
  });

  it("allows the headshot image origin declared in next.config images", () => {
    const csp = parseCsp(buildContentSecurityPolicy({ isProduction: true }));
    expect(csp["img-src"]).toContain("'self'");
    expect(csp["img-src"]).toContain("https://directory.weill.cornell.edu");
  });

  it("keeps the production policy free of dev-only relaxations", () => {
    const csp = parseCsp(buildContentSecurityPolicy({ isProduction: true }));
    expect(csp["script-src"]).not.toContain("'unsafe-eval'");
    expect(csp["connect-src"]).toBe("'self'");
  });

  it("grants the dev server unsafe-eval and websocket origins for HMR", () => {
    const csp = parseCsp(buildContentSecurityPolicy({ isProduction: false }));
    expect(csp["script-src"]).toContain("'unsafe-eval'");
    expect(csp["connect-src"]).toContain("ws:");
    expect(csp["connect-src"]).toContain("wss:");
  });

  it("routes violation reports to the in-app /api/csp-report collector", () => {
    const prod = parseCsp(buildContentSecurityPolicy({ isProduction: true }));
    const dev = parseCsp(buildContentSecurityPolicy({ isProduction: false }));
    expect(prod["report-uri"]).toBe("/api/csp-report");
    expect(dev["report-uri"]).toBe("/api/csp-report");
    expect(prod["report-to"]).toBe("csp-endpoint");
    expect(dev["report-to"]).toBe("csp-endpoint");
  });

  it("blocks inline event-handler attributes with script-src-attr 'none'", () => {
    const prod = parseCsp(buildContentSecurityPolicy({ isProduction: true }));
    const dev = parseCsp(buildContentSecurityPolicy({ isProduction: false }));
    expect(prod["script-src-attr"]).toBe("'none'");
    expect(dev["script-src-attr"]).toBe("'none'");
  });
});
