/**
 * `lib/headshot-presence.ts` — the directory headshot probe behind etl:headshot
 * (Data Quality dashboard, docs/data-quality-dashboard-spec.md).
 */
import { describe, expect, it, vi } from "vitest";

import { classifyHeadshotStatus, probeHeadshot } from "@/lib/headshot-presence";

describe("classifyHeadshotStatus", () => {
  it("200/206 → present", () => {
    expect(classifyHeadshotStatus(200)).toBe(true);
    expect(classifyHeadshotStatus(206)).toBe(true);
  });
  it("404 → absent", () => {
    expect(classifyHeadshotStatus(404)).toBe(false);
  });
  it("5xx / 403 / redirect / 0 → indeterminate (null)", () => {
    for (const s of [500, 503, 403, 302, 0]) {
      expect(classifyHeadshotStatus(s)).toBeNull();
    }
  });
});

const fakeFetch = (status: number) =>
  vi.fn().mockResolvedValue({ status }) as unknown as typeof fetch;

describe("probeHeadshot", () => {
  it("returns true on 200", async () => {
    expect(await probeHeadshot("abc1001", { fetchImpl: fakeFetch(200) })).toBe(true);
  });
  it("returns false on 404", async () => {
    expect(await probeHeadshot("abc1001", { fetchImpl: fakeFetch(404) })).toBe(false);
  });
  it("returns null on a server error (does NOT flip a known value)", async () => {
    expect(await probeHeadshot("abc1001", { fetchImpl: fakeFetch(500) })).toBeNull();
  });
  it("returns null on a network error / timeout", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    expect(await probeHeadshot("abc1001", { fetchImpl })).toBeNull();
  });
});
