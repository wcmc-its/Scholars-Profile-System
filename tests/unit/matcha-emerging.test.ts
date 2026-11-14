import { describe, expect, it } from "vitest";

import {
  buildEmergingWork,
  EMERGING_ON_ASK_MAX,
  EMERGING_PER_PERSON,
  matchedConceptTerms,
  type EmergingWorkRow,
} from "@/lib/api/matcha-emerging";

const concepts = [
  { term: "Crohn disease", kind: "concept" as const, members: ["Crohn disease", "Crohn's disease"] },
  { term: "IBD", kind: "concept" as const, members: ["IBD", "inflammatory bowel disease"] },
  { term: "Flow cytometry", kind: "method" as const, members: ["flow cytometry"] },
];

let n = 0;
function work(over: Partial<Omit<EmergingWorkRow, "authors">> & { authors?: string[] }): EmergingWorkRow {
  n++;
  const { authors = ["a"], ...rest } = over;
  return {
    id: `W${n}`,
    type: "preprint",
    doi: null,
    title: "Untitled",
    abstract: "",
    venue: "bioRxiv",
    publicationDate: new Date("2026-01-01"),
    score: 3,
    authors: authors.map((cwid) => ({ cwid, scholar: { preferredName: `Name ${cwid}`, slug: `slug-${cwid}` } })),
    ...rest,
  };
}

describe("matchedConceptTerms", () => {
  it("matches any member as a whole word, case-insensitively", () => {
    expect(matchedConceptTerms("Mucosal healing in CROHN'S DISEASE", concepts)).toEqual(["Crohn disease"]);
    expect(matchedConceptTerms("A model of inflammatory bowel disease.", concepts)).toEqual(["IBD"]);
  });
  it("indexing-style members match prose: possessives, plurals, hyphens", () => {
    const mesh = [
      { term: "Crohn disease", kind: "concept" as const, members: ["Crohn disease", "Inflammatory bowel diseases"] },
    ];
    for (const text of [
      "patients with Crohn's disease",
      "Crohn\u2019s disease activity",
      "a cohort with inflammatory bowel disease",
      "inflammatory-bowel diseases",
    ])
      expect(matchedConceptTerms(text, mesh)).toEqual(["Crohn disease"]);
    expect(matchedConceptTerms("Crohnology of disease", mesh)).toEqual([]);
    // "-is" words keep their s: "Psoriatic arthritis" must not become "arthriti".
    const pa = [{ term: "Psoriatic arthritis", kind: "concept" as const, members: ["Psoriatic arthritis"] }];
    expect(matchedConceptTerms("early psoriatic arthritis cohort", pa)).toEqual(["Psoriatic arthritis"]);
    expect(matchedConceptTerms("psoriatic arthriti", pa)).toEqual([]);
  });

  it("short all-caps members match case-sensitively and on word edges", () => {
    expect(matchedConceptTerms("patients with IBD-associated colitis", concepts)).toEqual(["IBD"]);
    expect(matchedConceptTerms("ibd in lower case", concepts)).toEqual([]);
    expect(matchedConceptTerms("IBDX is a gene", concepts)).toEqual([]);
  });
  it("a method alone is not a match", () => {
    expect(matchedConceptTerms("flow cytometry of T cells", concepts)).toEqual([]);
  });
});

describe("buildEmergingWork", () => {
  it("splits ranked authors' items from the on-ask list; drops non-matching work", () => {
    const r = buildEmergingWork(
      [
        work({ title: "Crohn's disease organoids", authors: ["a", "x"] }),
        work({ title: "Inflammatory bowel disease in mice", authors: ["x"] }),
        work({ title: "Unrelated cardiology", authors: ["a"] }),
      ],
      concepts,
      new Set(["a"]),
    );
    expect(r?.byCwid.a.map((i) => i.title)).toEqual(["Crohn's disease organoids"]);
    expect(r?.byCwid.x).toBeUndefined();
    expect(r?.onAsk.map((i) => i.title)).toEqual(["Inflammatory bowel disease in mice"]);
    expect(r?.onAsk[0].authors).toEqual([{ cwid: "x", name: "Name x", profileSlug: "slug-x" }]);
  });

  it("orders by concepts matched, then newest; caps per person and on-ask", () => {
    const ws = [
      work({ title: "IBD one", publicationDate: new Date("2025-01-01") }),
      work({ title: "IBD and Crohn disease", publicationDate: new Date("2024-01-01") }),
      work({ title: "IBD newest", publicationDate: new Date("2026-06-01") }),
      work({ title: "IBD four", publicationDate: new Date("2023-01-01") }),
    ];
    const r = buildEmergingWork(ws, concepts, new Set(["a"]));
    expect(r?.byCwid.a.map((i) => i.title)).toEqual(["IBD and Crohn disease", "IBD newest", "IBD one"]);
    expect(r?.byCwid.a).toHaveLength(EMERGING_PER_PERSON);
    expect(r?.byCwid.a[0].concepts).toEqual(["Crohn disease", "IBD"]);

    const many = Array.from({ length: EMERGING_ON_ASK_MAX + 5 }, () => work({ title: "IBD", authors: ["z"] }));
    expect(buildEmergingWork(many, concepts, new Set())?.onAsk).toHaveLength(EMERGING_ON_ASK_MAX);
  });

  it("links the DOI when there is one, else OpenAlex; undefined when nothing matched", () => {
    const r = buildEmergingWork(
      [work({ id: "W9", title: "IBD", doi: "10.1/x" }), work({ id: "W10", title: "Crohn disease" })],
      concepts,
      new Set(["a"]),
    );
    expect(r?.byCwid.a.map((i) => i.url).sort()).toEqual(["https://doi.org/10.1/x", "https://openalex.org/W10"]);
    expect(buildEmergingWork([work({ title: "nothing" })], concepts, new Set(["a"]))).toBeUndefined();
  });
});
