/**
 * Method services, the PubMed side of "collaboration or support":
 * `matchCoauthoredPmids` (the pure match the route stores as
 * `coauthored_pmids`), `validateAffiliationPhrases` / `parsePhraseBlock`, and
 * the EFetch reader in `lib/edit/pubmed-affiliations.ts`. No network: `fetch`
 * is injected. Made-up PMIDs, people and institutions only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { authorAffiliationsByPmid, fetchAuthorAffiliations } from "@/lib/edit/pubmed-affiliations";
import {
  carriedAffiliationProgress,
  matchCoauthoredPmids,
  mergeAffiliationLookup,
  pmidsToCheck,
} from "@/lib/method-services/affiliation";
import { parsePhraseBlock, validateAffiliationPhrases } from "@/lib/method-services/validation";

const AFFILIATIONS = new Map<string, string[]>([
  ["101", ["Department of Examples, Example University, Example City.", "Example Health Sciences Library, Example University."]],
  ["102", ["Department of Examples, Example University, Example City."]],
  ["103", ["EXAMPLE   HEALTH SCIENCES\nLIBRARY, Example City."]],
  ["104", []],
]);

describe("matchCoauthoredPmids", () => {
  it("keeps the supported pmids with an author whose affiliation contains a phrase", () => {
    expect(
      matchCoauthoredPmids(["101", "102"], AFFILIATIONS, ["Example Health Sciences Library"]),
    ).toEqual(["101"]);
  });

  it("is case-insensitive, in the phrase and in the affiliation", () => {
    expect(matchCoauthoredPmids(["101"], AFFILIATIONS, ["example HEALTH sciences library"])).toEqual(["101"]);
    expect(matchCoauthoredPmids(["103"], AFFILIATIONS, ["Example Health Sciences Library"])).toEqual(["103"]);
  });

  it("ignores runs of whitespace and line breaks", () => {
    expect(matchCoauthoredPmids(["103"], AFFILIATIONS, ["  Example  Health Sciences Library "])).toEqual(["103"]);
  });

  it("ANY phrase is enough", () => {
    expect(
      matchCoauthoredPmids(["101", "102", "103"], AFFILIATIONS, ["No Such Unit", "Health Sciences Library"]),
    ).toEqual(["101", "103"]);
  });

  it("no phrases: the empty set", () => {
    expect(matchCoauthoredPmids(["101", "102", "103"], AFFILIATIONS, [])).toEqual([]);
    expect(matchCoauthoredPmids(["101"], AFFILIATIONS, ["", "   "])).toEqual([]);
  });

  it("a pmid with no affiliations, or one PubMed did not return, does not match", () => {
    expect(matchCoauthoredPmids(["104", "999"], AFFILIATIONS, ["Example"])).toEqual([]);
  });

  it("only ever returns supported pmids, in their order, once each", () => {
    expect(matchCoauthoredPmids(["103", "101", "103"], AFFILIATIONS, ["Library"])).toEqual(["103", "101"]);
    // 101 matches but is not supported.
    expect(matchCoauthoredPmids(["102"], AFFILIATIONS, ["Library"])).toEqual([]);
  });

  it("a phrase is plain text, never a pattern", () => {
    expect(matchCoauthoredPmids(["101"], AFFILIATIONS, [".*"])).toEqual([]);
  });
});

describe("affiliation phrases: validation", () => {
  it("trims, collapses whitespace and drops duplicates that differ only by case", () => {
    expect(validateAffiliationPhrases(["  Example   Library ", "example library", "Example Core"])).toEqual({
      ok: true,
      value: ["Example Library", "Example Core"],
    });
  });

  it("accepts none, and 3 to 120 characters each", () => {
    expect(validateAffiliationPhrases([])).toEqual({ ok: true, value: [] });
    expect(validateAffiliationPhrases(["abc", "x".repeat(120)]).ok).toBe(true);
  });

  it.each([
    [["ab"], "phrase_too_short"],
    [["  a  "], "phrase_too_short"],
    [[""], "phrase_too_short"],
    [["x".repeat(121)], "phrase_too_long"],
    [Array.from({ length: 11 }, (_, i) => `Example unit ${i}`), "too_many_phrases"],
    [[1], "invalid_value"],
    ["Example Library", "invalid_value"],
    [null, "invalid_value"],
  ])("refuses %j", (input, error) => {
    expect(validateAffiliationPhrases(input)).toEqual({ ok: false, error });
  });

  it("allows exactly 10", () => {
    expect(validateAffiliationPhrases(Array.from({ length: 10 }, (_, i) => `Example unit ${i}`)).ok).toBe(true);
  });

  it("parsePhraseBlock reads one phrase per line and drops blank lines", () => {
    expect(parsePhraseBlock(" Example  Library \r\n\n  \nExample Core, Example City\n")).toEqual([
      "Example Library",
      "Example Core, Example City",
    ]);
    expect(parsePhraseBlock("")).toEqual([]);
  });
});

const article = (pmid: string, authors: string[][], cited = "") => `
  <PubmedArticle>
    <MedlineCitation><PMID Version="1">${pmid}</PMID>
      <Article><AuthorList>
        ${authors
          .map(
            (affs) =>
              `<Author><LastName>Example</LastName>${affs
                .map((a) => `<AffiliationInfo><Affiliation>${a}</Affiliation></AffiliationInfo>`)
                .join("")}</Author>`,
          )
          .join("")}
      </AuthorList></Article>
    </MedlineCitation>
    <PubmedData><ReferenceList>${cited}</ReferenceList></PubmedData>
  </PubmedArticle>`;
const xml = (...articles: string[]) => `<?xml version="1.0"?><PubmedArticleSet>${articles.join("")}</PubmedArticleSet>`;

describe("authorAffiliationsByPmid", () => {
  it("lists every author's affiliations under the article's own PMID", () => {
    const out = authorAffiliationsByPmid(
      xml(
        article(
          "101",
          [["Example Library, Example City."], [], ["Dept A, Example U.", "Dept B, Example U."]],
          `<Reference><ArticleIdList><ArticleId IdType="pubmed">555</ArticleId></ArticleIdList></Reference>`,
        ),
        article("102", [[]]),
      ),
    );
    expect(out.get("101")).toEqual(["Example Library, Example City.", "Dept A, Example U.", "Dept B, Example U."]);
    expect(out.get("102")).toEqual([]);
    expect([...out.keys()]).toEqual(["101", "102"]);
  });
});

describe("authorAffiliationsByPmid: Bookshelf records", () => {
  it("reads a PubmedBookArticle's authors too", () => {
    const out = authorAffiliationsByPmid(
      `<?xml version="1.0"?><PubmedArticleSet><PubmedBookArticle><BookDocument>
        <PMID Version="1">301</PMID>
        <AuthorList Type="authors"><Author><LastName>Example</LastName>
          <AffiliationInfo><Affiliation>Example Library, Example City.</Affiliation></AffiliationInfo>
        </Author></AuthorList>
      </BookDocument></PubmedBookArticle></PubmedArticleSet>`,
    );
    expect(out.get("301")).toEqual(["Example Library, Example City."]);
  });
});

describe("fetchAuthorAffiliations", () => {
  afterEach(() => vi.unstubAllEnvs());

  const ok = (body: string) => ({ ok: true, status: 200, text: async () => body }) as Response;
  const idsOf = (init: RequestInit) => (init.body as URLSearchParams).get("id")!.split(",");
  /** A PubMed that answers for every PMID asked, except those in `unknown`. */
  const pubmed = (unknown: ReadonlyArray<string> = []) =>
    vi.fn(async (_url: string, init: RequestInit) =>
      ok(
        xml(
          ...idsOf(init)
            .filter((p) => !unknown.includes(p))
            .map((p) => article(p, [[`Unit of ${p}`]])),
        ),
      ),
    );
  const run = (pmids: string[], fetchFn: unknown, timeoutMs?: number) =>
    fetchAuthorAffiliations(pmids, { fetchFn: fetchFn as typeof fetch, timeoutMs });
  const range = (n: number, from = 1000) => Array.from({ length: n }, (_, i) => String(from + i));

  it("POSTs EFetch in batches of 200 and merges the answers", async () => {
    const pmids = range(201);
    const fetchFn = pubmed();
    const out = await run(pmids, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const first = init.body as URLSearchParams;
    expect(first.get("db")).toBe("pubmed");
    expect(fetchFn.mock.calls.map((c) => idsOf(c[1]).length).sort()).toEqual([1, 200]);
    expect(first.has("api_key")).toBe(false);
    expect(out.complete).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.affiliations.size).toBe(201);
    expect(out.affiliations.get("1000")).toEqual(["Unit of 1000"]);
    expect(out.affiliations.get("1200")).toEqual(["Unit of 1200"]);
  });

  it("sends NCBI_API_KEY when it is set", async () => {
    vi.stubEnv("NCBI_API_KEY", "made-up-key");
    const fetchFn = pubmed();
    await run(["101"], fetchFn);
    expect((fetchFn.mock.calls[0][1].body as URLSearchParams).get("api_key")).toBe("made-up-key");
  });

  it("asks for a duplicated pmid once", async () => {
    const fetchFn = pubmed();
    const out = await run(["101", "101", "102"], fetchFn);
    expect(idsOf(fetchFn.mock.calls[0][1])).toEqual(["101", "102"]);
    expect(out.complete).toBe(true);
  });

  it("a non-2xx answer is not complete, and does not throw", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 502 } as Response);
    const out = await run(["101"], fetchFn);
    expect(out).toMatchObject({ complete: false, error: "EFetch 502" });
    expect(out.affiliations.size).toBe(0);
  });

  it("a failed request is not complete, and does not throw", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await run(["101"], fetchFn)).toMatchObject({ complete: false, error: "network down" });
  });

  it.each([
    ["an error document", `<?xml version="1.0"?><eFetchResult><ERROR>Bad request</ERROR></eFetchResult>`],
    ["an HTML page", "<html><body>Service unavailable</body></html>"],
    ["an empty body", ""],
    ["a body cut off part way", xml(article("101", [["Example Library"]])).slice(0, 140)],
  ])("a 200 with %s is a failure, never 'no affiliations'", async (_name, body) => {
    const fetchFn = vi.fn().mockResolvedValue(ok(body));
    const out = await run(["101"], fetchFn);
    expect(out.complete).toBe(false);
    expect(out.error).toBeTruthy();
    expect(out.affiliations.has("101")).toBe(false);
  });

  it("a pmid left out of a good answer is asked for once more", async () => {
    // The first answer is short; the second has the record after all.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok(xml(article("101", [["Example Library"]]))))
      .mockResolvedValueOnce(ok(xml(article("102", [["Example Core"]]))));
    const out = await run(["101", "102"], fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(idsOf(fetchFn.mock.calls[1][1])).toEqual(["102"]);
    expect(out.complete).toBe(true);
    expect(out.affiliations.get("102")).toEqual(["Example Core"]);
  });

  it("a whole batch answered with an empty set is asked for again, not read as no affiliations", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok(xml()))
      .mockResolvedValueOnce(ok(xml(article("101", [["Example Library"]]), article("102", [[]]))));
    const out = await run(["101", "102"], fetchFn);
    expect(out.complete).toBe(true);
    expect(out.affiliations.get("101")).toEqual(["Example Library"]);
    expect(out.affiliations.get("102")).toEqual([]);
  });

  it("left out twice: PubMed has no record of it, which is an answer", async () => {
    const fetchFn = pubmed(["999"]);
    const out = await run(["101", "999"], fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(out.complete).toBe(true);
    expect(out.affiliations.get("999")).toEqual([]);
    expect(out.affiliations.get("101")).toEqual(["Unit of 101"]);
  });

  it("the second ask failing leaves the pmid unchecked", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok(xml(article("101", [["Example Library"]]))))
      .mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    const out = await run(["101", "102"], fetchFn);
    expect(out).toMatchObject({ complete: false, error: "EFetch 429" });
    expect([...out.affiliations.keys()]).toEqual(["101"]);
  });

  it("a failure part way keeps the batches already read and asks for no more", async () => {
    const pmids = range(1400); // 7 batches
    let calls = 0;
    const good = pubmed();
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls += 1;
      if (calls === 4) return { ok: false, status: 502 } as Response;
      return good(url, init);
    });
    const out = await run(pmids, fetchFn);
    expect(out.complete).toBe(false);
    expect(out.error).toBe("EFetch 502");
    // Whole batches only, some but not all of them.
    expect(out.affiliations.size % 200).toBe(0);
    expect(out.affiliations.size).toBeGreaterThanOrEqual(600);
    expect(out.affiliations.size).toBeLessThan(1400);
    expect(fetchFn.mock.calls.length).toBeLessThan(7);
  });

  it("at the deadline it returns what it has read so far", async () => {
    // The first request is answered; every later one hangs until aborted.
    let calls = 0;
    const good = pubmed();
    const fetchFn = vi.fn((url: string, init: RequestInit) => {
      calls += 1;
      if (calls === 1) return good(url, init);
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    const out = await run(range(401), fetchFn, 600);
    expect(out.complete).toBe(false);
    expect(out.error).toBeTruthy();
    expect(out.affiliations.size).toBe(200);
  });

  it("asks nothing for an empty list", async () => {
    const fetchFn = vi.fn();
    const out = await run([], fetchFn);
    expect(out).toEqual({ affiliations: new Map(), complete: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("the resumable PubMed check", () => {
  const PHRASE = "Example Library";
  const stored = (over: Partial<Parameters<typeof carriedAffiliationProgress>[0] & object> = {}) => ({
    phrases: [PHRASE],
    checked: ["101", "102", "103"],
    coauthored: ["101"],
    ...over,
  });

  it("the same phrases carry everything checked that is still supported", () => {
    expect(
      carriedAffiliationProgress(stored(), { supportedPmids: ["101", "103", "104"], phrases: ["example  LIBRARY"] }),
    ).toEqual({ checked: ["101", "103"], coauthored: ["101"] });
  });

  it("an added phrase carries the matches only: the rest must be compared again", () => {
    expect(
      carriedAffiliationProgress(stored(), {
        supportedPmids: ["101", "102", "103"],
        phrases: [PHRASE, "Example Core"],
      }),
    ).toEqual({ checked: ["101"], coauthored: ["101"] });
  });

  it("a removed or reworded phrase, no phrases, or a new service carries nothing", () => {
    const next = { supportedPmids: ["101", "102"], phrases: ["Example Core"] };
    expect(carriedAffiliationProgress(stored(), next)).toEqual({ checked: [], coauthored: [] });
    expect(carriedAffiliationProgress(stored(), { ...next, phrases: [] })).toEqual({ checked: [], coauthored: [] });
    expect(carriedAffiliationProgress(null, next)).toEqual({ checked: [], coauthored: [] });
  });

  it("a stored match with no checked record behind it is not carried", () => {
    expect(
      carriedAffiliationProgress(stored({ checked: [], coauthored: ["101"] }), {
        supportedPmids: ["101"],
        phrases: [PHRASE],
      }),
    ).toEqual({ checked: [], coauthored: [] });
  });

  it("pmidsToCheck: the supported pmids not yet checked, once each", () => {
    expect(pmidsToCheck(["101", "102", "102", "103"], { checked: ["102"], coauthored: [] })).toEqual(["101", "103"]);
  });

  it("merging adds what PubMed answered and leaves the unanswered unchecked", () => {
    const merged = mergeAffiliationLookup(
      ["104", "101", "102", "103"],
      [PHRASE],
      { checked: ["101", "102"], coauthored: ["101"] },
      new Map([["104", ["Example Library, Example City."]]]),
    );
    expect(merged).toEqual({ checked: ["104", "101", "102"], coauthored: ["104", "101"], complete: false });
  });

  it("an answer for an already checked pmid changes nothing; all checked is complete", () => {
    const merged = mergeAffiliationLookup(
      ["101", "102"],
      [PHRASE],
      { checked: ["101", "102"], coauthored: ["101"] },
      // 101 answered again with no match: the stored match is not re-judged.
      new Map([["101", []]]),
    );
    expect(merged).toEqual({ checked: ["101", "102"], coauthored: ["101"], complete: true });
  });

  it("a list of 5,000 is finished over several part-way lookups, losing nothing", () => {
    const supported = Array.from({ length: 5000 }, (_, i) => String(10000 + i));
    const affiliationOf = (pmid: string) => (Number(pmid) % 10 === 0 ? ["Example Library"] : ["Elsewhere"]);
    let progress = { checked: [] as string[], coauthored: [] as string[] };
    let rounds = 0;
    for (; rounds < 10; rounds += 1) {
      const todo = pmidsToCheck(supported, progress);
      if (todo.length === 0) break;
      // Each lookup gets through 1,800 before its deadline.
      const answered = new Map(todo.slice(0, 1800).map((p) => [p, affiliationOf(p)]));
      progress = mergeAffiliationLookup(supported, [PHRASE], progress, answered);
    }
    expect(rounds).toBe(3);
    expect(progress.checked).toHaveLength(5000);
    expect(progress.coauthored).toHaveLength(500);
  });
});
