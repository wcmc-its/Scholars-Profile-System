/**
 * Issue #479 — origin allowlist for the cadence revalidate sweep. The bearer
 * token leaves the task only when the resolved `SCHOLARS_BASE_URL` matches one
 * of these explicit origin patterns; any drift (a wildcard AWS host, the wrong
 * scheme, an attacker-controlled hostname) must be refused.
 *
 * #1478 — the internal ALB is allowed only by exact origin equality with
 * SCHOLARS_INTERNAL_ALB_ORIGIN. Hostnames below are deliberately fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAllowedBaseUrl } from "@/etl/revalidate";

describe("isAllowedBaseUrl (#479)", () => {
  it("allows the local dev origin", () => {
    expect(isAllowedBaseUrl("http://localhost:3000")).toBe(true);
  });

  it("allows the public Scholars origin", () => {
    expect(isAllowedBaseUrl("https://scholars.weill.cornell.edu")).toBe(true);
  });

  it("rejects a malformed URL", () => {
    expect(isAllowedBaseUrl("not-a-url")).toBe(false);
    expect(isAllowedBaseUrl("")).toBe(false);
  });

  it("rejects a Scholars-lookalike host", () => {
    expect(isAllowedBaseUrl("https://scholars.weill.cornell.edu.attacker.example")).toBe(false);
  });

  it("rejects an explicit non-3000 localhost port", () => {
    // The dev origin is pinned to :3000 to match the existing `SCHOLARS_BASE_URL`
    // default. A drift (e.g. :3001 from a port conflict) should fail loudly.
    expect(isAllowedBaseUrl("http://localhost:3001")).toBe(false);
  });
});

describe("isAllowedBaseUrl internal ALB exact origin (#1478)", () => {
  // Fake, construct-shaped hostnames; not real load balancers.
  const ALB = "internal-Sps-Ap-Inter-FAKEaaaa1111-1000000001.us-east-1.elb.amazonaws.com";
  const OTHER_HASH = "internal-Sps-Ap-Inter-FAKEbbbb2222-1000000002.us-east-1.elb.amazonaws.com";

  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("SCHOLARS_INTERNAL_ALB_ORIGIN set", () => {
    beforeEach(() => {
      vi.stubEnv("SCHOLARS_INTERNAL_ALB_ORIGIN", `http://${ALB}`);
    });

    it.each([
      [`http://${ALB}`, true, "exact origin"],
      [`http://${ALB.toLowerCase()}`, true, "case-insensitive host"],
      [`http://${ALB}:80`, true, "explicit default port"],
      [`http://${ALB}/some/path`, true, "path is ignored (origin compare)"],
      [`http://${OTHER_HASH}`, false, "same construct prefix, different hash"],
      [`https://${ALB}`, false, "https (internal listener is HTTP)"],
      [`http://${ALB}:8080`, false, "different port"],
      [`http://${ALB}.attacker.example`, false, "suffix smuggling"],
      [`http://attacker.example/${ALB}`, false, "host in path"],
      ["http://some-other-1234567890.us-east-1.elb.amazonaws.com", false, "arbitrary ELB"],
      ["http://localhost:3000", true, "fixed localhost still allowed"],
      ["https://scholars.weill.cornell.edu", true, "fixed public origin still allowed"],
    ])("%s -> %s (%s)", (url, expected) => {
      expect(isAllowedBaseUrl(url)).toBe(expected);
    });

    it("tolerates a trailing slash / mixed case in the env value", () => {
      vi.stubEnv("SCHOLARS_INTERNAL_ALB_ORIGIN", `HTTP://${ALB.toUpperCase()}/`);
      expect(isAllowedBaseUrl(`http://${ALB}`)).toBe(true);
    });

    it("an unparseable env value allows no internal ALB", () => {
      vi.stubEnv("SCHOLARS_INTERNAL_ALB_ORIGIN", "not a url");
      expect(isAllowedBaseUrl(`http://${ALB}`)).toBe(false);
      expect(isAllowedBaseUrl("http://localhost:3000")).toBe(true);
    });
  });

  describe("SCHOLARS_INTERNAL_ALB_ORIGIN unset (transitional #1473 fallback)", () => {
    beforeEach(() => {
      vi.stubEnv("SCHOLARS_INTERNAL_ALB_ORIGIN", "");
    });

    it.each([
      [`http://${ALB}`, true, "construct-prefixed auto-named ALB"],
      [`http://${OTHER_HASH}`, true, "any hash under our construct prefix"],
      [`https://${ALB}`, false, "https"],
      [`http://${ALB}.attacker.example`, false, "suffix smuggling"],
      ["http://internal-Some-Other-Alb-abcdef-123.us-east-1.elb.amazonaws.com", false, "other construct prefix"],
      ["http://sps-internal-prod-1.us-east-1.elb.amazonaws.com", false, "dead sps-internal name"],
    ])("%s -> %s (%s)", (url, expected) => {
      expect(isAllowedBaseUrl(url)).toBe(expected);
    });
  });
});
