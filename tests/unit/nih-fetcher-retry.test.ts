import { afterEach, describe, expect, it, vi } from "vitest";
import { searchProjectsByProfileIds } from "@/etl/nih-profile/fetcher";

// The retry/backoff helper (#1514) is module-internal; exercise it through
// `searchProjectsByProfileIds`, the simplest single-fetch exported path.
function mockResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const ONE_PROJECT = {
  results: [
    {
      appl_id: 1,
      core_project_num: "R01AA000001",
      project_end_date: null,
      principal_investigators: [
        {
          profile_id: 9,
          first_name: "A",
          middle_name: null,
          last_name: "B",
          full_name: "A B",
          is_contact_pi: true,
          title: null,
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("NIH RePORTER fetch retry/backoff (#1514)", () => {
  it("retries a transient 503 then 429, then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResp(503, {}))
      .mockResolvedValueOnce(mockResp(429, {}))
      .mockResolvedValueOnce(mockResp(200, ONE_PROJECT));

    const p = searchProjectsByProfileIds([9]);
    await vi.advanceTimersByTimeAsync(20_000); // burn the backoff sleeps
    const res = await p;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res).toHaveLength(1);
    expect(res[0].principal_investigators[0].profile_id).toBe(9);
  });

  it("retries a network error (fetch rejects) then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(mockResp(200, ONE_PROJECT));

    const p = searchProjectsByProfileIds([9]);
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res).toHaveLength(1);
  });

  it("does NOT retry a non-retryable 400 and surfaces the contextual error", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResp(400, {}));

    await expect(searchProjectsByProfileIds([9])).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries on a persistent 500", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResp(500, {}));

    const p = searchProjectsByProfileIds([9]);
    const rejection = expect(p).rejects.toThrow(/HTTP 500/);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    // 1 initial + 4 retries
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
