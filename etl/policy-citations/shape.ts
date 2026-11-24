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
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** NCBI titles carry entities and inline markup ("GeneReviews<sup>&#xAE;</sup>"). */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] !== "#"
        ? (ENTITIES[e.toLowerCase()] ?? m)
        : String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
    )
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  summary: { title?: string; pubdate?: string },
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
