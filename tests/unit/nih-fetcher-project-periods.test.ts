import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProjectPeriodsByCoreProjectNums } from "@/etl/nih-profile/fetcher";

function mockResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchProjectPeriodsByCoreProjectNums (#2020)", () => {
  it("returns an empty map without calling fetch for no cores", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const result = await fetchProjectPeriodsByCoreProjectNums([]);
    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unions min-start/max-end across multiple fiscal-year rows sharing a core", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResp(200, {
        meta: { total: 3 },
        results: [
          {
            core_project_num: "U2GGH000545",
            project_start_date: "2011-09-30T00:00:00",
            project_end_date: "2013-09-29T00:00:00",
          },
          {
            core_project_num: "U2GGH000545",
            project_start_date: "2011-09-30T00:00:00",
            project_end_date: "2016-09-29T00:00:00",
          },
          // No period on this one — must be skipped, not zeroed-out.
          {
            core_project_num: "U2GGH000545",
            project_start_date: null,
            project_end_date: null,
          },
        ],
      }),
    );

    const result = await fetchProjectPeriodsByCoreProjectNums(["U2GGH000545"]);
    expect(result.get("U2GGH000545")).toEqual({
      start: new Date("2011-09-30T00:00:00"),
      end: new Date("2016-09-29T00:00:00"),
    });
  });

  it("throws a contextual error on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResp(400, {}));
    await expect(
      fetchProjectPeriodsByCoreProjectNums(["R01CA000001"]),
    ).rejects.toThrow(/HTTP 400/);
  });
});
