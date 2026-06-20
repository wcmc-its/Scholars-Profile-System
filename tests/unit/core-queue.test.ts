/**
 * Per-core review queue partitioning (lib/api/core-queue). Pure logic only —
 * the effective-status decision is delegated to lib/api/core-merge.
 */
import { describe, expect, it } from "vitest";
import { partitionCoreQueue, type CoreQueueRow } from "@/lib/api/core-queue";
import type { ClaimStatus } from "@/lib/generated/prisma/client";

function row(over: Partial<CoreQueueRow> = {}): CoreQueueRow {
  return {
    pmid: "1",
    title: "A paper",
    journal: null,
    year: 2020,
    authorsString: null,
    likelihood: 0.5,
    status: "candidate",
    coauthors: [],
    ackAlias: null,
    ackSnippet: null,
    llmScore: null,
    ...over,
  };
}

const claimMap = (entries: Array<[string, ClaimStatus]>) => {
  const m = new Map<string, ClaimStatus>(entries);
  return (pmid: string) => m.get(pmid) ?? null;
};

describe("partitionCoreQueue", () => {
  it("an unclaimed engine candidate is an open candidate", () => {
    const { candidates, confirmed } = partitionCoreQueue([row({ pmid: "1" })], () => null);
    expect(candidates.map((r) => r.pmid)).toEqual(["1"]);
    expect(confirmed).toHaveLength(0);
  });

  it("an engine-confirmed row goes to confirmed, not the candidate queue", () => {
    const { candidates, confirmed } = partitionCoreQueue(
      [row({ pmid: "2", status: "confirmed" })],
      () => null,
    );
    expect(candidates).toHaveLength(0);
    expect(confirmed.map((r) => r.pmid)).toEqual(["2"]);
  });

  it("a claimed candidate moves out of the queue into confirmed", () => {
    const { candidates, confirmed } = partitionCoreQueue(
      [row({ pmid: "3", status: "candidate" })],
      claimMap([["3", "claimed"]]),
    );
    expect(candidates).toHaveLength(0);
    expect(confirmed.map((r) => r.pmid)).toEqual(["3"]);
  });

  it("a rejected pair drops out of both lists", () => {
    const { candidates, confirmed } = partitionCoreQueue(
      [row({ pmid: "4", status: "confirmed" })],
      claimMap([["4", "rejected"]]),
    );
    expect(candidates).toHaveLength(0);
    expect(confirmed).toHaveLength(0);
  });

  it("preserves input (likelihood) order", () => {
    const { candidates } = partitionCoreQueue(
      [row({ pmid: "a" }), row({ pmid: "b" }), row({ pmid: "c" })],
      () => null,
    );
    expect(candidates.map((r) => r.pmid)).toEqual(["a", "b", "c"]);
  });
});
