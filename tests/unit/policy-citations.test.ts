import { describe, expect, it } from "vitest";
import { issuingBody } from "@/lib/citations/issuing-bodies";
import { bookshelfCiters, esummary, harvestPmids } from "@/etl/policy-citations/ncbi";
import {
  authorityBodies,
  bookshelfDoc,
  cleanTitle,
  dedupKey,
  pubmedDoc,
  pubmedLevel,
} from "@/etl/policy-citations/shape";

const bookinfo = (book: string, statement: string, selfType = "ref-list") =>
  `<Info><Path><Parent id="b" role="source" type="book" uid="1"><Title>${book}</Title></Parent>` +
  `<Self id="r" role="document" type="${selfType}" uid="2"><Title>REFERENCES</Title></Self></Path>` +
  `<Citation><ParentRecord><Title>${book}.</Title><PublicationStatement>${statement}</PublicationStatement>` +
  `</ParentRecord></Citation></Info>`;

describe("issuing bodies", () => {
  it("names a listed authority and folds IARC into WHO", () => {
    expect(issuingBody("Geneva: World Health Organization; 2018 Jul.")).toBe("WHO");
    expect(issuingBody("Lyon (FR): International Agency for Research on Cancer; 2020.")).toBe("WHO");
    expect(issuingBody("London: National Institute for Health and Care Excellence (NICE); 2021.")).toBe("NICE");
    expect(issuingBody("Washington (DC): National Academies Press (US); 2017 Mar 28.")).toBe("National Academies");
  });

  it("drops textbooks and bodies that are not on the list", () => {
    expect(issuingBody("Treasure Island (FL): StatPearls Publishing; 2024 Jan-.")).toBeNull();
    expect(issuingBody("Seattle (WA): University of Washington, Seattle; 1993-2026.")).toBeNull();
    // NIHR is not NICE.
    expect(issuingBody("Southampton (UK): National Institute for Health and Care Research; 2023.")).toBeNull();
  });
});

describe("shape", () => {
  it("cleans entities and markup out of titles", () => {
    expect(cleanTitle("GeneReviews<sup>&#xAE;</sup> &amp;  more&#33;")).toBe("GeneReviews® & more!");
  });

  it("gives the same guideline printed in two journals one key", () => {
    const a = dedupKey("Elimination of hepatitis C. Positioning document.", 2019);
    expect(dedupKey("Elimination of Hepatitis C: positioning document", 2019)).toBe(a);
    expect(dedupKey("Elimination of hepatitis C. Positioning document.", 2020)).not.toBe(a);
    expect(dedupKey("Déclaration", 2025)).toBe("declaration|2025");
  });

  it("types a citing paper by its strongest publication type", () => {
    const sets = { guideline: new Set([1]), consensus: new Set([1, 2]), review: new Set([1, 2, 3]) };
    expect([1, 2, 3, 4].map((p) => pubmedLevel(p, sets))).toEqual(["guideline", "consensus", "review", null]);
  });

  it("builds a PubMed document", () => {
    expect(pubmedDoc(31816111, "guideline", { title: "Hepatitis C Guidance.", pubdate: "2020 Feb" })).toEqual({
      source: "pubmed",
      externalId: "31816111",
      title: "Hepatitis C Guidance.",
      year: 2020,
      url: "https://pubmed.ncbi.nlm.nih.gov/31816111/",
      level: "guideline",
      issuingBody: null,
      dedupKey: "hepatitis c guidance|2020",
    });
  });

  it("rolls a Bookshelf section up to its book", () => {
    const doc = bookshelfDoc({
      bookaccessionid: "NBK442272",
      title: "REFERENCES",
      bookinfo: bookinfo("WHO Guidelines on Hepatitis B and C Testing", "Geneva: World Health Organization; 2017 Feb."),
    });
    expect(doc).toMatchObject({
      source: "bookshelf",
      externalId: "NBK442272",
      title: "WHO Guidelines on Hepatitis B and C Testing",
      year: 2017,
      url: "https://www.ncbi.nlm.nih.gov/books/NBK442272/",
      level: "authority",
      issuingBody: "WHO",
    });
  });

  it("drops a Bookshelf record no listed authority published", () => {
    expect(
      bookshelfDoc({
        bookaccessionid: "NBK430685",
        bookinfo: bookinfo("StatPearls", "Treasure Island (FL): StatPearls Publishing; 2024 Jan-."),
      }),
    ).toBeNull();
    expect(bookshelfDoc({ bookaccessionid: "NBK1", bookinfo: "" })).toBeNull();
  });

  it("counts authority documents per body, most first", () => {
    expect(authorityBodies(["National Academies", "WHO", "WHO"])).toEqual([
      { body: "WHO", count: 2 },
      { body: "National Academies", count: 1 },
    ]);
  });
});

/** A fake E-utilities endpoint: `handler` sees the POSTed form and returns JSON. */
function fakeNcbi(handler: (form: URLSearchParams, url: string) => unknown, status = 200) {
  const calls: URLSearchParams[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const form = init!.body as URLSearchParams;
    calls.push(form);
    return new Response(JSON.stringify(handler(form, String(url))), { status });
  }) as typeof fetch;
  return { calls, opts: { fetchFn, retryBaseMs: 0, delayMs: 0 } };
}

describe("ncbi", () => {
  // 25,000 records spread one per ... day index; a range returns those inside it.
  const DAY = 86_400_000;
  const from = new Date(Date.UTC(2000, 0, 1));
  const to = new Date(from.getTime() + 99 * DAY);
  const perDay = 250; // 100 days x 250 = 25,000 records, so the range must split
  const inRange = (term: string) => {
    const [a, b] = [...term.matchAll(/"(\d{4})\/(\d{2})\/(\d{2})"/g)].map(
      (m) => (Date.UTC(+m[1], +m[2] - 1, +m[3]) - from.getTime()) / DAY,
    );
    const ids: string[] = [];
    for (let d = a; d <= b; d++) for (let i = 0; i < perDay; i++) ids.push(String(d * perDay + i + 1));
    return ids;
  };

  it("splits a date range until every piece fits under the page limit", async () => {
    const { calls, opts } = fakeNcbi((form) => {
      const ids = inRange(form.get("term")!);
      return { esearchresult: { count: String(ids.length), idlist: ids.slice(0, Number(form.get("retmax"))) } };
    });
    const out = await harvestPmids("Guideline[pt]", from, to, opts);
    expect(out.size).toBe(25_000);
    expect(calls.length).toBeGreaterThan(3);
  });

  it("throws when the harvest comes up short of PubMed's own count", async () => {
    const { opts } = fakeNcbi((form) =>
      form.get("retmax") === "0"
        ? { esearchresult: { count: "5000", idlist: [] } }
        : { esearchresult: { count: "3", idlist: ["1", "2", "3"] } },
    );
    await expect(harvestPmids("Guideline[pt]", from, to, opts)).rejects.toThrow("harvested 3 of 5000");
  });

  it("retries an outage reported as HTTP 200 with an ERROR body, then gives up", async () => {
    const { calls, opts } = fakeNcbi(() => ({ esearchresult: { ERROR: "Search Backend failed" } }));
    await expect(harvestPmids("Guideline[pt]", from, to, opts)).rejects.toThrow("failed after 6 attempts");
    expect(calls.length).toBe(6);
  });

  it("maps each paper to the Bookshelf records citing it", async () => {
    const { calls, opts } = fakeNcbi(() => ({
      linksets: [
        { ids: ["11"], linksetdbs: [{ links: ["900", "901"] }] },
        { ids: ["12"] },
      ],
    }));
    expect(await bookshelfCiters(["11", "12"], opts)).toEqual(new Map([["11", ["900", "901"]]]));
    expect(calls[0].getAll("id")).toEqual(["11", "12"]);
  });

  it("treats a Bookshelf answer missing a paper as a failed read", async () => {
    const { opts } = fakeNcbi(() => ({ linksets: [{ ids: ["11"] }] }));
    await expect(bookshelfCiters(["11", "12"], opts)).rejects.toThrow("failed after");
  });

  it("returns summaries by id and leaves out deleted records", async () => {
    const { opts } = fakeNcbi(() => ({
      result: { uids: ["1", "2"], "1": { title: "A" }, "2": { error: "cannot get document summary" } },
    }));
    expect(await esummary("pubmed", [1, 2], opts)).toEqual(new Map([["1", { title: "A" }]]));
  });

  it("does not retry a client error", async () => {
    const { calls, opts } = fakeNcbi(() => ({}), 400);
    await expect(esummary("pubmed", [1], opts)).rejects.toThrow("HTTP 400");
    expect(calls.length).toBe(1);
  });
});
