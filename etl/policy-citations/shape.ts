/**
 * Pure shaping for the policy-citations ETL: no I/O, so it is unit-tested
 * directly (tests/unit/policy-citations.test.ts).
 */
import { issuingBody } from "@/lib/citations/issuing-bodies";

export type Level = "authority" | "guideline" | "consensus" | "review";

export interface CitingDoc {
  source: "pubmed" | "bookshelf";
  externalId: string;
  title: string;
  year: number | null;
  url: string;
  level: Level;
  issuingBody: string | null;
  dedupKey: string;
  /** Citation fields. PubMed fills all but `publisher`; Bookshelf fills only that. */
  authors: string | null;
  journal: string | null;
  journalAbbrev: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  publisher: string | null;
}

/** The fields an existing row is back-filled with. */
export const CITATION_FIELDS = [
  "authors",
  "journal",
  "journalAbbrev",
  "volume",
  "issue",
  "pages",
  "doi",
  "publisher",
] as const;

/** A trimmed string cut to its column width, or null when NCBI sent nothing. */
function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

/** A PubMed ESummary record, as far as the citation needs it. */
export interface PubmedSummary {
  title?: string;
  pubdate?: string;
  authors?: Array<{ name?: string }>;
  source?: string;
  fulljournalname?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  articleids?: Array<{ idtype?: string; value?: string }>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** NCBI titles carry entities and inline markup ("GeneReviews<sup>&#xAE;</sup>"). */
export function cleanTitle(raw: string): string {
  let text = raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] !== "#"
      ? (ENTITIES[e.toLowerCase()] ?? m)
      : String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );
  // Repeat until nothing changes: removing a tag can splice a new one together
  // ("<scr<i>ipt>"). Only tag-shaped runs go, so "p < 0.05" keeps its sign.
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(/<\/?[a-z][^<>]*>/gi, "");
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The same guideline is often printed in several journals at once, each with
 * its own PMID. Normalized title + year makes them one document for counting.
 */
export function dedupKey(title: string, year: number | null): string {
  const norm = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180);
  return `${norm}|${year ?? ""}`;
}

/**
 * A citing PMID can carry several publication types. The strongest wins:
 * a guideline that is also a systematic review is a guideline.
 */
export function pubmedLevel(
  pmid: number,
  sets: { guideline: ReadonlySet<number>; consensus: ReadonlySet<number>; review: ReadonlySet<number> },
): Exclude<Level, "authority"> | null {
  if (sets.guideline.has(pmid)) return "guideline";
  if (sets.consensus.has(pmid)) return "consensus";
  if (sets.review.has(pmid)) return "review";
  return null;
}

export function pubmedDoc(
  pmid: number,
  level: Exclude<Level, "authority">,
  summary: PubmedSummary,
): CitingDoc {
  const title = cleanTitle(summary.title ?? "") || `PMID ${pmid}`;
  const y = /\d{4}/.exec(summary.pubdate ?? "");
  const year = y ? Number(y[0]) : null;
  return {
    source: "pubmed",
    externalId: String(pmid),
    title,
    year,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    level,
    issuingBody: null,
    dedupKey: dedupKey(title, year),
    // Group authors ("AASLD-IDSA Hepatitis C Guidance Panel") are listed with the people.
    authors: text((summary.authors ?? []).map((a) => a.name).filter(Boolean).join(", "), 65_000),
    journal: text(summary.fulljournalname, 512),
    journalAbbrev: text(summary.source, 200),
    volume: text(summary.volume, 64),
    issue: text(summary.issue, 128),
    pages: text(summary.pages, 128),
    doi: text(summary.articleids?.find((a) => a.idtype === "doi")?.value, 255),
    publisher: null,
  };
}

/**
 * A Bookshelf ESummary record is a section, table or reference list. Roll it up
 * to its book, and keep it only if a listed health authority published it.
 */
export function bookshelfDoc(summary: {
  bookaccessionid?: string;
  bookinfo?: string;
  title?: string;
}): CitingDoc | null {
  const accession = summary.bookaccessionid;
  const info = summary.bookinfo ?? "";
  const statement = /<PublicationStatement>(.*?)<\/PublicationStatement>/s.exec(info)?.[1] ?? "";
  const body = issuingBody(cleanTitle(statement));
  if (!accession || !body) return null;
  const bookTitle = /<(?:Parent|Self)\b[^>]*\btype="book"[^>]*>\s*<Title>(.*?)<\/Title>/s.exec(info)?.[1];
  const title = cleanTitle(bookTitle ?? summary.title ?? "") || accession;
  const y = /;\s*c?(\d{4})/.exec(statement);
  const year = y ? Number(y[1]) : null;
  return {
    source: "bookshelf",
    externalId: accession,
    title,
    year,
    url: `https://www.ncbi.nlm.nih.gov/books/${accession}/`,
    level: "authority",
    issuingBody: body,
    dedupKey: dedupKey(title, year),
    // ponytail: Bookshelf's summary has no author list or DOI, only the
    // publication statement. Fetch the book record if a DOI is ever needed.
    authors: null,
    journal: null,
    journalAbbrev: null,
    volume: null,
    issue: null,
    pages: null,
    doi: null,
    publisher: text(cleanTitle(statement), 512),
  };
}

/** `[{ body, count }]` for the publication row's badges, most documents first. */
export function authorityBodies(bodies: ReadonlyArray<string>): Array<{ body: string; count: number }> {
  const counts = new Map<string, number>();
  for (const b of bodies) counts.set(b, (counts.get(b) ?? 0) + 1);
  return [...counts]
    .map(([body, count]) => ({ body, count }))
    .sort((a, b) => b.count - a.count || a.body.localeCompare(b.body));
}
