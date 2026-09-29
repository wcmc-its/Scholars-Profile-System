import { describe, expect, it, vi } from "vitest";
import { loadConceptTrials } from "@/lib/api/search-trials";
import { searchClient } from "@/lib/search";

vi.mock("@/lib/search", () => ({ searchClient: vi.fn(), TRIALS_INDEX: "scholars-trials" }));

describe("loadConceptTrials", () => {
  it("is empty without a concept, and never searches", async () => {
    const search = vi.fn();
    vi.mocked(searchClient).mockReturnValue({ search } as never);
    expect(await loadConceptTrials("abc1234", [])).toEqual({ trials: [], total: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it("filters to this PI and the concept subtree, and maps status labels", async () => {
    const search = vi.fn().mockResolvedValue({
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
    const out = await loadConceptTrials("abc1234", ["D009101", "D000001"]);
    expect(search.mock.calls[0][0].body.query.bool.filter).toEqual([
      { term: { piCwids: "abc1234" } },
      { terms: { meshDescriptorUi: ["D009101", "D000001"] } },
    ]);
    expect(out).toEqual({
      total: 5,
      trials: [
        { trialId: "NCT1", nctNumber: "NCT1", title: "A", status: "Recruiting", isActive: true, startYear: 2024 },
        { trialId: "19-1", nctNumber: null, title: "B", status: null, isActive: false, startYear: null },
      ],
    });
  });
});
