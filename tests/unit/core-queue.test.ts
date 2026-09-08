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
    journalAbbrev: null,
    year: 2020,
    dateAddedToEntrez: null,
    authorsString: null,
    fullAuthorsString: null,
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
    topicalPrior: null,
    methodTier: null,
    methodEvidence: [],
    citationCount: 0,
    pubmedUrl: null,
    doi: null,
    claimed: false,
    isManual: false,
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

  it("a rejected pair lands in the rejected list (backed by a human claim)", () => {
    const { candidates, confirmed, rejected } = partitionCoreQueue(
      [row({ pmid: "4", status: "confirmed" })],
      claimMap([["4", "rejected"]]),
    );
    expect(candidates).toHaveLength(0);
    expect(confirmed).toHaveLength(0);
    expect(rejected.map((r) => r.pmid)).toEqual(["4"]);
    // a rejected pair always has an active human claim → claimed flag is set so
    // the Rejected-tab restore knows to post the soft 'revoked' undo.
    expect(rejected[0]?.claimed).toBe(true);
  });

  it("an engine below_threshold row with no claim is surfaced in no list", () => {
    const { candidates, confirmed, rejected } = partitionCoreQueue(
      [row({ pmid: "5", status: "below_threshold" })],
      () => null,
    );
    expect(candidates).toHaveLength(0);
    expect(confirmed).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });

  it("a human rejection wins over a below_threshold engine row → rejected list", () => {
    // the realistic case: the engine ranked it under the bar, a human rejected it.
    // The claim takes precedence (core-merge), so it lands in rejected, not dropped.
    const { rejected } = partitionCoreQueue(
      [row({ pmid: "6", status: "below_threshold" })],
      claimMap([["6", "rejected"]]),
    );
    expect(rejected.map((r) => r.pmid)).toEqual(["6"]);
    expect(rejected[0]?.claimed).toBe(true);
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
    topicalPrior: "0.3700",
    methodTier: "strong",
    // Pre-ranked strongest first, as the engine writes it.
    methodEvidence: [
      {
        family: "Sequencing",
        tool: "Illumina NovaSeq",
        sentence: "Libraries were sequenced on an Illumina NovaSeq 6000 at the core.",
      },
      {
        family: "Imaging",
        tool: "confocal microscope",
        sentence: "Sections were imaged on a Zeiss LSM 880 confocal microscope.",
      },
    ],
    publication: {
      title: "Advanced MRI",
      journal: "Synthetic Journal of Core Imaging Science",
      journalAbbrev: "Synth J Core Imaging Sci",
      year: 2021,
      dateAddedToEntrez: new Date("2026-02-18T00:00:00.000Z"),
      authorsString: "Ballon D",
      fullAuthorsString: "Ballon D, Dyke J, Xiang J",
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
    claims: Array<{ pmid: string; status: ClaimStatus }> = [],
    publications: Array<Record<string, unknown>> = [],
  ) =>
    ({
      core: { findUnique: async () => ({ id: "2", name: "Imaging" }) },
      publicationCore: { findMany: async () => rows },
      coreClaim: { findMany: async () => claims },
      scholar: { findMany: async () => scholars },
      publicationAuthor: { findMany: async () => authors },
      publication: { findMany: async () => publications },
    }) as unknown as Parameters<typeof loadCoreReviewQueue>[1];

  it("maps the new Tier-1 fields through, coercing Decimals and filtering CWIDs", async () => {
    const queue = await loadCoreReviewQueue("2", reader([rawRow()]));
    const r = queue?.candidates[0];
    expect(r?.likelihood).toBe(0.82);
    expect(r?.authorAffinity).toBe(0.42);
    expect(r?.topicalPrior).toBe(0.37);
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

  it("flags a row whose WCM byline ran past the cap, so the card can refuse to name", async () => {
    // `wcmAuthors` is a PREFIX of the byline once this fires, and the card
    // decides a surname is unambiguous by reading that list — a second holder of
    // the surname past the cap would be invisible, and the card would attach one
    // specific person's CWID, name and department to the wrong token.
    const many = Array.from({ length: 13 }, (_, i) => ({
      pmid: "30418319",
      cwid: `aut${i}`,
      scholar: { preferredName: `Author ${i}`, slug: `author-${i}`, primaryDepartment: "Core" },
    }));
    const r = (await loadCoreReviewQueue("2", reader([rawRow()], SCHOLARS, many)))?.candidates[0];
    expect(r?.wcmAuthors).toHaveLength(12);
    expect(r?.wcmAuthorsTruncated).toBe(true);
  });

  it("does not call a byline truncated when it fits, or when the extra row is a repeat", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      pmid: "30418319",
      cwid: `aut${i}`,
      scholar: { preferredName: `Author ${i}`, slug: `author-${i}`, primaryDepartment: "Core" },
    }));
    const fits = (await loadCoreReviewQueue("2", reader([rawRow()], SCHOLARS, twelve)))
      ?.candidates[0];
    // The KEY IS ABSENT, not `false`: this row ships to a client component and
    // "absent means not truncated" is the field's contract, so a `false` on the
    // ~2,400 ordinary rows of a large core is pure RSC payload. `in`, not
    // `toBeUndefined`, because only `in` can tell the two apart.
    expect("wcmAuthorsTruncated" in fits!).toBe(false);
    // A 13th row for someone already listed drops nobody — they are on the card
    // either way — so the dedupe must be tested before the cap.
    const withRepeat = (
      await loadCoreReviewQueue("2", reader([rawRow()], SCHOLARS, [...twelve, twelve[0]]))
    )?.candidates[0];
    expect(withRepeat?.wcmAuthors).toHaveLength(12);
    expect("wcmAuthorsTruncated" in withRepeat!).toBe(false);
  });

  it("dedupes a WCM author whose byline rows disagree on CWID casing, and does not call that truncation", async () => {
    // Nothing constrains `publication_author.cwid` to one casing per person, and
    // every other CWID comparison in this loader lowercases. A raw `===` here
    // lists the same person twice on the card — and, at the cap, blames the
    // 13th row for a truncation that dropped nobody, which makes the card refuse
    // to name ANY token on a byline it can see in full.
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      pmid: "30418319",
      cwid: `aut${i}`,
      scholar: { preferredName: `Author ${i}`, slug: `author-${i}`, primaryDepartment: "Core" },
    }));
    const shouted = { ...twelve[0], cwid: twelve[0].cwid.toUpperCase() };
    // Below the cap the casing variant is a plain double-listing: the same
    // person twice in `wcmAuthors`, once per casing.
    const small = (
      await loadCoreReviewQueue("2", reader([rawRow()], SCHOLARS, [twelve[0], twelve[1], shouted]))
    )?.candidates[0];
    expect(small?.wcmAuthors.map((w) => w.cwid)).toEqual(["aut0", "aut1"]);
    // At the cap it is worse: the 13th row drops nobody, but a case-sensitive
    // compare counts it as an overflow and the card then refuses to name ANY
    // token on a byline it can in fact see in full.
    const r = (await loadCoreReviewQueue("2", reader([rawRow()], SCHOLARS, [...twelve, shouted])))
      ?.candidates[0];
    expect(r?.wcmAuthors).toHaveLength(12);
    expect(r?.wcmAuthors.filter((w) => w.cwid.toLowerCase() === "aut0")).toHaveLength(1);
    expect("wcmAuthorsTruncated" in r!).toBe(false);
  });

  it("omits wcmAuthorsTruncated on a manually added row too, and sets it there when the byline overflows", async () => {
    // The manual builder is the SECOND mapping site — the "only when true" rule
    // has to hold on both or half the payload saving evaporates.
    const manualPub = {
      pmid: "99999999",
      title: "A manually added paper",
      journal: null,
      journalAbbrev: null,
      year: 2019,
      dateAddedToEntrez: null,
      authorsString: "Someone S",
      fullAuthorsString: "Someone S",
      synopsis: null,
      citationCount: 0,
      pubmedUrl: null,
      doi: null,
      relativeCitationRatio: null,
      nihPercentile: null,
    };
    const claims: Array<{ pmid: string; status: ClaimStatus }> = [
      { pmid: "99999999", status: "claimed" },
    ];
    const fits = (
      await loadCoreReviewQueue("2", reader([rawRow()], SCHOLARS, AUTHORS, claims, [manualPub]))
    )?.confirmed.find((r) => r.pmid === "99999999");
    expect("wcmAuthorsTruncated" in fits!).toBe(false);

    const many = Array.from({ length: 13 }, (_, i) => ({
      pmid: "99999999",
      cwid: `aut${i}`,
      scholar: { preferredName: `Author ${i}`, slug: `author-${i}`, primaryDepartment: "Core" },
    }));
    const over = (
      await loadCoreReviewQueue("2", reader([rawRow()], SCHOLARS, many, claims, [manualPub]))
    )?.confirmed.find((r) => r.pmid === "99999999");
    expect(over?.wcmAuthorsTruncated).toBe(true);
  });

  it("carries BOTH core staff counts through to the queue, and 0 through as 0", async () => {
    // The review-queue toolbar reads both to pick between no chip (null), the
    // two "signal cannot fire" lines (listed 0, or tracked 0), and the
    // mockup's "M of N" sentence, so 0 must not arrive as null or vice versa —
    // and the tracked count must not be collapsed into the listed one, which
    // is the whole reason two columns exist.
    const withStaff = (staffCount: number | null, staffTrackedCount: number | null) =>
      ({
        ...reader([rawRow()]),
        core: {
          findUnique: async () => ({ id: "2", name: "Imaging", staffCount, staffTrackedCount }),
        },
      }) as unknown as Parameters<typeof loadCoreReviewQueue>[1];

    // core 14's live shape: lists four, the signal matches one.
    const live = await loadCoreReviewQueue("2", withStaff(4, 1));
    expect(live?.core.staffCount).toBe(4);
    expect(live?.core.staffTrackedCount).toBe(1);

    // listed staff, none matchable (cores 8, 10 and 13 on the live dictionary)
    const untracked = await loadCoreReviewQueue("2", withStaff(3, 0));
    expect(untracked?.core.staffCount).toBe(3);
    expect(untracked?.core.staffTrackedCount).toBe(0);

    const none = await loadCoreReviewQueue("2", withStaff(0, 0));
    expect(none?.core.staffCount).toBe(0);
    expect(none?.core.staffTrackedCount).toBe(0);

    const unpublished = await loadCoreReviewQueue("2", withStaff(null, null));
    expect(unpublished?.core.staffCount).toBeNull();
    expect(unpublished?.core.staffTrackedCount).toBeNull();
  });

  it("keeps a null authorAffinity null (Number(null) would be 0)", async () => {
    const queue = await loadCoreReviewQueue(
      "2",
      reader([{ ...rawRow(), authorAffinity: null } as unknown as ReturnType<typeof rawRow>]),
    );
    expect(queue?.candidates[0]?.authorAffinity).toBeNull();
  });

  it("carries methodTier through, and a null one stays null", async () => {
    const r = (await loadCoreReviewQueue("2", reader([rawRow()])))?.candidates[0];
    expect(r?.methodTier).toBe("strong");

    const empty = await loadCoreReviewQueue(
      "2",
      reader([{ ...rawRow(), methodTier: null } as unknown as ReturnType<typeof rawRow>]),
    );
    expect(empty?.candidates[0]?.methodTier).toBeNull();
  });

  it("carries family/tool for EVERY method entry but only the top entry's sentence", async () => {
    // How the payload is bounded. The card puts a chip per family at the top, so
    // every family/tool travels; only the strongest entry's sentence is quoted,
    // and it travels WHOLE — the owner's decision is that nothing truncates it.
    const r = (await loadCoreReviewQueue("2", reader([rawRow()])))?.candidates[0];
    expect(r?.methodEvidence.map((e) => [e.family, e.tool])).toEqual([
      ["Sequencing", "Illumina NovaSeq"],
      ["Imaging", "confocal microscope"],
    ]);
    expect(r?.methodEvidence[0]?.sentence).toBe(
      "Libraries were sequenced on an Illumina NovaSeq 6000 at the core.",
    );
    expect(r?.methodEvidence[1]?.sentence).toBeNull();
  });

  it("degrades to no method evidence on a null, non-array, or malformed column", async () => {
    // `method_evidence` is Json? and absent on every row scored before the engine
    // emitted it, so a bad value must cost the chips, never the page.
    const parsed = async (methodEvidence: unknown) =>
      (
        await loadCoreReviewQueue(
          "2",
          reader([{ ...rawRow(), methodEvidence } as unknown as ReturnType<typeof rawRow>]),
        )
      )?.candidates[0]?.methodEvidence;
    expect(await parsed(null)).toEqual([]);
    expect(await parsed("not a list")).toEqual([]);
    expect(await parsed({ family: "Sequencing" })).toEqual([]);
    // an entry missing either short label is dropped; the well-formed ones stay,
    // and the surviving FIRST one is the one that carries the sentence
    expect(
      await parsed([
        { tool: "no family", sentence: "dropped" },
        { family: "Imaging", tool: "confocal", sentence: "kept whole" },
      ]),
    ).toEqual([{ family: "Imaging", tool: "confocal", sentence: "kept whole" }]);
    // a non-string sentence on the top entry is simply absent, not coerced
    expect(await parsed([{ family: "Imaging", tool: "confocal", sentence: 7 }])).toEqual([
      { family: "Imaging", tool: "confocal", sentence: null },
    ]);
  });

  it("selects method_evidence, which the card renders, but still not mesh_evidence", async () => {
    // CoreClaimQueue is a "use client" component taking `candidates` as props,
    // so every column selected here is serialized into the RSC payload for
    // EVERY queued row — 1,281 of them on core 14 in staging, and `findMany` has
    // no `take`. method_evidence earns its place now that the card renders
    // method chips and a "Methods used" row (its own payload bounded by the
    // sentence rule above); mesh_evidence is still a list of sentences no
    // component reads, so it stays out. The ETL writes all three columns
    // regardless; this only governs what crosses to the browser.
    let selected: Record<string, unknown> = {};
    const capturing = {
      core: { findUnique: async () => ({ id: "2", name: "Imaging" }) },
      publicationCore: {
        findMany: async (args: { select: Record<string, unknown> }) => {
          selected = args.select;
          return [rawRow()];
        },
      },
      coreClaim: { findMany: async () => [] },
      scholar: { findMany: async () => SCHOLARS },
      publicationAuthor: { findMany: async () => AUTHORS },
      publication: { findMany: async () => [] },
    } as unknown as Parameters<typeof loadCoreReviewQueue>[1];

    const r = (await loadCoreReviewQueue("2", capturing))?.candidates[0];
    expect(selected.methodTier).toBe(true);
    expect(selected.methodEvidence).toBe(true);
    expect(selected).not.toHaveProperty("meshEvidence");
    // and nothing reconstitutes mesh_evidence further down the mapper
    expect(r).not.toHaveProperty("meshEvidence");
  });

  it("does not select publication.abstract or publication.meshTerms", async () => {
    // Same payload rule as the test above, applied to the joined `publication`
    // row. Nothing has rendered either field since the Details disclosure came
    // out, and together they were 63% of the queue payload measured on staging
    // (4.2 MB of 6.7 MB across 2,446 core-14 rows). Re-adding one is only worth
    // it if a component actually reads it.
    let selected: Record<string, unknown> = {};
    const capturing = {
      core: { findUnique: async () => ({ id: "2", name: "Imaging" }) },
      publicationCore: {
        findMany: async (args: { select: Record<string, unknown> }) => {
          selected = args.select;
          return [rawRow()];
        },
      },
      coreClaim: { findMany: async () => [] },
      scholar: { findMany: async () => SCHOLARS },
      publicationAuthor: { findMany: async () => AUTHORS },
      publication: { findMany: async () => [] },
    } as unknown as Parameters<typeof loadCoreReviewQueue>[1];

    const r = (await loadCoreReviewQueue("2", capturing))?.candidates[0];
    const pubSelect = (selected.publication as { select: Record<string, unknown> }).select;
    expect(pubSelect.title).toBe(true);
    expect(pubSelect).not.toHaveProperty("abstract");
    expect(pubSelect).not.toHaveProperty("meshTerms");
    // and neither row builder puts them back on the emitted row
    expect(r).not.toHaveProperty("abstract");
    expect(r).not.toHaveProperty("meshTerms");
  });

  it("keeps a null topicalPrior null (Number(null) would be 0)", async () => {
    const queue = await loadCoreReviewQueue(
      "2",
      reader([{ ...rawRow(), topicalPrior: null } as unknown as ReturnType<typeof rawRow>]),
    );
    expect(queue?.candidates[0]?.topicalPrior).toBeNull();
  });

  it("surfaces a CLAIMED core_claim with no publication_core row as a manual confirmed row (Manual PMID add)", async () => {
    const queue = await loadCoreReviewQueue(
      "2",
      reader(
        [rawRow()], // one engine candidate, pmid 30418319
        SCHOLARS,
        AUTHORS,
        [{ pmid: "99999999", status: "claimed" }], // manually claimed, no engine row
        [
          {
            pmid: "99999999",
            title: "An older paper the engine never scored",
            journal: "Synthetic Journal of Late Findings",
            journalAbbrev: "Synth J Late Find",
            year: 2019,
            dateAddedToEntrez: new Date("2019-11-04T00:00:00.000Z"),
            authorsString: "Someone S",
            fullAuthorsString: "Someone S",
            synopsis: null,
            citationCount: 3,
            pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/99999999/",
            doi: null,
            relativeCitationRatio: null,
            nihPercentile: null,
          },
        ],
      ),
    );
    expect(queue?.candidates.map((r) => r.pmid)).toEqual(["30418319"]);
    const manual = queue?.confirmed.find((r) => r.pmid === "99999999");
    expect(manual).toBeDefined();
    expect(manual?.isManual).toBe(true);
    expect(manual?.claimed).toBe(true);
    expect(manual?.title).toBe("An older paper the engine never scored");
    // the manual builder is the SECOND mapping site — a field added only to the
    // engine builder silently renders blank on every manually-added row.
    expect(manual?.journalAbbrev).toBe("Synth J Late Find");
    expect(manual?.dateAddedToEntrez).toBe("2019-11-04");
    expect(manual?.likelihood).toBe(0);
    expect(manual?.coauthors).toEqual([]);
    expect(manual?.topicalPrior).toBeNull();
    // the engine-sourced row is NOT manual
    expect(queue?.candidates[0]?.isManual).toBe(false);
  });

  it("does not surface a REJECTED core_claim with no publication_core row (nothing to reject)", async () => {
    const queue = await loadCoreReviewQueue(
      "2",
      reader([rawRow()], SCHOLARS, AUTHORS, [{ pmid: "99999999", status: "rejected" }], []),
    );
    const pmids = [
      ...(queue?.candidates ?? []),
      ...(queue?.confirmed ?? []),
      ...(queue?.rejected ?? []),
    ].map((r) => r.pmid);
    expect(pmids).not.toContain("99999999");
  });

  it("maps the abbreviated journal alongside the full title (the card prefers the abbreviation)", async () => {
    const r = (await loadCoreReviewQueue("2", reader([rawRow()])))?.candidates[0];
    expect(r?.journalAbbrev).toBe("Synth J Core Imaging Sci");
    // the full title stays on the row — it is the card's fallback, and the CSV
    // export and the free-text filter both still read it.
    expect(r?.journal).toBe("Synthetic Journal of Core Imaging Science");
  });

  it("maps a null journalAbbrev to null (no abbreviation on file)", async () => {
    const raw = { ...rawRow(), publication: { ...rawRow().publication, journalAbbrev: null } };
    const r = (
      await loadCoreReviewQueue("2", reader([raw as unknown as ReturnType<typeof rawRow>]))
    )?.candidates[0];
    expect(r?.journalAbbrev).toBeNull();
    expect(r?.journal).toBe("Synthetic Journal of Core Imaging Science");
  });

  it("reads the @db.Date index date as a UTC calendar date, not the viewer's local one", async () => {
    // `dateAddedToEntrez` is `@db.Date` — Prisma returns midnight UTC. Read with
    // the LOCAL getters in any zone west of UTC and it is the previous day.
    const prev = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // Control: proves the zone switch actually took, so this test can never
      // pass vacuously on a UTC runner.
      expect(new Date("2026-02-18T00:00:00.000Z").getDate()).toBe(17);
      const r = (await loadCoreReviewQueue("2", reader([rawRow()])))?.candidates[0];
      expect(r?.dateAddedToEntrez).toBe("2026-02-18");
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it("keeps a null dateAddedToEntrez null (never ingested)", async () => {
    const raw = {
      ...rawRow(),
      publication: { ...rawRow().publication, dateAddedToEntrez: null },
    };
    const r = (
      await loadCoreReviewQueue("2", reader([raw as unknown as ReturnType<typeof rawRow>]))
    )?.candidates[0];
    expect(r?.dateAddedToEntrez).toBeNull();
    expect(r?.year).toBe(2021); // the card's fallback is still there
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
