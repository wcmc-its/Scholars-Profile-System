/**
 * Issue #294 PR-5 — unit tests for the search-timing primitives.
 * `serverTimingHeader` is pure formatting; `timed` is a measure wrapper.
 */
import { describe, expect, it } from "vitest";
import { serverTimingHeader, timed } from "@/lib/api/search-timing";

describe("serverTimingHeader", () => {
  it("serializes marks as comma-separated Server-Timing metrics", () => {
    expect(
      serverTimingHeader([
        { name: "taxonomy", ms: 12, desc: "matchQueryToTaxonomy" },
        { name: "search", ms: 140, desc: "searchPeople" },
      ]),
    ).toBe(
      'taxonomy;dur=12;desc="matchQueryToTaxonomy", search;dur=140;desc="searchPeople"',
    );
  });

  it("omits desc when a mark has none", () => {
    expect(serverTimingHeader([{ name: "search", ms: 5 }])).toBe("search;dur=5");
  });

  it("keeps a zero-duration mark", () => {
    expect(serverTimingHeader([{ name: "search", ms: 0 }])).toBe("search;dur=0");
  });

  it("drops marks with a negative or non-finite duration", () => {
    expect(
      serverTimingHeader([
        { name: "a", ms: -1 },
        { name: "b", ms: NaN },
        { name: "c", ms: Infinity },
        { name: "d", ms: 7 },
      ]),
    ).toBe("d;dur=7");
  });

  it("returns an empty string when no mark survives", () => {
    expect(serverTimingHeader([])).toBe("");
    expect(serverTimingHeader([{ name: "x", ms: -3 }])).toBe("");
  });

  it("quotes a desc containing whitespace or quotes", () => {
    expect(serverTimingHeader([{ name: "x", ms: 1, desc: 'a "b"' }])).toBe(
      'x;dur=1;desc="a \\"b\\""',
    );
  });
});

describe("timed", () => {
  it("returns the resolved value of the wrapped call", async () => {
    const { result } = await timed(() => Promise.resolve({ total: 42 }));
    expect(result).toEqual({ total: 42 });
  });

  it("reports a non-negative integer millisecond duration", async () => {
    const { ms } = await timed(() => Promise.resolve("x"));
    expect(typeof ms).toBe("number");
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("measures elapsed wall time across an awaited delay", async () => {
    const { ms } = await timed(
      () => new Promise((resolve) => setTimeout(resolve, 30)),
    );
    // setTimeout never fires early; a 30ms delay yields an elapsed >= ~30ms.
    expect(ms).toBeGreaterThanOrEqual(20);
  });

  it("propagates a rejection from the wrapped call", async () => {
    await expect(
      timed(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
  });
});
