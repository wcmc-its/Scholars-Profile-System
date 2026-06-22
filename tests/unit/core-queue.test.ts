/**
 * Per-core review queue partitioning (lib/api/core-queue). Pure logic only —
 * the effective-status decision is delegated to lib/api/core-merge.
 */
import { describe, expect, it } from "vitest";
import { loadCoreReviewQueue, partitionCoreQueue, type CoreQueueRow } from "@/lib/api/core-queue";
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
    signalAck: false,
    ackAlias: null,
    ackSnippet: null,
    llmScore: null,
    llmRationale: null,
    authorAffinity: null,
    citationCount: 0,
    pubmedUrl: null,
    doi: null,
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

describe("loadCoreReviewQueue mapping", () => {
  // A raw publication_core row as Prisma returns it (Decimal fields as strings,
  // the FK-joined `publication`); the loader maps it to a CoreQueueRow.
  const rawRow = () => ({
    pmid: "30418319",
    likelihood: "0.8200",
    status: "candidate",
    signalCoauthors: ["djb2001", 42, "jpd2001"], // non-strings are dropped
    signalAck: true,
    ackAlias: "CBIC",
    ackSnippet: "processed at the imaging center",
    llmScore: 7,
    llmRationale: "Methods cite the core's confocal microscope.",
    authorAffinity: "0.4200",
    publication: {
      title: "Advanced MRI",
      journal: "NeuroImage",
      year: 2021,
      authorsString: "Ballon D",
      citationCount: 12,
      pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/30418319/",
      doi: "10.1/x",
    },
  });

  const reader = (rows: ReturnType<typeof rawRow>[]) =>
    ({
      core: { findUnique: async () => ({ id: "2", name: "Imaging" }) },
      publicationCore: { findMany: async () => rows },
      coreClaim: { findMany: async () => [] },
    }) as unknown as Parameters<typeof loadCoreReviewQueue>[1];

  it("maps the new Tier-1 fields through, coercing Decimals and filtering CWIDs", async () => {
    const queue = await loadCoreReviewQueue("2", reader([rawRow()]));
    const r = queue?.candidates[0];
    expect(r?.likelihood).toBe(0.82);
    expect(r?.authorAffinity).toBe(0.42);
    expect(r?.signalAck).toBe(true);
    expect(r?.llmRationale).toBe("Methods cite the core's confocal microscope.");
    expect(r?.coauthors).toEqual(["djb2001", "jpd2001"]);
    expect(r?.citationCount).toBe(12);
    expect(r?.pubmedUrl).toBe("https://pubmed.ncbi.nlm.nih.gov/30418319/");
    expect(r?.doi).toBe("10.1/x");
  });

  it("keeps a null authorAffinity null (Number(null) would be 0)", async () => {
    const queue = await loadCoreReviewQueue(
      "2",
      reader([{ ...rawRow(), authorAffinity: null } as unknown as ReturnType<typeof rawRow>]),
    );
    expect(queue?.candidates[0]?.authorAffinity).toBeNull();
  });

  it("returns null when the core does not exist", async () => {
    const emptyReader = {
      core: { findUnique: async () => null },
      publicationCore: { findMany: async () => [] },
      coreClaim: { findMany: async () => [] },
    } as unknown as Parameters<typeof loadCoreReviewQueue>[1];
    expect(await loadCoreReviewQueue("nope", emptyReader)).toBeNull();
  });
});
