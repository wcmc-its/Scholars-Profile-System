/**
 * `lib/headshot-presence.ts` — the directory headshot probe behind etl:headshot
 * (Data Quality dashboard, docs/data-quality-dashboard-spec.md).
 */
import { describe, expect, it, vi } from "vitest";

import {
  HEADSHOT_STALE_DAYS,
  classifyHeadshotStatus,
  headshotStaleBefore,
  probeHeadshot,
} from "@/lib/headshot-presence";

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

/**
 * #2210 — the incremental staleness threshold. The weekly cadence
 * (`cron(0 12 ? * SUN *)`, cdk/lib/etl-stack.ts) is the contract this constant
 * has to satisfy; nothing else in the repo enforces the relationship, and the
 * failure mode is silent (rows simply stop being selected, and the run still
 * exits 0 reporting success on a near-empty scan).
 */
const WEEKLY_CADENCE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

describe("headshot staleness threshold", () => {
  it("is NOT an exact multiple of the weekly cadence — the silent-skip trap", () => {
    // A cutoff of exactly 7 or 14 days lands a few minutes BEFORE the stamp left
    // by the run that should refresh it, so every row reads fresh, the cohort is
    // skipped, and the job still exits 0 on a near-empty scan.
    expect(HEADSHOT_STALE_DAYS % WEEKLY_CADENCE_DAYS).not.toBe(0);
  });

  it("bounds staleness at a fortnight — a row comes due within two weekly runs", () => {
    // The #2210 defect was a 30-day threshold on a weekly cron = 30-37 days stale.
    expect(HEADSHOT_STALE_DAYS).toBeLessThan(2 * WEEKLY_CADENCE_DAYS);
  });

  it("computes the cutoff as now minus the threshold", () => {
    const now = new Date("2026-08-16T12:00:00.000Z");
    expect(headshotStaleBefore(now).toISOString()).toBe(
      new Date(now.getTime() - HEADSHOT_STALE_DAYS * DAY_MS).toISOString(),
    );
  });

  it("re-selects a row two weekly runs later, absorbing the in-run drift", () => {
    // Run N starts at 12:00 UTC and stamps `headshot_checked_at` a few minutes
    // later, once its probe of that cwid returns. At a fortnightly threshold the
    // row must be SKIPPED at run N+1 and DUE at run N+2 — and the drift must not
    // push it to N+3, which is what an exact 14 would do.
    const runNStart = new Date("2026-08-09T12:00:00.000Z");
    const checkedAt = new Date(runNStart.getTime() + 3 * 60 * 1000 + 21 * 1000);
    const runAt = (n: number) =>
      new Date(runNStart.getTime() + n * WEEKLY_CADENCE_DAYS * DAY_MS);

    expect(checkedAt.getTime()).toBeGreaterThan(headshotStaleBefore(runAt(1)).getTime());
    expect(checkedAt.getTime()).toBeLessThan(headshotStaleBefore(runAt(2)).getTime());
  });

  it("does NOT re-select a row checked earlier in the same run", () => {
    const now = new Date("2026-08-09T12:04:00.000Z");
    const checkedAt = new Date("2026-08-09T12:00:30.000Z");
    expect(checkedAt.getTime()).toBeGreaterThan(headshotStaleBefore(now).getTime());
  });
});
