/**
 * Pure parser for one page of a public MyNCBI bibliography
 * (`https://www.ncbi.nlm.nih.gov/myncbi/<user>/bibliography/public/?page=N`).
 *
 * The page is server-rendered: each citation is a `<div class="citation-wrap">`
 * whose checkbox carries the citation id (`value`) and, for PubMed items, a
 * `pmid` attribute; the docsum holds `<span class="authors">`, the title link,
 * `<span class="source">` and `<span class="pubdate">`. Items without a PMID (books, reports) keep their text.
 * Pagination is `?page=N`; the highest page number linked is the last page.
 */

export type MyncbiCitation = {
  citationId: string;
  pmid: string | null;
  /** The author list as shown ("Ceceli AO, Huang Y, ..."); null when the page has none. */
  authors: string | null;
  title: string;
  source: string | null;
  year: number | null;
};

const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    // Last, so "&amp;lt;" stays the literal "&lt;" instead of becoming "<".
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

export function parseMyncbiPage(html: string): { citations: MyncbiCitation[]; lastPage: number; total: number | null } {
  const citations: MyncbiCitation[] = [];
  for (const block of html.split(/<div class="citation-wrap">/).slice(1)) {
    const citationId = /class="citation-check"[^>]*?value="(\d+)"|value="(\d+)"[^>]*?class="citation-check"/.exec(block);
    const id = citationId?.[1] ?? citationId?.[2];
    if (!id) continue;
    const pmid = /\bpmid="(\d+)"/.exec(block)?.[1] ?? null;
    const docsum = /<div class="ncbi-docsum">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? block;
    const authors = /<span class="authors">([\s\S]*?)<\/span>/.exec(docsum)?.[1];
    const linked = /<a [^>]*>([\s\S]*?)<\/a>/.exec(docsum)?.[1];
    const title = strip(linked ?? docsum).replace(/\.$/, "").slice(0, 1000);
    const source = /<span class="source">([\s\S]*?)<\/span>/.exec(docsum)?.[1];
    const pubdate = /<span class="pubdate">([\s\S]*?)<\/span>/.exec(docsum)?.[1] ?? "";
    const year = /\b(1[89]\d\d|20\d\d)\b/.exec(pubdate)?.[1];
    citations.push({
      citationId: id,
      pmid,
      authors: authors ? strip(authors).replace(/\.$/, "") || null : null,
      title,
      source: source ? strip(source).slice(0, 255) : null,
      year: year ? Number(year) : null,
    });
  }
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  const total = /(\d[\d,]*) citations?\b/i.exec(html)?.[1];
  return {
    citations,
    lastPage: Math.max(1, ...pages),
    total: total ? Number(total.replace(/,/g, "")) : null,
  };
}
