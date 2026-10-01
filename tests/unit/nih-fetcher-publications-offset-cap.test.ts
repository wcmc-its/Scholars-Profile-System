import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicationsByCoreProjectNums } from "@/etl/nih-profile/fetcher";

function mockResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function coresOf(init: RequestInit | undefined): string[] {
  return JSON.parse(String(init?.body)).criteria.core_project_nums;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchPublicationsByCoreProjectNums offset cap (#2592)", () => {
  it("falls back to per-core fetches and skips only the core that overflows", async () => {
    const BIG = "P30CA000001";
    const SMALL = "R01CA000002";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const cores = coresOf(init);
      if (cores.includes(BIG)) {
        // The combined batch and the big core alone both exceed the cap.
        return mockResp(200, {
          meta: { total: 33297 },
          results: [{ coreproject: BIG, pmid: 1, applid: 10 }],
        });
      }
      return mockResp(200, {
        meta: { total: 2 },
        results: [
          { coreproject: SMALL, pmid: 111, applid: 20 },
          { coreproject: SMALL, pmid: 222, applid: null },
        ],
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = fetchPublicationsByCoreProjectNums([BIG, SMALL]);
    await vi.runAllTimersAsync();
    const rows = await p;

    expect(rows).toEqual([
      { coreProjectNum: SMALL, pmid: 111, applId: 20 },
      { coreProjectNum: SMALL, pmid: 222, applId: null },
    ]);
    // batch, then BIG alone, then SMALL alone — no paging past the first page.
    expect(fetchMock.mock.calls.map(([, init]) => coresOf(init))).toEqual([
      [BIG, SMALL],
      [BIG],
      [SMALL],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(BIG);
    expect(warn.mock.calls[0][0]).not.toContain(SMALL);
  });

  it("skips a lone overflowing core without re-fetching it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResp(200, { meta: { total: 10_000 }, results: [] }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = fetchPublicationsByCoreProjectNums(["P30CA000001"]);
    await vi.runAllTimersAsync();
    expect(await p).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches a lone over-cap core restricted to the given PMIDs, in slices", async () => {
    const BIG = "P30CA000001";
    // 501 PMIDs -> two pmids-restricted slices (500 + 1).
    const pmids = Array.from({ length: 501 }, (_, i) => i + 1);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const criteria = JSON.parse(String(init?.body)).criteria;
      if (!criteria.pmids) {
        return mockResp(200, { meta: { total: 33297 }, results: [] });
      }
      // Only some of the slice's PMIDs are actually linked to the core.
      const linked = (criteria.pmids as number[]).filter((p) => p % 250 === 0 || p === 501);
      return mockResp(200, {
        meta: { total: linked.length },
        results: linked.map((pmid) => ({ coreproject: BIG, pmid, applid: 10 })),
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = fetchPublicationsByCoreProjectNums([BIG], pmids);
    await vi.runAllTimersAsync();
    const rows = await p;

    expect(rows.map((r) => r.pmid)).toEqual([250, 500, 501]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).criteria);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toEqual({ core_project_nums: [BIG] });
    expect(bodies[1].core_project_nums).toEqual([BIG]);
    expect(bodies[1].pmids).toEqual(pmids.slice(0, 500));
    expect(bodies[2].pmids).toEqual([501]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a batch's other cores and fills the over-cap core from the PMID slice", async () => {
    const BIG = "P30CA000001";
    const SMALL = "R01CA000002";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const criteria = JSON.parse(String(init?.body)).criteria;
      if (criteria.core_project_nums.includes(BIG) && !criteria.pmids) {
        return mockResp(200, { meta: { total: 33297 }, results: [] });
      }
      if (criteria.pmids) {
        return mockResp(200, {
          meta: { total: 1 },
          results: [{ coreproject: BIG, pmid: 7, applid: 10 }],
        });
      }
      return mockResp(200, {
        meta: { total: 1 },
        results: [{ coreproject: SMALL, pmid: 111, applid: 20 }],
      });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = fetchPublicationsByCoreProjectNums([BIG, SMALL], new Set([7, 8]));
    await vi.runAllTimersAsync();
    const rows = await p;

    expect(rows).toEqual([
      { coreProjectNum: BIG, pmid: 7, applId: 10 },
      { coreProjectNum: SMALL, pmid: 111, applId: 20 },
    ]);
    // batch, BIG alone (over cap), BIG restricted to PMIDs, SMALL alone.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
