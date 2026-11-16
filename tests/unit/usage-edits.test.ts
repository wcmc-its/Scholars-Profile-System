/**
 * Profile edits by hour for `/edit/usage`'s "Traffic by hour" card: the pure
 * shaper (UTC hour rows -> Eastern, DST included), the hour-of-day fold, and
 * the audit-log loader (bound range, automated edits excluded, per-range cache,
 * failures never cached).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cacheKeys: [] as string[][],
}));

// Pass-through cache that records each entry's key parts (a throw propagates,
// as unstable_cache never stores a rejected call).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[]) => () => {
    h.cacheKeys.push(keyParts);
    return fn();
  },
}));

import { BULK_REQUEST_PREFIX, isSystemActor } from "@/lib/api/edit-activity";
import { loadEditsByHour, loadEditsByHourUncached } from "@/lib/api/usage-edits";
import {
  type HourBucket,
  easternHour,
  editsHourOfDayAverages,
  shapeEditsByHour,
} from "@/lib/api/usage-hourly";

const H = 3_600_000;

describe("shapeEditsByHour", () => {
  it("maps UTC hours to Eastern, sorted, summing duplicates and skipping bad rows", () => {
    const out = shapeEditsByHour([
      { hour: "2026-11-17 16", edits: 2n },
      { hour: "2026-11-17 15", edits: "3" },
      { hour: "2026-11-17 15", edits: 1 },
      { hour: "2026-11-17", edits: 9 },
      { hour: "garbage", edits: 9 },
      { hour: "2026-11-17 17", edits: "x" },
    ]);
    expect(out).toEqual([
      { at: Date.parse("2026-11-17T15:00:00Z"), day: "2026-11-17", hour: 10, edits: 4 },
      { at: Date.parse("2026-11-17T16:00:00Z"), day: "2026-11-17", hour: 11, edits: 2 },
    ]);
  });

  it("keeps the two 1 AM hours of the fall-back day apart", () => {
    // 2026-11-01: 05Z = 1 AM EDT, 06Z = 1 AM EST.
    const out = shapeEditsByHour([
      { hour: "2026-11-01 05", edits: 1 },
      { hour: "2026-11-01 06", edits: 2 },
    ]);
    expect(out.map((e) => [e.day, e.hour, e.edits])).toEqual([
      ["2026-11-01", 1, 1],
      ["2026-11-01", 1, 2],
    ]);
    expect(out[1].at - out[0].at).toBe(H);
  });

  it("skips the missing 2 AM of the spring-forward day", () => {
    // 2026-03-08: 06Z = 1 AM EST, 07Z = 3 AM EDT.
    const out = shapeEditsByHour([
      { hour: "2026-03-08 06", edits: 1 },
      { hour: "2026-03-08 07", edits: 1 },
    ]);
    expect(out.map((e) => e.hour)).toEqual([1, 3]);
  });

  it("puts a late-evening UTC hour on the previous Eastern day", () => {
    expect(shapeEditsByHour([{ hour: "2026-11-17 03", edits: 1 }])[0]).toMatchObject({
      day: "2026-11-16",
      hour: 22,
    });
  });
});

describe("editsHourOfDayAverages", () => {
  const day = (dt: string): HourBucket[] =>
    Array.from({ length: 24 }, (_, i) => {
      const at = Date.parse(`${dt}T00:00:00Z`) + i * H;
      return { at, ...easternHour(at), human: 0, bot: 0, error: 0 };
    });

  it("averages over the traffic's covered days and leaves out uncovered hours", () => {
    const traffic = {
      buckets: [...day("2026-11-16"), ...day("2026-11-17")],
      firstDay: "2026-11-16",
      days: 2,
    };
    const edits = shapeEditsByHour([
      { hour: "2026-11-16 15", edits: 2 },
      { hour: "2026-11-17 15", edits: 4 },
      // A day the rollup never covered: not part of the average.
      { hour: "2026-11-20 15", edits: 100 },
    ]);
    const out = editsHourOfDayAverages(edits, traffic);
    expect(out).toHaveLength(24);
    expect(out[10]).toBe(3);
    expect(out.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("is all zeros with no covered days", () => {
    expect(editsHourOfDayAverages([], { buckets: [], firstDay: null, days: 0 })).toEqual(
      Array(24).fill(0),
    );
  });
});

describe("loadEditsByHour", () => {
  const queryRaw = vi.fn();
  const client = { $queryRaw: queryRaw } as unknown as Parameters<typeof loadEditsByHour>[0];

  beforeEach(() => {
    h.cacheKeys.length = 0;
    queryRaw.mockReset();
  });

  it("binds the inclusive UTC-day range and shapes the rows", async () => {
    queryRaw.mockResolvedValue([{ hour: "2026-11-17 15", edits: 3n }]);
    const out = await loadEditsByHour(client, { since: "2026-11-10", until: "2026-11-17" });
    expect(out).toEqual([
      { at: Date.parse("2026-11-17T15:00:00Z"), day: "2026-11-17", hour: 10, edits: 3 },
    ]);
    const [strings, ...values] = queryRaw.mock.calls[0];
    const sql = (strings as string[]).join("?");
    expect(sql).toContain("FROM scholars_audit.manual_edit_audit");
    expect(sql).toContain("DATE_FORMAT(ts, '%Y-%m-%d %H')");
    expect(values).toEqual([new Date("2026-11-10T00:00:00Z"), new Date("2026-11-18T00:00:00Z")]);
    expect(h.cacheKeys).toEqual([["usage-edits-by-hour", "v1", "2026-11-10", "2026-11-17"]]);
  });

  it("leaves out automated edits by the /edit/activity rules", async () => {
    queryRaw.mockResolvedValue([]);
    await loadEditsByHourUncached(client, "2026-11-10", "2026-11-17");
    const sql = (queryRaw.mock.calls[0][0] as string[]).join("?");
    // The SQL literals track the TS rules.
    expect(BULK_REQUEST_PREFIX).toBe("bulk-");
    expect(isSystemActor("system-autolock")).toBe(true);
    expect(isSystemActor("ETL")).toBe(true);
    expect(sql).toContain("actor_cwid NOT LIKE 'system-%'");
    expect(sql).toContain("LOWER(actor_cwid) <> 'etl'");
    expect(sql).toContain("(request_id IS NULL OR request_id NOT LIKE 'bulk-%')");
  });

  it("rejects a malformed range before any SQL", async () => {
    await expect(loadEditsByHourUncached(client, "2026-11-1", "2026-11-17")).rejects.toThrow(
      /bad range/,
    );
    await expect(loadEditsByHourUncached(client, "2026-11-10", "x")).rejects.toThrow(/bad range/);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("propagates a DB error (so it is never cached) for the page to fail soft", async () => {
    queryRaw.mockRejectedValue(new Error("SELECT denied"));
    await expect(
      loadEditsByHour(client, { since: "2026-11-10", until: "2026-11-17" }),
    ).rejects.toThrow("SELECT denied");
  });
});
