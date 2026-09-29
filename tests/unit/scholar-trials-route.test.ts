/**
 * GET /api/scholar/[cwid]/trials — a scholar's PI trials tagged under the concept, for
 * Matcha's evidence block. Flag off / no concept ⇒ empty without searching; a failed
 * search ⇒ 200 with `error: "search_failed"`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/scholar/[cwid]/trials/route";
import { resolveSearchPeopleTrialEvidence } from "@/lib/api/search-flags";
import { conceptSubtreeUis } from "@/lib/api/search-taxonomy";
import { searchClient } from "@/lib/search";

vi.mock("@/lib/api/search-flags", () => ({ resolveSearchPeopleTrialEvidence: vi.fn() }));
vi.mock("@/lib/api/search-taxonomy", () => ({ conceptSubtreeUis: vi.fn() }));
vi.mock("@/lib/search", () => ({ searchClient: vi.fn(), TRIALS_INDEX: "scholars-trials" }));

const search = vi.fn();
function call(qs: string) {
  return GET(new NextRequest(`http://localhost/api/scholar/abc1234/trials?${qs}`), {
    params: Promise.resolve({ cwid: "abc1234" }),
  });
}

afterEach(() => {
  vi.mocked(resolveSearchPeopleTrialEvidence).mockReset();
  vi.mocked(conceptSubtreeUis).mockReset();
  search.mockReset();
});

describe("GET /api/scholar/[cwid]/trials", () => {
  it("is empty and never searches when the flag is off", async () => {
    vi.mocked(resolveSearchPeopleTrialEvidence).mockReturnValue(false);
    vi.mocked(searchClient).mockReturnValue({ search } as never);
    expect(await (await call("conceptUi=D009101")).json()).toEqual({ trials: [], total: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it("is empty without a concept", async () => {
    vi.mocked(resolveSearchPeopleTrialEvidence).mockReturnValue(true);
    vi.mocked(searchClient).mockReturnValue({ search } as never);
    expect(await (await call("")).json()).toEqual({ trials: [], total: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it("filters to this PI and the concept subtree, and maps status labels", async () => {
    vi.mocked(resolveSearchPeopleTrialEvidence).mockReturnValue(true);
    vi.mocked(conceptSubtreeUis).mockResolvedValue(["D009101", "D000001"]);
    search.mockResolvedValue({
      body: {
        hits: {
          total: { value: 5 },
          hits: [
            { _source: { trialId: "NCT1", nctNumber: "NCT1", title: "A", statusKey: "recruiting", statusBucket: "active", startYear: 2024 } },
            { _source: { trialId: "19-1", nctNumber: null, title: "B", statusBucket: "completed" } },
          ],
        },
      },
    });
    vi.mocked(searchClient).mockReturnValue({ search } as never);
    const body = await (await call("conceptUi=D009101")).json();
    const filter = search.mock.calls[0][0].body.query.bool.filter;
    expect(filter).toEqual([{ term: { piCwids: "abc1234" } }, { terms: { meshDescriptorUi: ["D009101", "D000001"] } }]);
    expect(body).toEqual({
      total: 5,
      trials: [
        { trialId: "NCT1", nctNumber: "NCT1", title: "A", status: "Recruiting", isActive: true, startYear: 2024 },
        { trialId: "19-1", nctNumber: null, title: "B", status: null, isActive: false, startYear: null },
      ],
    });
  });

  it("answers 200 with search_failed when the search throws", async () => {
    vi.mocked(resolveSearchPeopleTrialEvidence).mockReturnValue(true);
    search.mockRejectedValue(new Error("boom"));
    vi.mocked(searchClient).mockReturnValue({ search } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("descriptorUis=D009101");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trials: [], total: 0, error: "search_failed" });
  });
});
