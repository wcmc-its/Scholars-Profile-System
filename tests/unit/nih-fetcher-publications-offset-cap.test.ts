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
});
