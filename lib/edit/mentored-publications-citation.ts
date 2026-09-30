/**
 * The one-line Vancouver citation the Mentored publications report's
 * Publications view prints for a bridge `CoPublicationFull`:
 *
 *   `Smith JA, Jones B, et al. Title. Journal. 2024;83(4):500-510.`
 *
 * Authors are `Last FM` tokens, at most six then `et al` (`vancouverAuthorList`);
 * the title loses its inline PubMed markup and trailing period; the
 * volume/issue/pages segment is the shared `formatVolIssuePages` (which treats
 * a literal "NULL" as absent) — no second formatter. The identifier (PMID link)
 * is rendered by the caller from `citationIdentifier`, since it is a link, not
 * text. Pure — no DB — so the page and its tests import it freely.
 */
import type { CoPublicationFull } from "@/lib/api/mentoring";
import { formatVolIssuePages, vancouverAuthorList } from "@/lib/citation";
import { htmlToPlainText } from "@/lib/utils";

export type CitationSource = Pick<
  CoPublicationFull,
  "title" | "journal" | "year" | "volume" | "issue" | "pages" | "authors"
>;

export function mentoredPubCitation(pub: CitationSource): string {
  const parts: string[] = [];
  const authors = vancouverAuthorList(pub.authors ?? []);
  if (authors) parts.push(`${authors}.`);
  const title = htmlToPlainText(pub.title ?? "", Number.POSITIVE_INFINITY)
    .replace(/\.+$/, "")
    .trim();
  if (title) parts.push(`${title}.`);
  const journal = (pub.journal ?? "").trim();
  if (journal) parts.push(`${journal}.`);
  if (pub.year !== null && pub.year !== undefined) {
    const vip = formatVolIssuePages(pub.volume, pub.issue, pub.pages);
    parts.push(vip ? `${pub.year};${vip}.` : `${pub.year}.`);
  }
  return parts.join(" ");
}
