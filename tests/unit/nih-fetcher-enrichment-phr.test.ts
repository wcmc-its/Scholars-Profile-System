/**
 * `fetchProjectEnrichmentByCoreProjectNums` requests RePORTER's `PhrText` and
 * maps `phr_text` onto the enrichment (read by the NCI Table 2A import via
 * `Grant.phrText`). Mocks `fetch` — never calls RePORTER.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProjectEnrichmentByCoreProjectNums } from "@/etl/nih-profile/fetcher";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchProjectEnrichmentByCoreProjectNums PHR", () => {
  it("requests PhrText and maps phr_text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        meta: { total: 2 },
        results: [
          { appl_id: 1, core_project_num: "R01CA000001", abstract_text: "A", phr_text: "P" },
          { appl_id: 2, core_project_num: "R01GM000002", abstract_text: "B" },
        ],
      }),
    } as unknown as Response);

    const result = await fetchProjectEnrichmentByCoreProjectNums(["R01CA000001", "R01GM000002"]);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.include_fields).toContain("PhrText");
    expect(result.get("R01CA000001")?.phrText).toBe("P");
    expect(result.get("R01GM000002")?.phrText).toBeNull();
  });
});
