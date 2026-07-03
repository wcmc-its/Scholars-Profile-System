/**
 * Issue #479 — origin allowlist for the cadence revalidate sweep. The bearer
 * token leaves the task only when the resolved `SCHOLARS_BASE_URL` matches one
 * of these explicit origin patterns; any drift (a wildcard AWS host, the wrong
 * scheme, an attacker-controlled hostname) must be refused.
 */
import { describe, expect, it } from "vitest";

import { isAllowedBaseUrl } from "@/etl/revalidate";

describe("isAllowedBaseUrl (#479)", () => {
  it("allows the local dev origin", () => {
    expect(isAllowedBaseUrl("http://localhost:3000")).toBe(true);
  });

  it("allows the public Scholars origin", () => {
    expect(isAllowedBaseUrl("https://scholars.weill.cornell.edu")).toBe(true);
  });

  it("allows the staging internal ALB DNS", () => {
    expect(
      isAllowedBaseUrl("http://sps-internal-staging-1234567890.us-east-1.elb.amazonaws.com"),
    ).toBe(true);
  });

  it("allows the prod internal ALB DNS", () => {
    expect(
      isAllowedBaseUrl("http://sps-internal-prod-987654321.us-east-1.elb.amazonaws.com"),
    ).toBe(true);
  });

  it("allows the CDK-auto-named internal ALB (post-VPC-consolidation)", () => {
    // The app stack's internal ALB is auto-named from its construct path
    // (`internal-Sps-Ap-Inter-<hash>-<num>`) rather than the older custom
    // `sps-internal-{env}` name; both env stacks share the construct prefix.
    expect(
      isAllowedBaseUrl(
        "http://internal-Sps-Ap-Inter-wkUfLYl8kUqw-211765873.us-east-1.elb.amazonaws.com",
      ),
    ).toBe(true);
  });

  it("rejects an internal ALB from a different construct prefix", () => {
    // The auto-name pattern is still pinned to OUR construct prefix — a
    // different app's `internal-*` ALB must not be accepted.
    expect(
      isAllowedBaseUrl("http://internal-Some-Other-Alb-abcdef-123.us-east-1.elb.amazonaws.com"),
    ).toBe(false);
  });

  it("rejects an arbitrary AWS ALB (different naming convention)", () => {
    // Defense in depth — any tenant could spin up an ALB ending in
    // `.elb.amazonaws.com`; pin to OUR convention.
    expect(
      isAllowedBaseUrl("http://some-other-1234567890.us-east-1.elb.amazonaws.com"),
    ).toBe(false);
  });

  it("rejects a hijacked internal ALB DNS via path-suffix smuggling", () => {
    // `startsWith` checks (the pre-#479 shape) would have been fooled by a
    // path-suffixed attacker URL. Pinning to URL.origin defeats that.
    expect(
      isAllowedBaseUrl(
        "http://sps-internal-prod-1.us-east-1.elb.amazonaws.com.attacker.example",
      ),
    ).toBe(false);
  });

  it("rejects HTTPS on the internal ALB (the internal listener is HTTP)", () => {
    expect(
      isAllowedBaseUrl("https://sps-internal-prod-1.us-east-1.elb.amazonaws.com"),
    ).toBe(false);
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
