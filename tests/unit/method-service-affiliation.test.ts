/**
 * Method services, the PubMed side of "collaboration or support":
 * `matchCoauthoredPmids` (the pure match the route stores as
 * `coauthored_pmids`), `validateAffiliationPhrases` / `parsePhraseBlock`, and
 * the EFetch reader in `lib/edit/pubmed-affiliations.ts`. No network: `fetch`
 * is injected. Made-up PMIDs, people and institutions only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { authorAffiliationsByPmid, fetchAuthorAffiliations } from "@/lib/edit/pubmed-affiliations";
import { matchCoauthoredPmids } from "@/lib/method-services/affiliation";
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

describe("fetchAuthorAffiliations", () => {
  afterEach(() => vi.unstubAllEnvs());

  const ok = (body: string) => ({ ok: true, status: 200, text: async () => body }) as Response;

  it("POSTs EFetch in batches of 200 and merges the answers", async () => {
    const pmids = Array.from({ length: 201 }, (_, i) => String(1000 + i));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok(xml(article("1000", [["Example Library"]]))))
      .mockResolvedValueOnce(ok(xml(article("1200", [["Example Core"]]))));
    const out = await fetchAuthorAffiliations(pmids, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const first = init.body as URLSearchParams;
    expect(first.get("db")).toBe("pubmed");
    expect(first.get("id")!.split(",")).toHaveLength(200);
    expect(first.has("api_key")).toBe(false);
    expect((fetchFn.mock.calls[1][1].body as URLSearchParams).get("id")).toBe("1200");
    expect(out.get("1000")).toEqual(["Example Library"]);
    expect(out.get("1200")).toEqual(["Example Core"]);
  });

  it("sends NCBI_API_KEY when it is set", async () => {
    vi.stubEnv("NCBI_API_KEY", "made-up-key");
    const fetchFn = vi.fn().mockResolvedValue(ok(xml()));
    await fetchAuthorAffiliations(["101"], { fetchFn });
    expect((fetchFn.mock.calls[0][1].body as URLSearchParams).get("api_key")).toBe("made-up-key");
  });

  it("throws on a non-2xx answer", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 502 } as Response);
    await expect(fetchAuthorAffiliations(["101"], { fetchFn })).rejects.toThrow("EFetch 502");
  });

  it("throws when the request fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(fetchAuthorAffiliations(["101"], { fetchFn })).rejects.toThrow("network down");
  });

  it("gives up at the deadline", async () => {
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    await expect(
      fetchAuthorAffiliations(["101"], { fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 20 }),
    ).rejects.toThrow();
  });

  it("asks nothing for an empty list", async () => {
    const fetchFn = vi.fn();
    expect((await fetchAuthorAffiliations([], { fetchFn })).size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
