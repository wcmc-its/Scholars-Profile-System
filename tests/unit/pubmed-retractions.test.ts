import { describe, it, expect, vi } from "vitest";

import { selectPmidsToStamp, type CorpusPub } from "@/etl/pubmed-retractions/select";
import { fetchRetractedPmids } from "@/etl/pubmed-retractions/fetcher";

describe("selectPmidsToStamp", () => {
  const corpus: CorpusPub[] = [
    { pmid: "1", publicationType: "Academic Article" }, // retracted -> stamp
    { pmid: "2", publicationType: "Review" }, // retracted -> stamp
    { pmid: "3", publicationType: "Retraction" }, // retracted but already typed -> skip
    { pmid: "4", publicationType: "Academic Article" }, // not retracted -> skip
    { pmid: "5", publicationType: null }, // retracted, null type -> stamp
  ];
  const retracted = new Set(["1", "2", "3", "5", "999"]); // 999 not in corpus

  it("stamps retracted papers not already typed Retraction", () => {
    expect(selectPmidsToStamp(corpus, retracted).sort()).toEqual(["1", "2", "5"]);
  });

  it("skips papers already typed Retraction (idempotent on a converged corpus)", () => {
    const converged: CorpusPub[] = [
      { pmid: "1", publicationType: "Retraction" },
      { pmid: "2", publicationType: "Retraction" },
    ];
    expect(selectPmidsToStamp(converged, new Set(["1", "2"]))).toEqual([]);
  });

  it("returns nothing when the retracted set is empty", () => {
    expect(selectPmidsToStamp(corpus, new Set())).toEqual([]);
  });

  it("ignores retracted PMIDs that are not in the corpus", () => {
    expect(selectPmidsToStamp([], retracted)).toEqual([]);
  });
});

describe("fetchRetractedPmids", () => {
  function jsonResponse(idlist: string[]): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ esearchresult: { count: String(idlist.length), idlist } }),
      text: async () => "",
    } as unknown as Response;
  }

  it("unions PMIDs across year buckets and de-duplicates", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      // URLSearchParams percent-encodes the ':' in the year range (1800%3A1989);
      // decode so the year-bucket matchers below see the literal range.
      const s = decodeURIComponent(String(url));
      if (s.includes("1800:1989")) return jsonResponse(["10", "11"]);
      if (s.includes("1990:1990")) return jsonResponse(["11", "12"]); // 11 dup
      return jsonResponse([]); // 1991 (throughYear)
    });
    const out = await fetchRetractedPmids({ fetchFn, throughYear: 1991, delayMs: 0 });
    expect([...out].sort()).toEqual(["10", "11", "12"]);
    // pre-1990 bucket + one bucket per year 1990,1991 = 3 calls
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("throws when a year bucket exceeds the ESearch ceiling (no silent drop)", async () => {
    const fetchFn = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ esearchresult: { count: "10000", idlist: [] } }),
        text: async () => "",
      }) as unknown as Response,
    );
    await expect(fetchRetractedPmids({ fetchFn, throughYear: 1990, delayMs: 0 })).rejects.toThrow(
      /finer split/,
    );
  });

  it("surfaces an ESearch ERROR payload instead of returning a partial set", async () => {
    const fetchFn = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ esearchresult: { ERROR: "Search Backend failed" } }),
        text: async () => "",
      }) as unknown as Response,
    );
    await expect(fetchRetractedPmids({ fetchFn, throughYear: 1990, delayMs: 0 })).rejects.toThrow(
      /ESearch error/,
    );
  });

  it("retries on a 429 then succeeds", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, text: async () => "rate" } as unknown as Response;
      }
      return jsonResponse([]);
    });
    // pre-1990 + 1990 = 2 buckets; first call 429s then retries
    const out = await fetchRetractedPmids({ fetchFn, throughYear: 1990, delayMs: 0 });
    expect(out.size).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
