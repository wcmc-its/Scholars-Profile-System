/**
 * Method services, the unit's author names: how an entered name ("family name
 * then first initial") is compared with a PubMed author, the validation of the
 * list, the EFetch reader's author names, and the resumable check with names.
 * No network: `fetch` is injected. Made-up PMIDs, people and institutions only.
 */
import { describe, expect, it, vi } from "vitest";

import { authorNamesByPmid, fetchAuthorAffiliations } from "@/lib/edit/pubmed-affiliations";
import {
  carriedAffiliationProgress,
  classifyCoauthoredPmids,
  matchCoauthoredPmids,
  mergeAffiliationLookup,
  pmidsToCheck,
} from "@/lib/method-services/affiliation";
import {
  authorNameKey,
  pubmedAuthorKey,
  type PubMedAuthorName,
} from "@/lib/method-services/author-names";
import { validateAuthorNames } from "@/lib/method-services/validation";

const NAME = "Rivera Stone B";
const author = (lastName: string, initials: string): PubMedAuthorName => ({ lastName, initials });
/** Whether the entered name matches one PubMed author. */
const matches = (entry: string, lastName: string, initials: string) =>
  matchCoauthoredPmids(["101"], new Map([["101", []]]), [], new Map([["101", [author(lastName, initials)]]]), [
    entry,
  ]).length === 1;

describe("the name matcher", () => {
  it("matches the same family name and first initial", () => {
    expect(matches(NAME, "Rivera Stone", "B")).toBe(true);
  });

  it("matches multi-letter PubMed initials on the first one only", () => {
    expect(matches(NAME, "Rivera Stone", "BK")).toBe(true);
    expect(matches(NAME, "Rivera Stone", "K")).toBe(false);
    expect(matches(NAME, "Rivera Stone", "KB")).toBe(false);
  });

  it("reads the entry's own multi-letter initials by their first letter", () => {
    expect(matches("Rivera Stone BK", "Rivera Stone", "B")).toBe(true);
    expect(matches("Rivera Stone B K", "Rivera Stone", "BJ")).toBe(true);
    expect(matches("Rivera Stone B.K.", "Rivera Stone", "B")).toBe(true);
    expect(matches("Rivera Stone B.", "Rivera Stone", "B")).toBe(true);
    expect(matches("Rivera Stone BK", "Rivera Stone", "K")).toBe(false);
  });

  it("ignores case", () => {
    expect(matches("rivera stone b", "RIVERA STONE", "B")).toBe(true);
    expect(matches("RIVERA STONE B", "Rivera Stone", "b")).toBe(true);
  });

  it("ignores diacritics, on either side", () => {
    expect(matches("Núñez Åberg B", "Nunez Aberg", "B")).toBe(true);
    expect(matches("Nunez Aberg B", "Núñez Åberg", "B")).toBe(true);
    expect(matches("Sørensen Łuk E", "Sorensen Luk", "É")).toBe(true);
  });

  it("treats hyphen, space, apostrophe and repeated-space variants as one family name", () => {
    for (const lastName of ["Rivera-Stone", "Rivera  Stone", "Rivera Stone", "RiveraStone", "Rivera‐Stone"]) {
      expect(matches(NAME, lastName, "B"), lastName).toBe(true);
    }
    expect(matches("Rivera-Stone B", "Rivera Stone", "B")).toBe(true);
    expect(matches("  Rivera   Stone   B ", "Rivera Stone", "B")).toBe(true);
    expect(matches("O'Dell-Example C", "ODell Example", "C")).toBe(true);
  });

  it("does not match a different family name, or part of one", () => {
    expect(matches(NAME, "Rivera", "B")).toBe(false);
    expect(matches(NAME, "Stone", "B")).toBe(false);
    expect(matches(NAME, "Rivera Stoneham", "B")).toBe(false);
    expect(matches("Stone B", "Rivera Stone", "B")).toBe(false);
  });

  it("does not match an author with no initials or no family name", () => {
    expect(matches(NAME, "Rivera Stone", "")).toBe(false);
    expect(matches(NAME, "", "B")).toBe(false);
    expect(pubmedAuthorKey(author("Rivera Stone", ""))).toBeNull();
  });

  it("an entry with no initial has no key, and so can never match", () => {
    expect(authorNameKey("Rivera Stone")).toBeNull();
    expect(authorNameKey("Rivera")).toBeNull();
    expect(authorNameKey("B")).toBeNull();
    expect(authorNameKey("")).toBeNull();
    expect(matches("Rivera Stone", "Rivera", "S")).toBe(false);
    expect(authorNameKey(NAME)).toBe("riverastone b");
    expect(authorNameKey("Rivera-Stone BK")).toBe("riverastone b");
  });
});

describe("matching a supported list by phrase or by name", () => {
  const AFFILIATIONS = new Map<string, string[]>([
    ["101", ["Example Health Sciences Library, Example University."]],
    ["102", ["Department of Examples, Example University."]],
    ["103", []],
    ["104", ["Example Health Sciences Library, Example University."]],
  ]);
  const AUTHORS = new Map<string, PubMedAuthorName[]>([
    ["101", [author("Okafor", "C")]],
    ["102", [author("Okafor", "C"), author("Rivera-Stone", "BK")]],
    ["103", [author("Rivera Stone", "B")]],
    ["104", [author("Rivera Stone", "B")]],
  ]);

  it("the stored set is the supported pmids matching a phrase OR a name", () => {
    expect(
      matchCoauthoredPmids(["101", "102", "103", "104", "105"], AFFILIATIONS, ["Health Sciences Library"], AUTHORS, [NAME]),
    ).toEqual(["101", "102", "103", "104"]);
  });

  it("says which: an affiliation match wins when both apply", () => {
    expect([
      ...classifyCoauthoredPmids(["101", "102", "103", "104"], AFFILIATIONS, ["Health Sciences Library"], AUTHORS, [NAME]),
    ]).toEqual([
      ["101", "affiliation"],
      ["102", "author_name"],
      ["103", "author_name"],
      ["104", "affiliation"],
    ]);
  });

  it("names alone, with no phrases, still match (an author with no affiliation too)", () => {
    expect(matchCoauthoredPmids(["101", "102", "103"], AFFILIATIONS, [], AUTHORS, [NAME])).toEqual(["102", "103"]);
  });

  it("neither phrases nor names matches nothing; phrases alone are as before", () => {
    expect(matchCoauthoredPmids(["101", "102", "103"], AFFILIATIONS, [], AUTHORS, [])).toEqual([]);
    expect(matchCoauthoredPmids(["101", "102", "103"], AFFILIATIONS, ["Health Sciences Library"])).toEqual(["101"]);
  });
});

describe("author names: validation", () => {
  it("trims, collapses whitespace and drops entries that name the same author", () => {
    expect(validateAuthorNames(["  Rivera   Stone  B ", "rivera-stone BK", "Okafor C"])).toEqual({
      ok: true,
      value: ["Rivera Stone B", "Okafor C"],
    });
  });

  it("keeps two people with one family name and different initials", () => {
    expect(validateAuthorNames(["Rivera Stone B", "Rivera Stone K"])).toEqual({
      ok: true,
      value: ["Rivera Stone B", "Rivera Stone K"],
    });
  });

  it("accepts none, and up to 80 characters each", () => {
    expect(validateAuthorNames([])).toEqual({ ok: true, value: [] });
    expect(validateAuthorNames([`${"x".repeat(78)} B`]).ok).toBe(true);
    expect(validateAuthorNames(["Li B"]).ok).toBe(true);
  });

  it.each([
    [["Rivera Stone"], "author_name_no_initial"],
    [["Rivera"], "author_name_no_initial"],
    [["Li"], "author_name_no_initial"],
    [["B K"], "author_name_no_initial"],
    [["R"], "author_name_too_short"],
    [["   "], "author_name_too_short"],
    [[""], "author_name_too_short"],
    [[`${"x".repeat(79)} B`], "author_name_too_long"],
    [Array.from({ length: 51 }, (_, i) => `Exampl${"e".repeat(i + 1)} B`), "too_many_author_names"],
    [[1], "invalid_value"],
    ["Rivera Stone B", "invalid_value"],
    [null, "invalid_value"],
  ])("refuses %j", (input, error) => {
    expect(validateAuthorNames(input)).toEqual({ ok: false, error });
  });

  it("allows exactly 50", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `Exampl${"e".repeat(i + 1)} B`);
    expect(validateAuthorNames(fifty)).toEqual({ ok: true, value: fifty });
  });
});

const xml = (...articles: string[]) => `<?xml version="1.0"?><PubmedArticleSet>${articles.join("")}</PubmedArticleSet>`;
const article = (pmid: string, authors: string) => `
  <PubmedArticle><MedlineCitation><PMID Version="1">${pmid}</PMID>
    <Article><AuthorList>${authors}</AuthorList></Article>
  </MedlineCitation></PubmedArticle>`;
const AUTHORS_XML = `
  <Author><LastName>Rivera Stone</LastName><ForeName>Blair K</ForeName><Initials>BK</Initials>
    <AffiliationInfo><Affiliation>Example Library, Example City.</Affiliation></AffiliationInfo></Author>
  <Author><LastName>Okafor</LastName><ForeName>Casey</ForeName></Author>
  <Author><CollectiveName>Example Study Group</CollectiveName></Author>`;

describe("the PubMed reader's author names", () => {
  it("lists each author's family name and initials, in order, without collective names", () => {
    const out = authorNamesByPmid(xml(article("101", AUTHORS_XML), article("102", "")));
    expect(out.get("101")).toEqual([
      { lastName: "Rivera Stone", initials: "BK" },
      // No Initials element: the first letter of the fore name.
      { lastName: "Okafor", initials: "C" },
    ]);
    expect(out.get("102")).toEqual([]);
  });

  it("fetchAuthorAffiliations returns them from the same request as the affiliations", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => xml(article("101", AUTHORS_XML)) }));
    const out = await fetchAuthorAffiliations(["101", "999"], { fetchFn: fetchFn as unknown as typeof fetch });
    // One ask for both, and the second ask for the PMID the answer left out.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(out.affiliations.get("101")).toEqual(["Example Library, Example City."]);
    expect(out.authors.get("101")).toEqual([
      { lastName: "Rivera Stone", initials: "BK" },
      { lastName: "Okafor", initials: "C" },
    ]);
    // A PMID PubMed has no record of: an answer, with nobody on it.
    expect(out.authors.get("999")).toEqual([]);
    expect([...out.authors.keys()].sort()).toEqual([...out.affiliations.keys()].sort());
    expect(out.complete).toBe(true);
  });
});

describe("the resumable PubMed check, with names", () => {
  const stored = (over: Partial<Parameters<typeof carriedAffiliationProgress>[0] & object> = {}) => ({
    phrases: [] as string[],
    authorNames: [NAME],
    checked: ["101", "102", "103"],
    coauthored: ["101", "102"],
    nameMatched: ["102"],
    ...over,
  });
  const supportedPmids = ["101", "102", "103"];

  it("a names-only service has something to check", () => {
    const carried = carriedAffiliationProgress(null, { supportedPmids, phrases: [], authorNames: [NAME] });
    expect(pmidsToCheck(supportedPmids, carried)).toEqual(supportedPmids);
    const merged = mergeAffiliationLookup(
      supportedPmids,
      [],
      carried,
      new Map(supportedPmids.map((p) => [p, []])),
      [NAME],
      new Map([["102", [author("Rivera-Stone", "BK")]]]),
    );
    expect(merged).toEqual({ checked: supportedPmids, coauthored: ["102"], nameMatched: ["102"], complete: true });
  });

  it("the same names (however they are written) carry everything checked", () => {
    expect(
      carriedAffiliationProgress(stored(), { supportedPmids, phrases: [], authorNames: ["rivera-stone BK"] }),
    ).toEqual({ checked: ["101", "102", "103"], coauthored: ["101", "102"], nameMatched: ["102"] });
  });

  it("an added name carries the matches only, each with the reason it was found by", () => {
    expect(
      carriedAffiliationProgress(stored(), { supportedPmids, phrases: [], authorNames: [NAME, "Okafor C"] }),
    ).toEqual({ checked: ["101", "102"], coauthored: ["101", "102"], nameMatched: ["102"] });
  });

  it("an added phrase beside unchanged names carries the matches only, too", () => {
    expect(
      carriedAffiliationProgress(stored(), { supportedPmids, phrases: ["Example Library"], authorNames: [NAME] }),
    ).toEqual({ checked: ["101", "102"], coauthored: ["101", "102"], nameMatched: ["102"] });
  });

  it("a changed name restarts the check", () => {
    expect(
      carriedAffiliationProgress(stored(), { supportedPmids, phrases: [], authorNames: ["Rivera Stone K"] }),
    ).toEqual({ checked: [], coauthored: [], nameMatched: [] });
  });

  it("a removed name restarts the check, with or without a phrase left", () => {
    const two = stored({ phrases: ["Example Library"], authorNames: [NAME, "Okafor C"] });
    expect(
      carriedAffiliationProgress(two, { supportedPmids, phrases: ["Example Library"], authorNames: [NAME] }),
    ).toEqual({ checked: [], coauthored: [], nameMatched: [] });
    expect(
      carriedAffiliationProgress(two, { supportedPmids, phrases: ["Example Library"], authorNames: [] }),
    ).toEqual({ checked: [], coauthored: [], nameMatched: [] });
    expect(carriedAffiliationProgress(stored(), { supportedPmids, phrases: [], authorNames: [] })).toEqual({
      checked: [],
      coauthored: [],
      nameMatched: [],
    });
  });

  it("a removed phrase restarts the check even when the names are unchanged", () => {
    expect(
      carriedAffiliationProgress(stored({ phrases: ["Example Library"] }), {
        supportedPmids,
        phrases: [],
        authorNames: [NAME],
      }),
    ).toEqual({ checked: [], coauthored: [], nameMatched: [] });
  });

  it("a name match that is no longer supported is dropped from both lists", () => {
    expect(
      carriedAffiliationProgress(stored(), { supportedPmids: ["101", "103"], phrases: [], authorNames: [NAME] }),
    ).toEqual({ checked: ["101", "103"], coauthored: ["101"], nameMatched: [] });
  });
});
