import { describe, expect, it } from "vitest";
import { parseMyncbiPage } from "@/etl/myncbi/parse";

const pubmed = (id: string, pmid: string, title: string) => `<div class="citation-wrap">
  <div class="citation"><div class="align-left">
    <input id="cit${id}" type="checkbox" name="cit${id}" value="${id}" class="citation-check"
        pmid="${pmid}"
    ><label for="cit${id}">select</label></div>
    <div class="ncbi-docsum"><span class="authors">Lovelace A, Babbage C.</span><a href="https://www.ncbi.nlm.nih.gov/pubmed/${pmid}/">
      ${title}.</a><span class="source">Proc Anal Soc</span>. <span class="pubdate">2024 Mar 3;</span>
    </div></div></div>`;
const book = `<div class="citation-wrap"><div class="citation"><div class="align-left">
    <input id="cit9" type="checkbox" name="cit9" value="9" class="citation-check"
    ><label for="cit9">select</label></div>
    <div class="ncbi-docsum">Lovelace A. Notes on the &amp; engine. London; 1843.</div></div></div>`;

describe("parseMyncbiPage", () => {
  it("reads PubMed items, non-PubMed items, the last page and the total", () => {
    const html = `<p>3 citations,</p>${pubmed("101", "123456", "On engines")}${pubmed("102", "654321", "More engines")}${book}
      <a href="?page=1">1</a><a href="?page=2">2</a>`;
    const r = parseMyncbiPage(html);
    expect(r.total).toBe(3);
    expect(r.lastPage).toBe(2);
    expect(r.citations).toEqual([
      { citationId: "101", pmid: "123456", authors: "Lovelace A, Babbage C", title: "On engines", source: "Proc Anal Soc", year: 2024 },
      { citationId: "102", pmid: "654321", authors: "Lovelace A, Babbage C", title: "More engines", source: "Proc Anal Soc", year: 2024 },
      { citationId: "9", pmid: null, authors: null, title: "Lovelace A. Notes on the & engine. London; 1843", source: null, year: null },
    ]);
  });

  it("decodes &amp; last, so an escaped entity stays literal", () => {
    const html = `<div class="citation-wrap"><input type="checkbox" value="5" class="citation-check"><div class="ncbi-docsum">A &amp;lt;b&amp;gt; tag &amp; more</div></div>`;
    expect(parseMyncbiPage(html).citations[0].title).toBe("A &lt;b&gt; tag & more");
  });

  it("an empty or foreign page → no citations, page 1", () => {
    expect(parseMyncbiPage("<html><body>Not found</body></html>")).toEqual({ citations: [], lastPage: 1, total: null });
  });
});
