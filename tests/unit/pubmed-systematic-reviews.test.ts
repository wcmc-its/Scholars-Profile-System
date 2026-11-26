import { afterEach, describe, it, expect, vi } from "vitest";

import {
  BATCH_SIZE,
  assertFlaggedVolume,
  batchPmids,
  buildTerm,
  diffFlagged,
} from "@/etl/pubmed-systematic-reviews/select";
import { esearchBody, fetchSystematicReviewPmids } from "@/etl/pubmed-systematic-reviews/fetcher";

describe("batchPmids", () => {
  it("splits into batches of 100", () => {
    const pmids = Array.from({ length: 250 }, (_, i) => String(1000 + i));
    const batches = batchPmids(pmids);
    expect(BATCH_SIZE).toBe(100);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(pmids);
  });

  it("keeps only all-digit PMIDs and drops duplicates", () => {
    expect(batchPmids(["1", "PMC22", "2", "", "3a", "1", " 4"])).toEqual([["1", "2"]]);
  });

  it("returns no batches for an empty corpus", () => {
    expect(batchPmids([])).toEqual([]);
  });
});

describe("buildTerm", () => {
  it("ORs the batch as uid clauses and ANDs the systematic review filter", () => {
    expect(buildTerm(["1", "2", "3"])).toBe("(1[uid] OR 2[uid] OR 3[uid]) AND systematic[sb]");
  });

  it("handles a batch of one", () => {
    expect(buildTerm(["7"])).toBe("(7[uid]) AND systematic[sb]");
  });
});

describe("esearchBody", () => {
  it("carries db, term, retmode and retmax, and no api_key by default", () => {
    const body = esearchBody(["1", "2"]);
    expect(Object.fromEntries(body)).toEqual({
      db: "pubmed",
      term: "(1[uid] OR 2[uid]) AND systematic[sb]",
      retmode: "json",
      retmax: "100",
    });
  });

  it("adds api_key when one is given", () => {
    expect(esearchBody(["1"], "k").get("api_key")).toBe("k");
  });
});

describe("fetchSystematicReviewPmids", () => {
  function jsonResponse(idlist: string[]): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ esearchresult: { count: String(idlist.length), idlist } }),
      text: async () => "",
    } as unknown as Response;
  }

  function errorResponse(): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ esearchresult: { ERROR: "Search Backend failed" } }),
      text: async () => "",
    } as unknown as Response;
  }

  const fast = { delayMs: 0, retryBaseMs: 0 };

  it("POSTs a form-encoded body to ESearch, one call per batch", async () => {
    const pmids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse([]),
    );
    const out = await fetchSystematicReviewPmids(pmids, { fetchFn, ...fast });
    expect(out).toMatchObject({ asked: 150, batches: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
    expect(init?.method).toBe("POST");
    const body = init?.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(body.get("db")).toBe("pubmed");
    expect(body.get("retmode")).toBe("json");
    expect(body.get("retmax")).toBe("100");
    expect(body.get("term")).toMatch(/^\(1\[uid\] OR 2\[uid\] .* OR 100\[uid\]\) AND systematic\[sb\]$/);
    expect(body.has("api_key")).toBe(false);

    const second = fetchFn.mock.calls[1][1]?.body as URLSearchParams;
    expect(second.get("term")).toMatch(/^\(101\[uid\] .* OR 150\[uid\]\) AND systematic\[sb\]$/);
  });

  it("sends api_key when given", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse([]),
    );
    await fetchSystematicReviewPmids(["1"], { fetchFn, apiKey: "k", ...fast });
    expect((fetchFn.mock.calls[0][1]?.body as URLSearchParams).get("api_key")).toBe("k");
  });

  it("unions the flagged ids across batches", async () => {
    const pmids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    let calls = 0;
    const fetchFn = vi.fn(async () => (++calls === 1 ? jsonResponse(["5", "99"]) : jsonResponse(["120"])));
    const out = await fetchSystematicReviewPmids(pmids, { fetchFn, ...fast });
    expect([...out.flagged].sort()).toEqual(["120", "5", "99"]);
  });

  it("ignores a returned id that was not in the batch sent", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(["2", "999"]));
    const out = await fetchSystematicReviewPmids(["1", "2", "3"], { fetchFn, ...fast });
    expect([...out.flagged]).toEqual(["2"]);
  });

  it("makes no call for a corpus with no numeric PMIDs", async () => {
    const fetchFn = vi.fn(async () => jsonResponse([]));
    const out = await fetchSystematicReviewPmids(["abc"], { fetchFn, ...fast });
    expect(out).toMatchObject({ asked: 0, batches: 0 });
    expect(out.flagged.size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retries on a 429 then succeeds", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, text: async () => "rate" } as unknown as Response;
      }
      return jsonResponse(["1"]);
    });
    const out = await fetchSystematicReviewPmids(["1", "2"], { fetchFn, ...fast });
    expect([...out.flagged]).toEqual(["1"]);
    expect(calls).toBe(2);
  });

  it("retries an ESearch ERROR payload then succeeds (transient backend outage)", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => (++calls <= 2 ? errorResponse() : jsonResponse(["2"])));
    const out = await fetchSystematicReviewPmids(["1", "2"], { fetchFn, ...fast });
    expect([...out.flagged]).toEqual(["2"]);
    expect(calls).toBe(3);
  });

  it("retries a network error then succeeds", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      if (++calls === 1) throw new Error("socket hang up");
      return jsonResponse([]);
    });
    await fetchSystematicReviewPmids(["1"], { fetchFn, ...fast });
    expect(calls).toBe(2);
  });

  function unparsableResponse(): Response {
    return {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
      text: async () => "<html>",
    } as unknown as Response;
  }

  it("retries a 200 whose body is not JSON then succeeds", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => (++calls === 1 ? unparsableResponse() : jsonResponse(["2"])));
    const out = await fetchSystematicReviewPmids(["1", "2"], { fetchFn, ...fast });
    expect([...out.flagged]).toEqual(["2"]);
    expect(calls).toBe(2);
  });

  it("throws the parse error once retries on a non-JSON body are exhausted", async () => {
    const fetchFn = vi.fn(async () => unparsableResponse());
    await expect(fetchSystematicReviewPmids(["1"], { fetchFn, ...fast })).rejects.toThrow(
      /Unexpected token/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("throws after retries are exhausted, before asking about the next batch", async () => {
    const pmids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const fetchFn = vi.fn(async () => errorResponse());
    await expect(fetchSystematicReviewPmids(pmids, { fetchFn, ...fast })).rejects.toThrow(
      /ESearch error/,
    );
    // first batch: 1 try + 5 retries, then it throws
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  /** A fetch that records how many calls are in flight at once. */
  function trackingFetch(flag: (body: URLSearchParams) => string[] = () => []) {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return jsonResponse(flag(init?.body as URLSearchParams));
    });
    return { fetchFn, peak: () => peak };
  }

  it("makes one call at a time without a key", async () => {
    const pmids = Array.from({ length: 800 }, (_, i) => String(i + 1));
    const { fetchFn, peak } = trackingFetch();
    await fetchSystematicReviewPmids(pmids, { fetchFn, ...fast });
    expect(fetchFn).toHaveBeenCalledTimes(8);
    expect(peak()).toBe(1);
  });

  it("makes three calls at a time with a key, and still asks about every batch once", async () => {
    const pmids = Array.from({ length: 800 }, (_, i) => String(i + 1));
    // Flag the first PMID of each batch, so a skipped or repeated batch shows.
    const { fetchFn, peak } = trackingFetch((body) => [
      /^\((\d+)\[uid\]/.exec(body.get("term") ?? "")![1],
    ]);
    const out = await fetchSystematicReviewPmids(pmids, { fetchFn, apiKey: "k", ...fast });
    expect(fetchFn).toHaveBeenCalledTimes(8);
    expect(peak()).toBe(3);
    expect(out.asked).toBe(800);
    expect([...out.flagged].sort((x, y) => Number(x) - Number(y))).toEqual(
      ["1", "101", "201", "301", "401", "501", "601", "701"],
    );
  });

  it("stops starting new batches once one has failed", async () => {
    const pmids = Array.from({ length: 2000 }, (_, i) => String(i + 1));
    const fetchFn = vi.fn(async () => errorResponse());
    await expect(
      fetchSystematicReviewPmids(pmids, { fetchFn, apiKey: "k", concurrency: 3, ...fast }),
    ).rejects.toThrow(/ESearch error/);
    // Only the three batches already in flight are tried (1 try + 5 retries each).
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(18);
  });

  it("throws after retries on a persistent 5xx", async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 502, text: async () => "bad gateway" }) as unknown as Response,
    );
    await expect(fetchSystematicReviewPmids(["1"], { fetchFn, ...fast })).rejects.toThrow(
      /ESearch 502/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("does not retry a 400", async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 400, text: async () => "bad" }) as unknown as Response,
    );
    await expect(fetchSystematicReviewPmids(["1"], { fetchFn, ...fast })).rejects.toThrow(
      /ESearch 400/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("treats a count that disagrees with the idlist as a failed batch", async () => {
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ esearchresult: { count: "3", idlist: ["1"] } }),
          text: async () => "",
        }) as unknown as Response,
    );
    await expect(fetchSystematicReviewPmids(["1", "2", "3"], { fetchFn, ...fast })).rejects.toThrow(
      /count 3 but 1 ids/,
    );
  });
});

describe("diffFlagged", () => {
  it("adds the newly flagged, removes the no longer flagged, leaves the rest", () => {
    const diff = diffFlagged(["1", "2", "3"], new Set(["2", "3", "4", "5"]));
    expect(diff.toAdd.sort()).toEqual(["4", "5"]);
    expect(diff.toRemove).toEqual(["1"]);
    expect(diff.unchanged).toBe(2);
  });

  it("is a no-op when the table already matches", () => {
    expect(diffFlagged(["1", "2"], new Set(["1", "2"]))).toEqual({
      toAdd: [],
      toRemove: [],
      unchanged: 2,
    });
  });

  it("inserts everything into an empty table", () => {
    const diff = diffFlagged([], new Set(["1", "2"]));
    expect(diff).toEqual({ toAdd: ["1", "2"], toRemove: [], unchanged: 0 });
  });
});

describe("assertFlaggedVolume", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when nothing is flagged, even into an empty table", () => {
    expect(() => assertFlaggedVolume(0, 0)).toThrow(/flagged 0/);
    expect(() => assertFlaggedVolume(0, 5000)).toThrow(/flagged 0/);
  });

  it("passes a first run into an empty table", () => {
    expect(() => assertFlaggedVolume(4000, 0)).not.toThrow();
  });

  it("throws when a table of 100 or more rows would shrink to less than half", () => {
    expect(() => assertFlaggedVolume(49, 100)).toThrow(/pubmed-systematic-reviews:flagged/);
    expect(() => assertFlaggedVolume(1999, 4000)).toThrow(/drop/);
  });

  it("passes at exactly half, and for a flat or growing set", () => {
    expect(() => assertFlaggedVolume(50, 100)).not.toThrow();
    expect(() => assertFlaggedVolume(4000, 4000)).not.toThrow();
    expect(() => assertFlaggedVolume(4100, 4000)).not.toThrow();
  });

  it("does not apply the shrink check below 100 existing rows", () => {
    expect(() => assertFlaggedVolume(1, 99)).not.toThrow();
  });

  it("lets an operator bypass the shrink check, but never the empty check", () => {
    vi.stubEnv("ETL_GUARD_BYPASS", "pubmed-systematic-reviews:flagged");
    expect(() => assertFlaggedVolume(10, 4000)).not.toThrow();
    expect(() => assertFlaggedVolume(0, 4000)).toThrow(/flagged 0/);
  });
});
