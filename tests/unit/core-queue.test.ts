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
    fullAuthorsString: null,
    abstract: null,
    synopsis: null,
    likelihood: 0.5,
    status: "candidate",
    coauthors: [],
    coauthorScholars: [],
    wcmAuthors: [],
    signalAck: false,
    ackAlias: null,
    ackSnippet: null,
    llmScore: null,
    llmRationale: null,
    authorAffinity: null,
    citationCount: 0,
    pubmedUrl: null,
    doi: null,
    claimed: false,
    relativeCitationRatio: null,
    nihPercentile: null,
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
    // engine-confirmed, no human claim → revoke path is 'rejected'
    expect(confirmed[0]?.claimed).toBe(false);
  });

  it("a claimed candidate moves out of the queue into confirmed", () => {
    const { candidates, confirmed } = partitionCoreQueue(
      [row({ pmid: "3", status: "candidate" })],
      claimMap([["3", "claimed"]]),
    );
    expect(candidates).toHaveLength(0);
    expect(confirmed.map((r) => r.pmid)).toEqual(["3"]);
    // human claim → revoke path is the soft 'revoked'
    expect(confirmed[0]?.claimed).toBe(true);
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
      fullAuthorsString: "Ballon D, Dyke J, Xiang J",
      abstract: "We imaged the brain.",
      synopsis: "A new MRI sequence.",
      citationCount: 12,
      pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/30418319/",
      doi: "10.1/x",
      relativeCitationRatio: "2.1000",
      nihPercentile: "89.0",
    },
  });

  // djb2001 is a known scholar (core staff); jpd2001 has no Scholar row.
  const SCHOLARS = [
    { cwid: "djb2001", preferredName: "Doug Ballon", slug: "doug-ballon", primaryDepartment: "Radiology" },
  ];
  // Two byline WCM authors for the paper, in position order.
  const AUTHORS = [
    { pmid: "30418319", cwid: "jpd2001", scholar: { preferredName: "Jonathan Dyke", slug: "jonathan-dyke", primaryDepartment: "Radiology" } },
    { pmid: "30418319", cwid: "jx2001", scholar: { preferredName: "Jenny Xiang", slug: "jenny-xiang", primaryDepartment: "Genomics" } },
  ];

  const reader = (
    rows: ReturnType<typeof rawRow>[],
    scholars: typeof SCHOLARS = SCHOLARS,
    authors: typeof AUTHORS = AUTHORS,
  ) =>
    ({
      core: { findUnique: async () => ({ id: "2", name: "Imaging" }) },
      publicationCore: { findMany: async () => rows },
      coreClaim: { findMany: async () => [] },
      scholar: { findMany: async () => scholars },
      publicationAuthor: { findMany: async () => authors },
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
    // RCR/percentile (reciterdb.analysis_nih) coerced from Decimal strings
    expect(r?.relativeCitationRatio).toBe(2.1);
    expect(r?.nihPercentile).toBe(89);
  });

  it("resolves a core-staff co-author via the byline even when absent from the direct scholar lookup (Tier 2)", async () => {
    const r = (await loadCoreReviewQueue("2", reader([rawRow()])))?.candidates[0];
    // djb2001 resolves from the scholar lookup; jpd2001 isn't in that lookup but IS
    // a byline author, so its name is present and resolved (not left as a CWID).
    expect(r?.coauthorScholars.map((s) => s.name).sort()).toEqual(["Doug Ballon", "Jonathan Dyke"]);
  });

  it("resolves a core-staff CWID case-insensitively and leaves a truly-unknown one bare", async () => {
    const raw = { ...rawRow(), signalCoauthors: ["DJB2001", "zzz9999"] };
    const r = (
      await loadCoreReviewQueue("2", reader([raw as unknown as ReturnType<typeof rawRow>]))
    )?.candidates[0];
    // uppercase engine CWID still matches the lowercase scholar row
    expect(r?.coauthorScholars.map((s) => s.name)).toContain("Doug Ballon");
    // a CWID with no scholar row and no byline match stays unresolved (lowercased)
    expect(r?.coauthors).toContain("zzz9999");
    expect(r?.coauthorScholars.some((s) => s.name.toLowerCase().includes("zzz"))).toBe(false);
  });

  it("attaches WCM byline authors in order + the publication detail fields (Tier 2)", async () => {
    const r = (await loadCoreReviewQueue("2", reader([rawRow()])))?.candidates[0];
    expect(r?.wcmAuthors.map((s) => s.name)).toEqual(["Jonathan Dyke", "Jenny Xiang"]);
    expect(r?.abstract).toBe("We imaged the brain.");
    expect(r?.synopsis).toBe("A new MRI sequence.");
    expect(r?.fullAuthorsString).toBe("Ballon D, Dyke J, Xiang J");
  });

  it("dedupes a repeated WCM author and caps the list at WCM_AUTHORS_CAP (Tier 2)", async () => {
    const dup = {
      pmid: "30418319",
      cwid: "dup001",
      scholar: { preferredName: "Dup Author", slug: "dup", primaryDepartment: "Core" },
    };
    // 13 further distinct authors → 14 distinct total, well over the cap of 12.
    const many = Array.from({ length: 13 }, (_, i) => ({
      pmid: "30418319",
      cwid: `aut${i}`,
      scholar: { preferredName: `Author ${i}`, slug: `author-${i}`, primaryDepartment: "Core" },
    }));
    const r = (
      await loadCoreReviewQueue("2", reader([rawRow()], SCHOLARS, [dup, dup, ...many]))
    )?.candidates[0];
    expect(r?.wcmAuthors).toHaveLength(12); // capped
    expect(r?.wcmAuthors.filter((w) => w.cwid === "dup001")).toHaveLength(1); // deduped
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
