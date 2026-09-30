/**
 * #2580 — the search Word bibliography's identifier block and volume/issue/pages
 * segment, asserted on the REAL packed .docx.
 *
 * This is the surface where the second defect actually hurts: `Publication.pmid`
 * is `String @id @db.VarChar(32)` and carries a source-prefixed article id for
 * non-PubMed records (`SCOPUS:105037533819`, ReCiterDB #101), which the builder
 * labelled `PMID:` and wrapped in a `pubmed.ncbi.nlm.nih.gov/SCOPUS:.../`
 * hyperlink — a link that 404s the moment the reader clicks it in Word. A docx
 * `ExternalHyperlink` lands in `word/_rels/document.xml.rels`, so the
 * relationship targets below are the real, checkable evidence that no dead link
 * is emitted.
 *
 * Synthetic pmids/authors only.
 */
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

/** Hits come back in this order; the fetcher preserves it. */
const HIT_PMIDS = ["38670054", "SCOPUS:105037533819"];

vi.mock("@/lib/search", () => ({
  PUBLICATIONS_INDEX: "scholars-publications",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  searchClient: () => ({
    async search() {
      return { body: { hits: { hits: HIT_PMIDS.map((pmid) => ({ _source: { pmid } })) } } };
    },
  }),
}));

const PUBS = [
  {
    pmid: "38670054",
    title: "Klotho and clinical outcomes in chronic kidney disease",
    authorsString: "Smith J, Doe A",
    fullAuthorsString: "Smith J, Doe A",
    journal: "American Journal of Kidney Diseases",
    journalAbbrev: "Am J Kidney Dis",
    year: 2024,
    volume: "83",
    issue: "4",
    pages: "500-510",
    doi: "10.1053/j.ajkd.2023.10.015",
    pmcid: "PMC11098699",
  },
  {
    // A Scopus-only record whose volume/issue/pages arrived as the literal
    // four-character word — both defects on one citation, exactly as reported.
    pmid: "SCOPUS:105037533819",
    title: "A paper indexed only outside PubMed",
    authorsString: "Roe B",
    fullAuthorsString: "Roe B",
    journal: "Journal of Test Results",
    journalAbbrev: null,
    year: 2024,
    volume: "NULL",
    issue: "NULL",
    pages: "NULL",
    doi: "10.9999/test.2024.1",
    pmcid: null,
  },
];

vi.mock("@/lib/db", () => ({
  prisma: {
    publication: { findMany: vi.fn(async () => PUBS) },
    scholar: { findMany: vi.fn(async () => []) },
  },
}));

import { generateWordBibliography } from "@/lib/api/word-bibliography";

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Concatenated visible text of the document. */
function allText(xml: string): string {
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  let s = "";
  while ((m = re.exec(xml))) s += decodeXml(m[1]!);
  return s;
}

async function renderBibliography(): Promise<{ text: string; linkTargets: string[] }> {
  const { buffer } = await generateWordBibliography({ q: "klotho" });
  const zip = await JSZip.loadAsync(buffer);
  const doc = await zip.file("word/document.xml")!.async("string");
  const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  const targets: string[] = [];
  const re = /Target="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rels))) targets.push(decodeXml(m[1]!));
  return { text: allText(doc), linkTargets: targets };
}

describe("Word bibliography — citation identifiers and vol/issue/pages (#2580)", () => {
  it("labels and hyperlinks a real PubMed id exactly as before", async () => {
    const { text, linkTargets } = await renderBibliography();
    expect(text).toContain("PMID: 38670054");
    expect(text).toContain("PMCID: PMC11098699");
    expect(linkTargets).toContain("https://pubmed.ncbi.nlm.nih.gov/38670054/");
  });

  it("labels a Scopus-only id by its source and emits NO PubMed hyperlink for it", async () => {
    const { text, linkTargets } = await renderBibliography();
    expect(text).toContain("Scopus: 105037533819");
    expect(text).not.toContain("PMID: SCOPUS");
    // The dead link the issue reported: nothing may point at pubmed.ncbi with a
    // non-PubMed id.
    expect(linkTargets).not.toContain("https://pubmed.ncbi.nlm.nih.gov/SCOPUS:105037533819/");
    expect(linkTargets.some((t) => t.includes("SCOPUS"))).toBe(false);
    // The DOI stays the resolvable link on that citation line.
    expect(linkTargets).toContain("https://doi.org/10.9999/test.2024.1");
  });

  it("never prints a literal 'NULL' volume/issue/pages", async () => {
    const { text } = await renderBibliography();
    expect(text).not.toContain("NULL");
    // The all-"NULL" record falls back to the year alone, with no dangling ";".
    expect(text).toContain("Journal of Test Results. 2024. ");
    // The record with real values is untouched.
    expect(text).toContain("Am J Kidney Dis. 2024;83(4):500-510. ");
  });
});
