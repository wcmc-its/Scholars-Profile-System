import { describe, expect, it, vi } from "vitest";
import { fillRejectedTitles } from "@/etl/reporter-grants/rejected-titles";
import type { CueHit } from "@/etl/reporter-grants/score";

const hit = (pmids: string[]): CueHit => ({
  id: "rejected_pmids",
  weight: -4,
  reason: "x",
  rejected: pmids.map((pmid) => ({ pmid, title: null })),
});

describe("fillRejectedTitles", () => {
  it("names each rejected paper from PubMed in one call, leaving unknown ones untitled", async () => {
    const a = hit(["111", "222"]);
    const b = hit(["333"]);
    const fetchTitles = vi.fn(
      async () =>
        new Map([
          [111, "First paper"],
          [333, "Third paper"],
        ]),
    );
    await fillRejectedTitles([[a], [b, { id: "pub_linked", weight: 4, reason: "y" }]], fetchTitles);
    expect(fetchTitles).toHaveBeenCalledTimes(1);
    expect(fetchTitles).toHaveBeenCalledWith([111, 222, 333]);
    expect(a.rejected).toEqual([
      { pmid: "111", title: "First paper" },
      { pmid: "222", title: null },
    ]);
    expect(b.rejected).toEqual([{ pmid: "333", title: "Third paper" }]);
  });

  it("makes no call without rejected papers, and keeps the PMIDs when PubMed fails", async () => {
    const none = vi.fn(async () => new Map<number, string>());
    await fillRejectedTitles([[{ id: "pub_linked", weight: 4, reason: "y" }]], none);
    expect(none).not.toHaveBeenCalled();

    const a = hit(["111"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fillRejectedTitles([[a]], async () => {
      throw new Error("down");
    });
    expect(a.rejected).toEqual([{ pmid: "111", title: null }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
