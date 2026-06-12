/**
 * Unit tests for the D3 SLI request-scoped OpenSearch round-trip counter
 * (lib/api/os-round-trips.ts).
 *
 * Pure — no OpenSearch client needed. Verifies:
 *   - recording outside any scope is a no-op (count reads 0)
 *   - N records inside a scope sum to N, including across an await boundary
 *   - two concurrent scopes (Promise.all) keep isolated counts
 */
import { describe, expect, it } from "vitest";
import {
  runWithOsRoundTripCounter,
  recordOsRoundTrip,
  getOsRoundTripCount,
} from "@/lib/api/os-round-trips";

describe("os-round-trips counter", () => {
  it("is a no-op outside any scope (count reads 0)", () => {
    // No active store: recording must not throw and count stays 0.
    recordOsRoundTrip();
    recordOsRoundTrip();
    expect(getOsRoundTripCount()).toBe(0);
  });

  it("sums N records inside a scope, across an await boundary", async () => {
    const count = await runWithOsRoundTripCounter(async () => {
      recordOsRoundTrip();
      recordOsRoundTrip();
      // Yield to the event loop — the AsyncLocalStorage store must survive the
      // await so post-await records land in the same counter.
      await Promise.resolve();
      recordOsRoundTrip();
      return getOsRoundTripCount();
    });
    expect(count).toBe(3);
  });

  it("keeps two concurrent scopes isolated", async () => {
    const scopeA = runWithOsRoundTripCounter(async () => {
      recordOsRoundTrip();
      await Promise.resolve();
      recordOsRoundTrip();
      await Promise.resolve();
      recordOsRoundTrip();
      return getOsRoundTripCount();
    });

    const scopeB = runWithOsRoundTripCounter(async () => {
      await Promise.resolve();
      recordOsRoundTrip();
      return getOsRoundTripCount();
    });

    const [a, b] = await Promise.all([scopeA, scopeB]);
    expect(a).toBe(3);
    expect(b).toBe(1);
  });

  it("returns 0 again after a scope completes", async () => {
    await runWithOsRoundTripCounter(async () => {
      recordOsRoundTrip();
    });
    expect(getOsRoundTripCount()).toBe(0);
  });
});
