// Shared OpenSearch-highlight renderer for search result rows. The query is
// wrapped in <mark> server-side; this renders the marks as the SAME light
// Cornell-red pill as publication/grant titles (#1361 — unified on one matched-term
// treatment; the original #20 anti-pattern was the post-it-YELLOW default, which the
// red-at-10% pill is not). The `overview` field can carry raw HTML (<p>, <br>,
// &nbsp;, &amp;, …) from source bios; strip non-mark tags and decode the common
// named/numeric entities so they don't render as literal text.
//
// Extracted from people-result-card.tsx (#824 Phase 1) so the new
// <ResultEvidence> component renders name/bio/affiliation highlights identically.
import { MARK_CLASS } from "@/lib/search/highlight-title";

export function stripHtmlTags(s: string): string {
  return s.replace(/<(?!\/?mark\b)[^>]*>/gi, "");
}

export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return s
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, n) => named[n.toLowerCase()] ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

export function HighlightedSnippet({ html }: { html: string }) {
  const cleaned = decodeEntities(stripHtmlTags(html));
  return (
    <>
      {cleaned.split(/(<mark>.*?<\/mark>)/g).map((part, i) =>
        part.startsWith("<mark>") ? (
          <mark key={i} className={MARK_CLASS}>
            {part.replace(/<\/?mark>/g, "")}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
