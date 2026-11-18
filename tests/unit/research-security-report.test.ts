/**
 * `lib/api/research-security-report.ts` — the count rules every view shares,
 * the not-yet-attributed priority, and the loader's SQL narrowing.
 *
 *   1. A confirmed count never includes a pending or review-queue row.
 *   2. Country of concern is its own tier, read only when that list is selected.
 *   3. A paper already confirmed for one author is not also not-yet-attributed.
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildEntityRows,
  buildFundingRows,
  buildPaperRows,
  buildPersonRows,
  buildSummary,
  buildUnattributedRows,
  attributionReason,
  candidateListsEntity,
  countUnattributedPapers,
  forConfirmedAuthors,
  listedBy,
  loadMatchedStrings,
  loadResearchSecurityFacts,
  paginate,
  unattributedPriority,
  type MatchedString,
  type ArticleFact,
  type FlagFact,
  type MatchFact,
  type PersonFact,
  type ResearchSecurityClient,
  type ResearchSecurityFacts,
} from "@/lib/api/research-security-report";
import {
  LIST_COUNTRY,
  LIST_HOUSE,
  LIST_USUAL,
  parseResearchSecurityParams,
} from "@/lib/edit/research-security-dashboard";

const article = (articleId: string, o: Partial<ArticleFact> = {}): ArticleFact => ({
  articleId,
  pmid: /^\d+$/.test(articleId) ? Number(articleId) : null,
  title: `Title ${articleId}`,
  journal: "Journal",
  publicationDate: new Date("2024-01-01T00:00:00Z"),
  publicationType: "Academic Article",
  totalAuthors: 8,
  doi: null,
  source: "pubmed",
  ...o,
});
const person = (articleId: string, cwid: string, o: Partial<PersonFact> = {}): PersonFact => ({
  articleId,
  cwid,
  displayName: `Name ${cwid}`,
  firstName: "Name",
  lastName: cwid,
  campus: "wcm",
  department: "Medicine",
  title: "Professor",
  attribution: "confirmed",
  inReviewQueue: o.attribution === "review_queue",
  reciterScore: null,
  ...o,
});
const match = (articleId: string, entity: string, o: Partial<MatchFact> = {}): MatchFact => ({
  articleId,
  listCode: LIST_HOUSE,
  category: "SASTIND university",
  listNo: 1,
  entity,
  authorRank: 1,
  authorName: "Co Author",
  isInstitutionAuthor: false,
  ourAuthorCwids: null,
  ...o,
});

function facts(o: {
  articles: ArticleFact[];
  people: PersonFact[];
  matches?: MatchFact[];
  flags?: FlagFact[];
}): ResearchSecurityFacts {
  return {
    articles: new Map(o.articles.map((a) => [a.articleId, a])),
    people: o.people,
    matches: o.matches ?? [],
    flags: o.flags ?? [],
    dataAsOf: new Date("2026-11-17T08:00:00Z"),
  };
}

/**
 * 1: confirmed WCM.  2: confirmed Ithaca + pending WCM (already confirmed).
 * 3: pending only.   4: review-queue only, 60 authors.  5: funding flag only, confirmed.
 */
const base = facts({
  articles: [article("1"), article("2"), article("3"), article("4", { totalAuthors: 60 }), article("5")],
  people: [
    person("1", "w1"),
    person("2", "i1", { campus: "ithaca" }),
    person("2", "w2", { attribution: "pending", reciterScore: 95 }),
    person("3", "w3", { attribution: "pending", reciterScore: 50 }),
    person("4", "w4", { attribution: "review_queue" }),
    person("5", "w1"),
  ],
  matches: [
    match("1", "Peking University"),
    match("1", "Peking University", { authorName: "Second Author", authorRank: 2 }),
    match("2", "Peking University"),
    match("2", "Zhejiang University", { listNo: 58 }),
    match("3", "Peking University"),
    match("4", "Zhejiang University", { listNo: 58 }),
  ],
  flags: [
    { articleId: "5", program: "China Scholarship Council (CSC)", agency: "CSC", grantId: "2023" },
    { articleId: "3", program: "Qiming Plan", agency: null, grantId: null },
  ],
});

describe("rule 1: confirmed counts never include pending or review-queue rows", () => {
  it("By entity counts confirmed papers and people only", () => {
    const rows = buildEntityRows(base, "both");
    const peking = rows.find((r) => r.entity === "Peking University")!;
    // Papers 1 and 2 are confirmed; paper 3 (pending only) is not a co-publication.
    expect(peking.papers).toBe(2);
    expect(peking.people).toBe(2); // w1, i1 — never w2 or w3
    expect(peking.papersWcm).toBe(1);
    expect(peking.papersIthaca).toBe(1);
    const zhejiang = rows.find((r) => r.entity === "Zhejiang University")!;
    expect(zhejiang.papers).toBe(1); // paper 2; paper 4 is review-queue only
    expect(zhejiang.papersExcludingConsortia).toBe(1);
  });

  it("By person lists only confirmed people", () => {
    expect(buildPersonRows(base, "both").map((r) => [r.cwid, r.papers])).toEqual([
      ["i1", 1],
      ["w1", 1],
    ]);
  });

  it("By paper lists only confirmed papers and only confirmed authors", () => {
    const rows = buildPaperRows(base, "both");
    expect(rows.map((r) => r.article.articleId).sort()).toEqual(["1", "2"]);
    const two = rows.find((r) => r.article.articleId === "2")!;
    expect(two.ithacaAuthors).toEqual(["Name i1 (i1)"]);
    expect(two.wcmAuthors).toEqual([]); // w2 is pending
    expect(two.entities).toEqual(["Peking University", "Zhejiang University"]);
  });

  it("Funding flags lists only papers with a confirmed author", () => {
    const rows = buildFundingRows(base, "both");
    expect(rows.map((r) => [r.article.articleId, r.program])).toEqual([
      ["5", "China Scholarship Council (CSC)"],
    ]);
  });

  it("the headline keeps the tiers apart", () => {
    expect(buildSummary(base, { campus: "both", list: "entities" })).toEqual({
      tier: "entity",
      coPublications: 2,
      coPublicationsExcludingConsortia: 2,
      people: 2,
      entities: 2,
      fundingFlagPapers: 1,
      unattributedPapers: 2,
    });
  });

  it("the campus filter narrows confirmed people, and a paper needs one in the campus", () => {
    expect(buildPaperRows(base, "wcm").map((r) => r.article.articleId)).toEqual(["1"]);
    expect(buildPaperRows(base, "ithaca").map((r) => r.article.articleId)).toEqual(["2"]);
    expect(buildPersonRows(base, "ithaca").map((r) => r.cwid)).toEqual(["i1"]);
    expect(buildEntityRows(base, "ithaca").find((r) => r.entity === "Peking University")!.papers).toBe(1);
    expect(buildFundingRows(base, "ithaca")).toEqual([]);
  });
});

describe("rule 3: a paper confirmed for one author is not also not-yet-attributed", () => {
  const rows = buildUnattributedRows(base, "both");

  it("the pending row on a confirmed paper is shown, marked, and not counted", () => {
    const w2 = rows.find((r) => r.person.cwid === "w2")!;
    expect(w2.alreadyConfirmed).toBe(true);
    expect(rows.filter((r) => !r.alreadyConfirmed).map((r) => r.article.articleId).sort()).toEqual(["3", "4"]);
    expect(countUnattributedPapers(rows)).toBe(2);
  });

  it("By entity's not-yet-attributed columns leave that paper out", () => {
    const entity = buildEntityRows(base, "both");
    const peking = entity.find((r) => r.entity === "Peking University")!;
    expect(peking.unattributedPapers).toBe(1); // paper 3, not paper 2
    expect(peking.unattributedPriority12).toBe(0); // score 50 → priority 3
    const zhejiang = entity.find((r) => r.entity === "Zhejiang University")!;
    expect(zhejiang.unattributedPapers).toBe(1); // paper 4
    expect(zhejiang.unattributedPriority12).toBe(0); // consortium → priority 4
  });

  it("confirmed on the OTHER campus still counts as confirmed", () => {
    // Paper 2 is confirmed for an Ithaca author; filtering to WCM must not turn
    // its pending WCM row into a not-yet-attributed paper.
    const wcm = buildUnattributedRows(base, "wcm");
    expect(wcm.find((r) => r.person.cwid === "w2")!.alreadyConfirmed).toBe(true);
    expect(countUnattributedPapers(wcm)).toBe(2);
  });

  it("a paper with no match in the selected list is not listed at all", () => {
    const f = facts({
      articles: [article("9")],
      people: [person("9", "w9", { attribution: "pending", reciterScore: 99 })],
      flags: [{ articleId: "9", program: "Qiming Plan", agency: null, grantId: null }],
    });
    expect(buildUnattributedRows(f, "both")).toEqual([]);
  });

  it("sorts by priority, then score", () => {
    expect(rows.map((r) => [r.person.cwid, r.priority])).toEqual([
      ["w2", 2],
      ["w3", 3],
      ["w4", 4],
    ]);
  });
});

describe("rule 2: country of concern is its own tier", () => {
  it("the loader asks for the entity lists by default and never the country list", async () => {
    const client = fakeClient();
    await loadResearchSecurityFacts(client, parseResearchSecurityParams({}).filters);
    const where = client.researchSecurityMatch.findMany.mock.calls[0][0].where;
    expect(where.listCode).toEqual({ in: [LIST_HOUSE, LIST_USUAL] });
  });

  it("the loader asks for the country list alone when it is selected", async () => {
    const client = fakeClient();
    await loadResearchSecurityFacts(client, parseResearchSecurityParams({ list: LIST_COUNTRY }).filters);
    const where = client.researchSecurityMatch.findMany.mock.calls[0][0].where;
    expect(where.listCode).toEqual({ in: [LIST_COUNTRY] });
  });

  it("with country matches loaded, the headline says so and counts them alone", () => {
    const f = facts({
      articles: [article("1"), article("2")],
      people: [person("1", "w1"), person("2", "w2")],
      matches: [
        match("1", "China", { listCode: LIST_COUNTRY, category: "Country", listNo: null }),
        match("2", "Russia", { listCode: LIST_COUNTRY, category: "Country", listNo: null }),
      ],
    });
    const s = buildSummary(f, { campus: "both", list: LIST_COUNTRY });
    expect(s.tier).toBe("country");
    expect(s.coPublications).toBe(2);
    expect(s.entities).toBe(2);
  });

  it("an entity and a country sharing a name stay separate rows", () => {
    const f = facts({
      articles: [article("1")],
      people: [person("1", "w1")],
      matches: [match("1", "China"), match("1", "China", { listCode: LIST_COUNTRY, category: "Country" })],
    });
    // Tied on every count and on the name: list code is the last tie-breaker.
    expect(buildEntityRows(f, "both").map((r) => [r.listCode, r.papers])).toEqual([
      [LIST_COUNTRY, 1],
      [LIST_HOUSE, 1],
    ]);
  });
});

describe("the loader narrows in SQL", () => {
  it("date range (default 2021-01-01 onward), consortium size and category", async () => {
    const client = fakeClient();
    await loadResearchSecurityFacts(
      client,
      parseResearchSecurityParams({ to: "2024-12-31", consortia: "exclude", category: "CAS institute" }).filters,
    );
    const where = client.researchSecurityMatch.findMany.mock.calls[0][0].where;
    expect(where.category).toBe("CAS institute");
    expect(where.article).toEqual({
      publicationDate: { gte: new Date("2021-01-01T00:00:00Z"), lte: new Date("2024-12-31T00:00:00Z") },
      totalAuthors: { lt: 50 },
    });
    // People are loaded for both campuses: "already confirmed" is a both-campus fact.
    expect(client.researchSecurityPerson.findMany.mock.calls[0][0].where).not.toHaveProperty("campus");
  });

  it("never selects the affiliation text in the bulk load", async () => {
    const client = fakeClient();
    await loadResearchSecurityFacts(client, parseResearchSecurityParams({}).filters);
    expect(client.researchSecurityMatch.findMany.mock.calls[0][0].select).not.toHaveProperty("affiliation");
  });

  it("loads matched strings for the given papers only, and none for no papers", async () => {
    const client = fakeClient();
    const f = parseResearchSecurityParams({}).filters;
    expect(await loadMatchedStrings(client, [], f)).toEqual([]);
    expect(client.researchSecurityMatch.findMany).not.toHaveBeenCalled();
    await loadMatchedStrings(client, ["1", "2"], f);
    expect(client.researchSecurityMatch.findMany.mock.calls[0][0].where).toMatchObject({
      articleId: { in: ["1", "2"] },
      listCode: { in: [LIST_HOUSE, LIST_USUAL] },
    });
  });
});

describe("unattributedPriority", () => {
  const p = (o: Partial<Parameters<typeof unattributedPriority>[0]>) =>
    unattributedPriority({ totalAuthors: 8, candidateListsEntity: false, attribution: "pending", reciterScore: 50, ...o });

  it("4 = 50+ author consortium, before everything else", () => {
    expect(p({ totalAuthors: 50, candidateListsEntity: true, reciterScore: 100 })).toBe(4);
    expect(p({ totalAuthors: 49, candidateListsEntity: true })).toBe(1);
  });
  it("1 = the candidate also lists the entity", () => {
    expect(p({ candidateListsEntity: true, reciterScore: 10 })).toBe(1);
  });
  it("2 = score >= 90, or a review-queue row", () => {
    expect(p({ reciterScore: 90 })).toBe(2);
    expect(p({ reciterScore: 89.99 })).toBe(3);
    expect(p({ attribution: "review_queue", reciterScore: null })).toBe(2);
  });
  it("2 = a pending suggestion under 90 that ALSO has an open review-queue row", () => {
    expect(p({ attribution: "pending", reciterScore: 40, inReviewQueue: true })).toBe(2);
    expect(p({ attribution: "pending", reciterScore: 40, inReviewQueue: false })).toBe(3);
  });
  it("3 = otherwise", () => {
    expect(p({})).toBe(3);
    expect(p({ reciterScore: null })).toBe(3);
  });
  it("unknown author count (0) is not a consortium", () => {
    expect(p({ totalAuthors: 0, reciterScore: 95 })).toBe(2);
  });
});

describe("candidate also lists the entity", () => {
  const guo = person("1", "gux2002", { displayName: "Guoqiang Xu", firstName: "Guoqiang", lastName: "Xu" });
  const soochow = (o: Partial<MatchFact> = {}) =>
    match("1", "Soochow University", { authorName: "Guoqiang Xu", isInstitutionAuthor: true, ...o });

  it("is the ETL's verdict (ourAuthorCwids), never a name compared again here", () => {
    // reciterdb's bit alone does not say WHO: nobody is named, so nobody is it.
    expect(candidateListsEntity(guo, [soochow()])).toBe(false);
    expect(candidateListsEntity(guo, [soochow({ ourAuthorCwids: "gux2002" })])).toBe(true);
    expect(candidateListsEntity(guo, [soochow({ ourAuthorCwids: "abc1,GUX2002" })])).toBe(true);
    // Same displayed name, someone else's id: the ETL decided it is not them.
    expect(candidateListsEntity(guo, [soochow({ ourAuthorCwids: "xug9001" })])).toBe(false);
    // "Yi Ming Wang" on the byline, candidate "Yi Wang": the names look alike,
    // the ETL (reciterdb's rule) said no, and that is the answer.
    const yi = person("1", "yiw2001", { displayName: "Yi Wang", firstName: "Yi", lastName: "Wang" });
    expect(candidateListsEntity(yi, [soochow({ authorName: "Yi Ming Wang", ourAuthorCwids: "ymw2002" })])).toBe(false);
    // The reverse: person "Yi Ming" / byline "Yiming Wang" is them when the ETL says so.
    const yiming = person("1", "ymw2002", { displayName: "Yi Ming Wang", firstName: "Yi Ming", lastName: "Wang" });
    expect(candidateListsEntity(yiming, [soochow({ authorName: "Yiming Wang", ourAuthorCwids: "ymw2002" })])).toBe(true);
  });

  it("a person with no id is never the one", () => {
    expect(listedBy(soochow({ ourAuthorCwids: "gux2002" }), [{ cwid: null }])).toBe(false);
    expect(listedBy(soochow({ ourAuthorCwids: null }), [{ cwid: "gux2002" }])).toBe(false);
  });

  it("drives priority 1 in the built rows", () => {
    const f = facts({
      articles: [article("1")],
      people: [{ ...guo, attribution: "pending", reciterScore: 100 }],
      matches: [soochow({ ourAuthorCwids: "gux2002" })],
    });
    expect(buildUnattributedRows(f, "both")[0]).toMatchObject({ priority: 1, candidateListsEntity: true });
    expect(buildEntityRows(f, "both")[0]).toMatchObject({ papers: 0, unattributedPapers: 1, unattributedPriority12: 1 });
  });

  it("priority 1 goes to the candidate whose name it is, not to everyone on the paper", () => {
    const f = facts({
      articles: [article("1")],
      people: [
        { ...guo, attribution: "pending", reciterScore: 30 },
        person("1", "w7", { attribution: "pending", reciterScore: 30 }),
      ],
      matches: [soochow({ ourAuthorCwids: "gux2002" })],
    });
    expect(buildUnattributedRows(f, "both").map((r) => [r.person.cwid, r.priority])).toEqual([
      ["gux2002", 1],
      ["w7", 3],
    ]);
  });
});

describe("a pending suggestion that is also in the review queue is priority 2", () => {
  const f = facts({
    articles: [article("1"), article("2")],
    people: [
      person("1", "hc63", { attribution: "pending", reciterScore: 40, inReviewQueue: true }),
      person("2", "w3", { attribution: "pending", reciterScore: 40 }),
    ],
    matches: [match("1", "Peking University"), match("2", "Peking University")],
  });

  it("in the rows", () => {
    expect(buildUnattributedRows(f, "both").map((r) => [r.person.cwid, r.priority])).toEqual([
      ["hc63", 2],
      ["w3", 3],
    ]);
  });

  it("in By entity's priority 1-2 column", () => {
    expect(buildEntityRows(f, "both")[0]).toMatchObject({ unattributedPapers: 2, unattributedPriority12: 1 });
  });

  it("and the reason says both", () => {
    expect(attributionReason({ attribution: "pending", inReviewQueue: true })).toMatch(/also in the authorship-review queue/);
    expect(attributionReason({ attribution: "pending", inReviewQueue: false })).toBe("ReCiter suggestion, not yet reviewed");
    expect(attributionReason({ attribution: "review_queue", inReviewQueue: true })).toBe("Open authorship-review queue row");
  });
});

describe("'our author lists the entity' is about CONFIRMED authors in the campus filter", () => {
  // Paper 1: confirmed WCM author w1. reciterdb set is_institution_author for
  // the co-author "Wei Zhang" at Harbin because an UNREVIEWED suggestion for
  // WCM person wz9 (Wei Zhang) is in scope on the paper. Nobody confirmed
  // lists the entity.
  const namesake = facts({
    articles: [article("1")],
    people: [
      person("1", "w1"),
      person("1", "wz9", { displayName: "Wei Zhang", firstName: "Wei", lastName: "Zhang", attribution: "pending", reciterScore: 12 }),
    ],
    matches: [
      match("1", "Harbin Institute of Technology", { authorName: "Wei Zhang", isInstitutionAuthor: true, ourAuthorCwids: "wz9" }),
    ],
  });

  it("a pending namesake does not mark a confirmed paper", () => {
    expect(buildPaperRows(namesake, "both")[0].ourAuthorListsEntity).toBe(false);
    expect(buildEntityRows(namesake, "both")[0]).toMatchObject({ papers: 1, papersOurAuthorListsEntity: 0 });
    // It is still what makes the candidate priority 1 in the other view.
    expect(buildUnattributedRows(namesake, "both")[0]).toMatchObject({ priority: 1, alreadyConfirmed: true });
  });

  it("a confirmed author with the co-author's name does", () => {
    const f = facts({
      ...namesake,
      articles: [article("1")],
      people: [person("1", "wz9", { displayName: "Wei Zhang" })],
      matches: namesake.matches,
    });
    expect(buildPaperRows(f, "both")[0].ourAuthorListsEntity).toBe(true);
    expect(buildEntityRows(f, "both")[0].papersOurAuthorListsEntity).toBe(1);
  });

  it("a confirmed author on the OTHER campus does not count under a campus filter", () => {
    const f = facts({
      articles: [article("1")],
      people: [person("1", "w1"), person("1", "iz9", { campus: "ithaca" })],
      matches: [match("1", "Harbin Institute of Technology", { isInstitutionAuthor: true, ourAuthorCwids: "iz9" })],
    });
    expect(buildPaperRows(f, "both")[0].ourAuthorListsEntity).toBe(true);
    expect(buildPaperRows(f, "ithaca")[0].ourAuthorListsEntity).toBe(true);
    expect(buildPaperRows(f, "wcm")[0].ourAuthorListsEntity).toBe(false);
    expect(buildEntityRows(f, "wcm")[0]).toMatchObject({ papers: 1, papersOurAuthorListsEntity: 0 });
  });

  it("is counted per entity: the flag on another entity's co-author does not carry over", () => {
    const f = facts({
      articles: [article("1")],
      people: [person("1", "w1")],
      matches: [
        match("1", "Harbin Institute of Technology", { isInstitutionAuthor: true, ourAuthorCwids: "w1" }),
        match("1", "Peking University", { authorRank: 2 }),
      ],
    });
    const rows = buildEntityRows(f, "both");
    expect(rows.find((r) => r.entity === "Peking University")!.papersOurAuthorListsEntity).toBe(0);
    expect(rows.find((r) => r.entity.startsWith("Harbin"))!.papersOurAuthorListsEntity).toBe(1);
  });

  it("the matched strings carry the same verdict as the paper row", () => {
    const strings: MatchedString[] = namesake.matches.map((m) => ({ ...m, affiliation: "Harbin Institute of Technology" }));
    expect(forConfirmedAuthors(strings, namesake, "both")[0].isInstitutionAuthor).toBe(false);
  });
});

describe("co-authors at listed entities", () => {
  it("counts byline positions, so two co-authors with one name are two and one author at two entities is one", () => {
    const f = facts({
      articles: [article("1")],
      people: [person("1", "w1")],
      matches: [
        match("1", "Peking University", { authorName: "Wei Wang", authorRank: 3 }),
        match("1", "Peking University", { authorName: "Wei Wang", authorRank: 7 }),
        match("1", "Zhejiang University", { authorName: "Wei Wang", authorRank: 7 }),
        match("1", "Zhejiang University", { authorName: null, authorRank: 9 }),
        match("1", "Peking University", { authorName: null, authorRank: 10 }),
      ],
    });
    expect(buildPaperRows(f, "both")[0].coAuthorsAtEntities).toBe(4);
  });
});

describe("every sort is total, so a page boundary never repeats or drops a row", () => {
  const shuffled = <T,>(rows: T[]) => [...rows].reverse();

  it("not yet attributed: two candidates on one paper with no score", () => {
    const people = [
      person("1", null as unknown as string, { cwid: null, displayName: "Li Wei", attribution: "review_queue" }),
      person("1", null as unknown as string, { cwid: null, displayName: "Chen Bo", attribution: "review_queue" }),
    ];
    const build = (p: PersonFact[]) =>
      buildUnattributedRows(facts({ articles: [article("1")], people: p, matches: [match("1", "Peking University")] }), "both").map(
        (r) => r.person.displayName,
      );
    expect(build(people)).toEqual(["Chen Bo", "Li Wei"]);
    expect(build(shuffled(people))).toEqual(["Chen Bo", "Li Wei"]);
  });

  it("by person: two people with one name and one count", () => {
    const people = [
      person("1", "b2", { displayName: "Wei Wang" }),
      person("1", "a1", { displayName: "Wei Wang" }),
    ];
    const build = (p: PersonFact[]) =>
      buildPersonRows(facts({ articles: [article("1")], people: p, matches: [match("1", "Peking University")] }), "both").map(
        (r) => r.cwid,
      );
    expect(build(people)).toEqual(["a1", "b2"]);
    expect(build(shuffled(people))).toEqual(["a1", "b2"]);
  });

  it("by entity: one name on two lists", () => {
    const matches = [match("1", "China", { listCode: LIST_USUAL }), match("1", "China")];
    const build = (m: MatchFact[]) =>
      buildEntityRows(facts({ articles: [article("1")], people: [person("1", "w1")], matches: m }), "both").map((r) => r.listCode);
    expect(build(matches)).toEqual([LIST_HOUSE, LIST_USUAL]);
    expect(build(shuffled(matches))).toEqual([LIST_HOUSE, LIST_USUAL]);
  });

  it("the loader reads people and matches in id order", async () => {
    const client = fakeClient();
    await loadResearchSecurityFacts(client, parseResearchSecurityParams({}).filters);
    expect(client.researchSecurityPerson.findMany.mock.calls[0][0].orderBy).toEqual({ id: "asc" });
    expect(client.researchSecurityMatch.findMany.mock.calls[0][0].orderBy).toEqual({ id: "asc" });
    expect(client.researchSecurityMatch.findMany.mock.calls[0][0].select).toMatchObject({
      authorRank: true,
      ourAuthorCwids: true,
    });
  });
});

describe("paginate", () => {
  it("slices one page and clamps the page number", () => {
    const rows = Array.from({ length: 120 }, (_, i) => i);
    expect(paginate(rows, 2, 50)).toMatchObject({ page: 2, totalPages: 3, total: 120 });
    expect(paginate(rows, 2, 50).rows[0]).toBe(50);
    expect(paginate(rows, 99, 50).page).toBe(3);
    expect(paginate([], 1, 50)).toMatchObject({ page: 1, totalPages: 1, rows: [] });
  });
});

function fakeClient() {
  const table = () => ({
    findMany: vi.fn<
      (args: {
        where: Record<string, unknown>;
        select?: Record<string, unknown>;
        orderBy?: unknown;
      }) => Promise<never[]>
    >(async () => []),
    aggregate: vi.fn(async () => ({ _max: { lastRefreshedAt: null } })),
  });
  const client = {
    researchSecurityArticle: table(),
    researchSecurityPerson: table(),
    researchSecurityMatch: table(),
    researchSecurityFundingFlag: table(),
  };
  return client as typeof client & ResearchSecurityClient;
}
