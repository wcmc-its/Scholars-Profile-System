/**
 * `validateSameOriginUrl` + `getAllowedOrigins` (#538 PR-1) — the v1
 * trust floor for the submission server action's `pageUrl`.
 */
import { describe, expect, it } from "vitest";

import {
  getAllowedOrigins,
  validateSameOriginUrl,
} from "@/lib/feedback/same-origin";

describe("getAllowedOrigins", () => {
  it("reads FEEDBACK_SITE_ORIGIN with single value", () => {
    expect(getAllowedOrigins({ FEEDBACK_SITE_ORIGIN: "https://scholars.weill.cornell.edu" })).toEqual([
      "https://scholars.weill.cornell.edu",
    ]);
  });

  it("supports comma-separated origins for alias / staging", () => {
    expect(
      getAllowedOrigins({
        FEEDBACK_SITE_ORIGIN: "https://scholars.weill.cornell.edu, https://staging.scholars.weill.cornell.edu",
      }),
    ).toEqual([
      "https://scholars.weill.cornell.edu",
      "https://staging.scholars.weill.cornell.edu",
    ]);
  });

  it("falls back to NEXT_PUBLIC_SITE_URL when FEEDBACK_SITE_ORIGIN is absent", () => {
    expect(getAllowedOrigins({ NEXT_PUBLIC_SITE_URL: "http://localhost:3002" })).toEqual([
      "http://localhost:3002",
    ]);
  });

  it("FEEDBACK_SITE_ORIGIN wins over NEXT_PUBLIC_SITE_URL when both set", () => {
    expect(
      getAllowedOrigins({
        FEEDBACK_SITE_ORIGIN: "https://scholars.weill.cornell.edu",
        NEXT_PUBLIC_SITE_URL: "http://localhost:3002",
      }),
    ).toEqual(["https://scholars.weill.cornell.edu"]);
  });

  it("returns an empty list when neither env var is set", () => {
    expect(getAllowedOrigins({})).toEqual([]);
  });

  it("silently drops malformed entries", () => {
    expect(
      getAllowedOrigins({ FEEDBACK_SITE_ORIGIN: "https://good.example.com, not-a-url, https://also-good.example.com" }),
    ).toEqual(["https://good.example.com", "https://also-good.example.com"]);
  });

  it("strips path / query / port info to bare protocol+host", () => {
    expect(getAllowedOrigins({ FEEDBACK_SITE_ORIGIN: "https://x.example.com:8443/some/path?q=1" })).toEqual([
      "https://x.example.com:8443",
    ]);
  });

  it("deduplicates redundant entries", () => {
    expect(
      getAllowedOrigins({ FEEDBACK_SITE_ORIGIN: "https://x.example.com, https://x.example.com/" }),
    ).toEqual(["https://x.example.com"]);
  });

  it("rejects non-http schemes", () => {
    expect(getAllowedOrigins({ FEEDBACK_SITE_ORIGIN: "javascript:alert(1)" })).toEqual([]);
  });
});

describe("validateSameOriginUrl", () => {
  const ENV: Record<string, string> = { FEEDBACK_SITE_ORIGIN: "https://scholars.weill.cornell.edu" };

  it("accepts a same-origin URL and returns it canonicalized", () => {
    expect(validateSameOriginUrl("https://scholars.weill.cornell.edu/scholars/jane-smith", ENV)).toEqual(
      "https://scholars.weill.cornell.edu/scholars/jane-smith",
    );
  });

  it("preserves the query string (analytical signal)", () => {
    expect(validateSameOriginUrl("https://scholars.weill.cornell.edu/search?q=onco", ENV)).toEqual(
      "https://scholars.weill.cornell.edu/search?q=onco",
    );
  });

  it("strips the fragment (no analytic value, client-side only)", () => {
    expect(validateSameOriginUrl("https://scholars.weill.cornell.edu/scholars/jane#bio", ENV)).toEqual(
      "https://scholars.weill.cornell.edu/scholars/jane",
    );
  });

  it("strips embedded credentials", () => {
    expect(
      validateSameOriginUrl("https://user:pass@scholars.weill.cornell.edu/scholars/jane", ENV),
    ).toEqual("https://scholars.weill.cornell.edu/scholars/jane");
  });

  it("rejects a cross-origin URL", () => {
    expect(validateSameOriginUrl("https://evil.example.com/", ENV)).toBeNull();
  });

  it("rejects a subdomain that isn't in the allowlist", () => {
    expect(validateSameOriginUrl("https://www.scholars.weill.cornell.edu/", ENV)).toBeNull();
  });

  it("rejects http when only https is allowed", () => {
    expect(validateSameOriginUrl("http://scholars.weill.cornell.edu/", ENV)).toBeNull();
  });

  it("rejects javascript: scheme", () => {
    expect(validateSameOriginUrl("javascript:alert(1)", ENV)).toBeNull();
  });

  it("rejects a malformed URL", () => {
    expect(validateSameOriginUrl("not a url", ENV)).toBeNull();
  });

  it("rejects empty / null / undefined input", () => {
    expect(validateSameOriginUrl("", ENV)).toBeNull();
    expect(validateSameOriginUrl(null, ENV)).toBeNull();
    expect(validateSameOriginUrl(undefined, ENV)).toBeNull();
    expect(validateSameOriginUrl("   ", ENV)).toBeNull();
  });

  it("refuses everything when no env is configured (closed by default)", () => {
    expect(validateSameOriginUrl("https://scholars.weill.cornell.edu/", {})).toBeNull();
  });

  it("accepts both origins when alias is configured", () => {
    const env = { FEEDBACK_SITE_ORIGIN: "https://a.example.com, https://b.example.com" };
    expect(validateSameOriginUrl("https://a.example.com/x", env)).toEqual("https://a.example.com/x");
    expect(validateSameOriginUrl("https://b.example.com/x", env)).toEqual("https://b.example.com/x");
  });
});
