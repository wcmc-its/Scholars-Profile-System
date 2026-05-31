/**
 * #626 — bulk-write throttle policy for the OpenSearch index rebuilds.
 * Tests the pure helpers (retryable-status classification + env-config
 * resolution); the retry/pacing loop itself lives in `etl/search-index/index.ts`
 * (importing that runs `main()`, so it isn't imported here).
 */
import { describe, it, expect } from "vitest";
import {
  isRetryableBulkStatus,
  resolveBulkConfig,
  BULK_DEFAULTS,
} from "@/lib/search-index-bulk";

describe("isRetryableBulkStatus (#626)", () => {
  it("retries throttle + gateway/unavailable family", () => {
    for (const s of [429, 502, 503, 504]) {
      expect(isRetryableBulkStatus(s)).toBe(true);
    }
  });

  it("does not retry success or hard client/server errors", () => {
    for (const s of [200, 201, 400, 401, 403, 404, 409, 413, 500]) {
      expect(isRetryableBulkStatus(s)).toBe(false);
    }
  });

  it("does not retry an absent status", () => {
    expect(isRetryableBulkStatus(undefined)).toBe(false);
    expect(isRetryableBulkStatus(null)).toBe(false);
  });
});

describe("resolveBulkConfig (#626)", () => {
  it("returns the gentle defaults on an empty env", () => {
    expect(resolveBulkConfig({})).toEqual(BULK_DEFAULTS);
  });

  it("is gentler than the pre-#626 settings (smaller chunks, paced, more retries)", () => {
    expect(BULK_DEFAULTS.maxDocs).toBeLessThan(500);
    expect(BULK_DEFAULTS.pauseMs).toBeGreaterThan(0);
    expect(BULK_DEFAULTS.maxAttempts).toBeGreaterThan(6);
  });

  it("honors env overrides", () => {
    const cfg = resolveBulkConfig({
      SEARCH_INDEX_BULK_MAX_BYTES: "4194304",
      SEARCH_INDEX_BULK_MAX_DOCS: "50",
      SEARCH_INDEX_BULK_PAUSE_MS: "500",
      SEARCH_INDEX_BULK_MAX_ATTEMPTS: "12",
    });
    expect(cfg).toEqual({ maxBytes: 4194304, maxDocs: 50, pauseMs: 500, maxAttempts: 12 });
  });

  it("allows pauseMs=0 to disable pacing (e.g. a well-sized prod domain)", () => {
    expect(resolveBulkConfig({ SEARCH_INDEX_BULK_PAUSE_MS: "0" }).pauseMs).toBe(0);
  });

  it("falls back to defaults on invalid / non-positive values", () => {
    const cfg = resolveBulkConfig({
      SEARCH_INDEX_BULK_MAX_DOCS: "abc",
      SEARCH_INDEX_BULK_MAX_BYTES: "-5",
      SEARCH_INDEX_BULK_MAX_ATTEMPTS: "0", // attempts must be positive
    });
    expect(cfg.maxDocs).toBe(BULK_DEFAULTS.maxDocs);
    expect(cfg.maxBytes).toBe(BULK_DEFAULTS.maxBytes);
    expect(cfg.maxAttempts).toBe(BULK_DEFAULTS.maxAttempts);
  });

  it("floors fractional values", () => {
    expect(resolveBulkConfig({ SEARCH_INDEX_BULK_MAX_DOCS: "150.9" }).maxDocs).toBe(150);
  });
});
