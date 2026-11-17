/**
 * `etl/research-security/build.ts` — the ETL's pure rules: attribution
 * classification, campus, external-cohort exclusion, the stable article key,
 * and the empty-source guard.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  MIN_SOURCE_MATCH_ROWS,
  articleKey,
  assertPlausibleSource,
  attachPeople,
  buildArticles,
  bylineCouldBe,
  campusOf,
  isExternalCohort,
  isOurAuthor,
  isPendingAssertion,
  ithacaCwids,
  joinCwids,
  nameKey,
  nameKeysByCwid,
  normDoi,
  ourAuthorCwids,
  sourceOf,
  toDate,
  type AcceptedRow,
  type PendingRow,
  type PersonFact,
  type ReviewRow,
} from "@/etl/research-security/build";
import { EtlGuardError } from "@/lib/etl-guard";

const persons = new Map<string, PersonFact>(
  [
    { cwid: "abc2001", firstName: "Ann", lastName: "Chen", title: "Professor", department: "Medicine" },
    { cwid: "hc63", firstName: "Hsiao", lastName: "Chiang", title: "Professor", department: "ECE" },
    { cwid: "xyz9", firstName: "NULL", lastName: "'NULL'", title: null, department: null },
  ].map((p) => [p.cwid, p]),
);
const ithaca = new Set(["hc63"]);
const names = nameKeysByCwid([...persons.values()].map((p) => ({ cwid: p.cwid, first: p.firstName, last: p.lastName })));

const accepted = (o: Partial<AcceptedRow>): AcceptedRow => ({ cwid: null, pmid: null, articleId: null, doi: null, ...o });
const pending = (o: Partial<PendingRow>): PendingRow => ({ cwid: null, pmid: null, doi: null, userAssertion: null, score: null, ...o });
const review = (o: Partial<ReviewRow>): ReviewRow => ({
  cwid: null,
  pmid: null,
  doi: null,
  source: "pubmed",
  externalId: null,
  status: "open",
  score: null,
  author: null,
  affiliation: null,
  title: null,
  journal: null,
  pubType: null,
  entrezDate: null,
  ...o,
});

function attach(o: {
  flagged: string[];
  accepted?: AcceptedRow[];
  pending?: PendingRow[];
  review?: ReviewRow[];
}) {
  return attachPeople({
    flaggedIds: o.flagged,
    accepted: o.accepted ?? [],
    pending: o.pending ?? [],
    review: o.review ?? [],
    persons,
    ithaca,
    names,
  });
}

describe("external validation cohorts", () => {
  it.each(["fh_123", "fredhutch_ab1", "ucsf_x1", "ucla_9", "uc_1", "usc_77", "UCSD_5"])("%s is excluded", (c) => {
    expect(isExternalCohort(c)).toBe(true);
  });
  it.each(["abc2001", "hc63", "uca2001", "fhs2002", "usc2003", "", null])("%s is ours", (c) => {
    expect(isExternalCohort(c)).toBe(false);
  });

  it("a cohort person never reaches the output, whatever the table", () => {
    const { people } = attach({
      flagged: ["100"],
      accepted: [accepted({ cwid: "ucsf_ab1", pmid: 100 })],
      pending: [pending({ cwid: "fredhutch_9", pmid: 100 })],
      review: [review({ cwid: "usc_3", pmid: 100, author: "A B" })],
    });
    expect(people).toEqual([]);
  });
});

describe("campus", () => {
  it("is ithaca only for the exact person type 'cornell-ithaca'", () => {
    expect(campusOf(["cornell-ithaca"])).toBe("ithaca");
    expect(campusOf(["academic-faculty", "cornell-ithaca"])).toBe("ithaca");
    expect(campusOf(["affiliate-cornell"])).toBe("wcm");
    expect(campusOf(["cornell-ithaca-alumni", "Cornell-Ithaca"])).toBe("wcm");
    expect(campusOf([])).toBe("wcm");
  });

  it("is read from the ithaca set for a person, not from their name or department", () => {
    const { people } = attach({
      flagged: ["100"],
      accepted: [accepted({ cwid: "HC63", pmid: 100 }), accepted({ cwid: "abc2001", pmid: 100 })],
    });
    expect(people.map((p) => [p.cwid, p.campus])).toEqual([
      ["hc63", "ithaca"],
      ["abc2001", "wcm"],
    ]);
  });

  it("the ithaca set is built by the exact rule, not by the collation that fetched the rows", () => {
    // person_person_type is utf8mb4_unicode_ci: WHERE personType = 'cornell-ithaca'
    // also returns these spellings. Only the exact one counts.
    expect(
      ithacaCwids([
        { cwid: "HC63 ", personType: "cornell-ithaca" },
        { cwid: "aa1", personType: "Cornell-Ithaca" },
        { cwid: "bb2", personType: "cornell-ithaca " },
        { cwid: "cc3", personType: "CORNELL-ITHACA" },
        { cwid: null, personType: "cornell-ithaca" },
        { cwid: "dd4", personType: null },
      ]),
    ).toEqual(new Set(["hc63"]));
  });

  it("a review row with no proposed person is never Ithaca, whatever its byline affiliation says", () => {
    const { people } = attach({
      flagged: ["300"],
      review: [
        review({ pmid: 300, author: "Li Wei", affiliation: "Ithaca College, Ithaca, NY" }),
        review({ pmid: 300, author: "Bo Chen", affiliation: "Cornell University, Ithaca, NY" }),
        review({ pmid: 300, author: "Mei Lin", affiliation: "Weill Cornell Medicine, New York" }),
      ],
    });
    expect(people.map((p) => p.campus)).toEqual(["unknown", "unknown", "unknown"]);
  });
});

describe("attribution classification", () => {
  it("empty and PENDING assertions are pending; anything else is not", () => {
    for (const a of [null, "", "  ", "PENDING", "pending"]) expect(isPendingAssertion(a)).toBe(true);
    for (const a of ["ACCEPTED", "REJECTED"]) expect(isPendingAssertion(a)).toBe(false);
  });

  it("classifies by table: confirmed, pending, review_queue", () => {
    const { people } = attach({
      flagged: ["100", "200", "300"],
      accepted: [accepted({ cwid: "abc2001", pmid: 100 })],
      pending: [pending({ cwid: "abc2001", pmid: 200, userAssertion: "PENDING", score: 93.5 })],
      review: [review({ cwid: "hc63", pmid: 300, score: 71 })],
    });
    expect(people.map((p) => [p.articleId, p.attribution, p.reciterScore])).toEqual([
      ["100", "confirmed", null],
      ["200", "pending", 93.5],
      ["300", "review_queue", 71],
    ]);
  });

  it("a rejected suggestion and a closed review row attach nobody", () => {
    const { people } = attach({
      flagged: ["100"],
      pending: [pending({ cwid: "abc2001", pmid: 100, userAssertion: "REJECTED" })],
      review: [review({ cwid: "hc63", pmid: 100, status: "dismissed" })],
    });
    expect(people).toEqual([]);
  });

  it("one row per person and paper: confirmed beats pending beats review queue", () => {
    const { people } = attach({
      flagged: ["100", "200"],
      accepted: [accepted({ cwid: "abc2001", pmid: 100 })],
      pending: [
        pending({ cwid: "abc2001", pmid: 100, score: 99 }),
        pending({ cwid: "hc63", pmid: 200, score: 40 }),
        pending({ cwid: "hc63", pmid: 200, score: 88 }),
      ],
      review: [review({ cwid: "hc63", pmid: 200, score: 10 })],
    });
    expect(people.map((p) => [p.articleId, p.cwid, p.attribution, p.reciterScore, p.inReviewQueue])).toEqual([
      ["100", "abc2001", "confirmed", null, false],
      // Still one row, still the suggestion's score, and the queue row is kept
      // as a fact: it is what makes this priority 2 (score under 90).
      ["200", "hc63", "pending", 88, true],
    ]);
  });

  it("inReviewQueue: true for a queue row, false for a suggestion with none, never for a confirmed person", () => {
    const { people } = attach({
      flagged: ["100", "200", "300"],
      accepted: [accepted({ cwid: "abc2001", pmid: 100 })],
      pending: [pending({ cwid: "abc2001", pmid: 200, score: 40 })],
      review: [review({ cwid: "abc2001", pmid: 100 }), review({ cwid: "hc63", pmid: 300 })],
    });
    expect(people.map((p) => [p.articleId, p.attribution, p.inReviewQueue])).toEqual([
      ["100", "confirmed", false],
      ["200", "pending", false],
      ["300", "review_queue", true],
    ]);
  });

  it("drops every row for an article with no match and no funding flag", () => {
    const { people } = attach({ flagged: ["100"], accepted: [accepted({ cwid: "abc2001", pmid: 999 })] });
    expect(people).toEqual([]);
  });

  it("denormalizes the person: name, department, title; literal 'NULL' strings are empty", () => {
    const { people } = attach({
      flagged: ["100"],
      accepted: [accepted({ cwid: "abc2001", pmid: 100 }), accepted({ cwid: "xyz9", pmid: 100 }), accepted({ cwid: "new1", pmid: 100 })],
    });
    expect(people[0]).toMatchObject({ displayName: "Ann Chen", department: "Medicine", title: "Professor" });
    expect(people[1]).toMatchObject({ cwid: "xyz9", displayName: "xyz9", firstName: null, lastName: null });
    // No `person` row at all: still listed, under the id.
    expect(people[2]).toMatchObject({ cwid: "new1", displayName: "new1", campus: "wcm" });
  });

  it("an open review row with no proposed person is kept under its byline name", () => {
    const { people } = attach({
      flagged: ["300"],
      review: [
        review({ pmid: 300, author: "Li Wei", affiliation: "Cornell University, Ithaca, NY" }),
        review({ pmid: 300, author: null }),
      ],
    });
    expect(people).toEqual([
      expect.objectContaining({
        cwid: null,
        displayName: "Li Wei",
        campus: "unknown",
        attribution: "review_queue",
        inReviewQueue: true,
      }),
    ]);
  });

  describe("a review row with no proposed person, on a paper that already lists people", () => {
    it("is not a second row for someone already confirmed, under the byline spelling", () => {
      for (const author of ["Chen A", "Ann Chen", "Chen, Ann", "A. Chen"]) {
        const { people } = attach({
          flagged: ["100"],
          accepted: [accepted({ cwid: "abc2001", pmid: 100 })],
          review: [review({ pmid: 100, author })],
        });
        expect(people.map((p) => [p.cwid, p.attribution, p.inReviewQueue])).toEqual([["abc2001", "confirmed", false]]);
      }
    });

    it("folds onto a pending person and marks them as in the queue", () => {
      const { people } = attach({
        flagged: ["100"],
        pending: [pending({ cwid: "hc63", pmid: 100, score: 35 })],
        review: [review({ pmid: 100, author: "Chiang H" })],
      });
      expect(people.map((p) => [p.cwid, p.attribution, p.reciterScore, p.inReviewQueue])).toEqual([
        ["hc63", "pending", 35, true],
      ]);
    });

    it("is kept when the byline is someone else, or the listed person has no known name", () => {
      const { people } = attach({
        flagged: ["100", "200"],
        accepted: [accepted({ cwid: "abc2001", pmid: 100 }), accepted({ cwid: "new1", pmid: 200 })],
        review: [
          review({ pmid: 100, author: "Chen B" }), // other initial
          review({ pmid: 100, author: "Cheng A" }), // other surname
          review({ pmid: 200, author: "Chen A" }), // new1 has no person row
        ],
      });
      expect(people.filter((p) => p.cwid === null).map((p) => [p.articleId, p.displayName])).toEqual([
        ["100", "Chen B"],
        ["100", "Cheng A"],
        ["200", "Chen A"],
      ]);
    });

    it("does not depend on the order of the review rows", () => {
      const { people } = attach({
        flagged: ["100"],
        review: [review({ pmid: 100, author: "Chiang H" }), review({ cwid: "hc63", pmid: 100, score: 60 })],
      });
      expect(people.map((p) => [p.cwid, p.attribution])).toEqual([["hc63", "review_queue"]]);
    });
  });
});

describe("name keys: reciterdb's is_our_author, ported", () => {
  const keys = (first: string, last: string) => [nameKey(first, last)!];

  it("the key is the full given name, letters only", () => {
    expect(nameKey("Yi-Ming", "Wang")).toEqual(["wang", "yiming"]);
    expect(nameKey("Yi Ming", "Wang")).toEqual(nameKey("Yiming", "Wang"));
    expect(nameKey("José", "van der Berg")).toEqual(["vanderberg", "jose"]);
    expect(nameKey("", "Wang")).toBeNull();
    expect(nameKey("Yi", null)).toBeNull();
  });

  it("matches the docstring's cases", () => {
    expect(isOurAuthor("Bruce R Schackman", keys("Bruce", "Schackman"))).toBe(true);
    expect(isOurAuthor("Jan van der Berg", keys("Jan", "van der Berg"))).toBe(true);
    expect(isOurAuthor("Yi Ming Wang", keys("Yi", "Wang"))).toBe(false);
    expect(isOurAuthor("B Schackman", keys("Bruce", "Schackman"))).toBe(false);
    expect(isOurAuthor("B R Schackman", keys("Bruce", "Schackman"))).toBe(false);
  });

  it("given names are compared whole: spacing, hyphens and accents aside", () => {
    expect(isOurAuthor("Yiming Wang", keys("Yi Ming", "Wang"))).toBe(true);
    expect(isOurAuthor("Yi-Ming Wang", keys("Yiming", "Wang"))).toBe(true);
    expect(isOurAuthor("Yi Ming Wang", keys("Yi-Ming", "Wang"))).toBe(true);
    expect(isOurAuthor("Guóqiang M. Xu", keys("Guoqiang", "Xu"))).toBe(true);
    expect(isOurAuthor("Guoqiang Xue", keys("Guoqiang", "Xu"))).toBe(false);
    expect(isOurAuthor("Xu", keys("Guoqiang", "Xu"))).toBe(false);
    expect(isOurAuthor(null, keys("Guoqiang", "Xu"))).toBe(false);
    expect(isOurAuthor("Guoqiang Xu", [])).toBe(false);
  });

  it("a person has every key from person AND identity, so the publishing name counts", () => {
    const byCwid = nameKeysByCwid([
      { cwid: "ABC1 ", first: "Katherine", last: "Smith-Jones" }, // person: HR legal name
      { cwid: "abc1", first: "Kate", last: "Smith" }, // identity: publishing name
      { cwid: "abc1", first: "Kate", last: "Smith" },
      { cwid: "abc1", first: "NULL", last: "Smith" },
      { cwid: null, first: "No", last: "Body" },
    ]);
    expect(byCwid.get("abc1")).toEqual([
      ["smithjones", "katherine"],
      ["smith", "kate"],
    ]);
    expect(ourAuthorCwids("Kate Smith", ["abc1"], byCwid)).toEqual(["abc1"]);
    expect(ourAuthorCwids("Katherine Smith-Jones", ["abc1"], byCwid)).toEqual(["abc1"]);
    expect(ourAuthorCwids("Kate Smith-Jones", ["abc1"], byCwid)).toEqual([]);
  });

  it("names WHICH of the people on the article the co-author is", () => {
    const byCwid = nameKeysByCwid([
      { cwid: "yw1", first: "Yi", last: "Wang" },
      { cwid: "ymw2", first: "Yi Ming", last: "Wang" },
      { cwid: "w3", first: "Wei", last: "Zhang" },
    ]);
    expect(ourAuthorCwids("Yi Ming Wang", ["yw1", "ymw2", "w3"], byCwid)).toEqual(["ymw2"]);
    expect(ourAuthorCwids("Yi Wang", ["yw1", "ymw2", "w3"], byCwid)).toEqual(["yw1"]);
    // Only people attached to the article are asked about.
    expect(ourAuthorCwids("Wei Zhang", ["yw1"], byCwid)).toEqual([]);
    expect(ourAuthorCwids("Wei Zhang", ["W3"], byCwid)).toEqual(["W3"]);
  });

  it("the stored list holds whole ids only", () => {
    expect(joinCwids([])).toBeNull();
    expect(joinCwids(["a1", "b2"])).toBe("a1,b2");
    expect(joinCwids(["abc1", "def2", "ghi3"], 9)).toBe("abc1,def2");
  });

  it("the byline check for unnamed review rows is surname plus first initial, either order", () => {
    const k = keys("Jane", "Doe");
    for (const b of ["Doe J", "Jane Doe", "Doe, Jane", "J. Doe", "Jane Q Doe"]) expect(bylineCouldBe(b, k)).toBe(true);
    for (const b of ["Doe", "Roe J", "Doe K", "Kim Doe", null]) expect(bylineCouldBe(b, k)).toBe(false);
  });
});

describe("the stable article key", () => {
  it("is the pmid for a PubMed article", () => {
    expect(articleKey({ pmid: 42527780, articleId: "SCOPUS:1" })).toBe("42527780");
  });

  it("is never the negative pmid of a non-PubMed article", () => {
    expect(articleKey({ pmid: -1234, articleId: "SCOPUS:85123" })).toBe("SCOPUS:85123");
    expect(articleKey({ pmid: -1234 })).toBeNull();
    expect(articleKey({ pmid: 0, doi: "10.1/x" })).toBe("DOI:10.1/x");
  });

  it("a review row gets the id it will have once accepted, else DOI:<doi>", () => {
    expect(articleKey({ pmid: null, source: "scopus", externalId: "85123" })).toBe("SCOPUS:85123");
    expect(articleKey({ pmid: null, source: "pubmed", externalId: "x", doi: "https://doi.org/10.1/AbC" })).toBe(
      "DOI:10.1/abc",
    );
    expect(normDoi(" DOI: 10.5/Z ")).toBe("10.5/z");
  });

  it("joins a non-PubMed article on article_id, case-insensitively, keeping the match table's spelling", () => {
    const { people } = attach({
      flagged: ["SCOPUS:85123"],
      accepted: [accepted({ cwid: "hc63", pmid: -77, articleId: "scopus:85123" })],
    });
    expect(people.map((p) => p.articleId)).toEqual(["SCOPUS:85123"]);
  });

  it("a review row known only by DOI lands on the flagged article with that DOI", () => {
    const { people } = attach({
      flagged: ["OPENALEX:W1"],
      accepted: [accepted({ cwid: "hc63", pmid: -5, articleId: "OPENALEX:W1", doi: "10.9/q" })],
      review: [review({ cwid: "abc2001", source: "pubmed", doi: "10.9/Q" })],
    });
    expect(people.map((p) => [p.articleId, p.cwid, p.attribution])).toEqual([
      ["OPENALEX:W1", "hc63", "confirmed"],
      ["OPENALEX:W1", "abc2001", "review_queue"],
    ]);
  });

  describe("a row keyed only by DOI:<doi> folds as reciterdb's build_scope does", () => {
    it("when the article that carries the DOI is read AFTER it (accepted before pending)", () => {
      // An accepted external authorship with a negative pmid and no article_id
      // is keyed DOI:10.7/x; the pending person_article row for pmid 123 has
      // the same DOI. reciterdb stores the match rows under '123'.
      const { people } = attach({
        flagged: ["123"],
        accepted: [accepted({ cwid: "abc2001", pmid: -9, doi: "10.7/X" })],
        pending: [pending({ cwid: "hc63", pmid: 123, doi: "https://doi.org/10.7/x", score: 70 })],
      });
      expect(people.map((p) => [p.articleId, p.cwid, p.attribution])).toEqual([
        ["123", "abc2001", "confirmed"],
        ["123", "hc63", "pending"],
      ]);
    });

    it("when the target is named only by a review row", () => {
      const { people } = attach({
        flagged: ["SCOPUS:77"],
        accepted: [accepted({ cwid: "abc2001", pmid: -9, doi: "10.7/x" })],
        review: [review({ cwid: "hc63", source: "scopus", externalId: "77", doi: "10.7/X" })],
      });
      expect(people.map((p) => [p.articleId, p.cwid, p.attribution])).toEqual([
        ["SCOPUS:77", "abc2001", "confirmed"],
        ["SCOPUS:77", "hc63", "review_queue"],
      ]);
    });

    it("a DOI key with no other article for that DOI stays its own article", () => {
      const { people } = attach({
        flagged: ["DOI:10.7/x"],
        accepted: [accepted({ cwid: "abc2001", pmid: -9, doi: "10.7/x" })],
      });
      expect(people.map((p) => p.articleId)).toEqual(["DOI:10.7/x"]);
    });

    it("rows that attach nobody (rejected, closed) do not supply a fold target", () => {
      const { people } = attach({
        flagged: ["123", "DOI:10.7/x"],
        accepted: [accepted({ cwid: "abc2001", pmid: -9, doi: "10.7/x" })],
        pending: [pending({ cwid: "hc63", pmid: 123, doi: "10.7/x", userAssertion: "REJECTED" })],
        review: [review({ cwid: "hc63", pmid: 123, doi: "10.7/x", status: "dismissed" })],
      });
      expect(people.map((p) => [p.articleId, p.cwid])).toEqual([["DOI:10.7/x", "abc2001"]]);
    });
  });

  it("names the source from the id", () => {
    expect(sourceOf("42527780")).toBe("pubmed");
    expect(sourceOf("SCOPUS:1")).toBe("scopus");
    expect(sourceOf("OPENALEX:W1")).toBe("openalex");
    expect(sourceOf("DOI:10.1/x")).toBe("other");
  });
});

describe("article rows", () => {
  const now = new Date("2026-11-17T08:00:00Z");

  it("takes facts from the article tables and the author count from the state table", () => {
    const [a] = buildArticles(
      ["100"],
      new Map([["100", { pmid: 100, articleId: null, title: "T", journal: "J", publicationDate: "2024-03-05", publicationType: "Academic Article", doi: "10.1/A" }]]),
      new Map(),
      new Map([["100", 61]]),
      now,
    );
    expect(a).toMatchObject({ articleId: "100", pmid: 100, title: "T", totalAuthors: 61, doi: "10.1/a", source: "pubmed" });
    expect(a.publicationDate?.toISOString()).toBe("2024-03-05T00:00:00.000Z");
  });

  it("falls back to the review row for a paper only the queue knows", () => {
    const [a] = buildArticles(
      ["SCOPUS:9"],
      new Map(),
      new Map([["SCOPUS:9", { title: "R", journal: "RJ", pubType: "Article", entrezDate: new Date("2025-01-02T00:00:00Z"), doi: null }]]),
      new Map(),
      now,
    );
    expect(a).toMatchObject({ articleId: "SCOPUS:9", pmid: null, title: "R", journal: "RJ", totalAuthors: 0, source: "scopus" });
    expect(a.publicationDate?.toISOString().slice(0, 10)).toBe("2025-01-02");
  });

  it("parses partial and bad dates", () => {
    expect(toDate("2023")?.toISOString().slice(0, 10)).toBe("2023-01-01");
    expect(toDate("2023-07")?.toISOString().slice(0, 10)).toBe("2023-07-01");
    expect(toDate("NULL")).toBeNull();
    expect(toDate("0000-00-00")).toBeNull();
    expect(toDate(null)).toBeNull();
  });
});

describe("empty-source guard", () => {
  afterEach(() => {
    delete process.env.ETL_GUARD_BYPASS;
  });

  it("passes a normal night", () => {
    expect(() =>
      assertPlausibleSource({ sourceMatchRows: 85_000, builtArticles: 20_000, existingArticles: 19_800 }),
    ).not.toThrow();
  });

  it("passes the first load into empty tables", () => {
    expect(() =>
      assertPlausibleSource({ sourceMatchRows: 85_000, builtArticles: 20_000, existingArticles: 0 }),
    ).not.toThrow();
  });

  it("refuses an empty match table (mid-rebuild, or never loaded)", () => {
    expect(() =>
      assertPlausibleSource({ sourceMatchRows: 0, builtArticles: 0, existingArticles: 20_000 }),
    ).toThrow(EtlGuardError);
    expect(() => assertPlausibleSource({ sourceMatchRows: 0, builtArticles: 0, existingArticles: 0 })).toThrow(
      EtlGuardError,
    );
  });

  it("refuses an implausibly small match table", () => {
    expect(() =>
      assertPlausibleSource({
        sourceMatchRows: MIN_SOURCE_MATCH_ROWS - 1,
        builtArticles: 400,
        existingArticles: 0,
      }),
    ).toThrow(/below the 1000 floor/);
  });

  it("refuses when no article has a person attached (the authorship tables were empty)", () => {
    expect(() =>
      assertPlausibleSource({ sourceMatchRows: 85_000, builtArticles: 0, existingArticles: 0 }),
    ).toThrow(EtlGuardError);
  });

  it("refuses to replace the copy with one less than half its size", () => {
    expect(() =>
      assertPlausibleSource({ sourceMatchRows: 85_000, builtArticles: 9_000, existingArticles: 20_000 }),
    ).toThrow(/drop/);
  });
});
