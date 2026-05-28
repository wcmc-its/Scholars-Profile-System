import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  resolveCspMode,
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
  const valueOfHeaders = (
    headers: ReturnType<typeof buildSecurityHeaders>,
    key: string,
  ): string | undefined => headers.find((header) => header.key === key)?.value;

  describe("default mode (report-only)", () => {
    const headers = buildSecurityHeaders({ isProduction: true });
    const valueOf = (key: string): string | undefined =>
      valueOfHeaders(headers, key);

    it("emits the four headers named by issue #120, plus Permissions-Policy", () => {
      expect(valueOf("Strict-Transport-Security")).toBe(
        "max-age=31536000; includeSubDomains; preload",
      );
      expect(valueOf("X-Frame-Options")).toBe("DENY");
      expect(valueOf("X-Content-Type-Options")).toBe("nosniff");
      expect(valueOf("Referrer-Policy")).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(valueOf("Permissions-Policy")).toContain("camera=()");
    });

    it("ships CSP as report-only when no cspMode is supplied", () => {
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

  describe("cspMode: report-only (explicit)", () => {
    const headers = buildSecurityHeaders({
      isProduction: true,
      cspMode: "report-only",
    });
    const valueOf = (key: string): string | undefined =>
      valueOfHeaders(headers, key);

    it("emits the report-only header and not the enforcing header", () => {
      expect(valueOf("Content-Security-Policy-Report-Only")).toBeDefined();
      expect(valueOf("Content-Security-Policy")).toBeUndefined();
    });
  });

  describe("cspMode: enforce", () => {
    const enforced = buildSecurityHeaders({
      isProduction: true,
      cspMode: "enforce",
    });
    const reportOnly = buildSecurityHeaders({
      isProduction: true,
      cspMode: "report-only",
    });
    const valueOf = (key: string): string | undefined =>
      valueOfHeaders(enforced, key);

    it("emits the enforcing Content-Security-Policy header and drops report-only", () => {
      expect(valueOf("Content-Security-Policy")).toBeDefined();
      expect(valueOf("Content-Security-Policy-Report-Only")).toBeUndefined();
    });

    it("ships the same policy value as report-only (header-name swap only)", () => {
      // docs/ADR-007: promotion is a header rename; the policy content is
      // identical so the flip is reversible by flipping the flag back.
      expect(valueOf("Content-Security-Policy")).toBe(
        valueOfHeaders(reportOnly, "Content-Security-Policy-Report-Only"),
      );
    });

    it("still emits the four #120 static headers and the collector hookup", () => {
      expect(valueOf("Strict-Transport-Security")).toBe(
        "max-age=31536000; includeSubDomains; preload",
      );
      expect(valueOf("X-Frame-Options")).toBe("DENY");
      expect(valueOf("Reporting-Endpoints")).toBe(
        'csp-endpoint="/api/csp-report"',
      );
    });
  });
});

describe("resolveCspMode", () => {
  it("returns report-only for unset / empty / unknown values (fail-safe default)", () => {
    expect(resolveCspMode(undefined)).toBe("report-only");
    expect(resolveCspMode("")).toBe("report-only");
    expect(resolveCspMode("on")).toBe("report-only");
    expect(resolveCspMode("true")).toBe("report-only");
    expect(resolveCspMode("report-only")).toBe("report-only");
  });

  it("returns enforce only for the literal opt-in (case- and whitespace-tolerant)", () => {
    expect(resolveCspMode("enforce")).toBe("enforce");
    expect(resolveCspMode("ENFORCE")).toBe("enforce");
    expect(resolveCspMode("  enforce  ")).toBe("enforce");
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
