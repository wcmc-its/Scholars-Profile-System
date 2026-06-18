// Shared OpenSearch-highlight renderer for search result rows. The query is
// wrapped in <mark> server-side; this rewrites the marks as <strong> with the
// design's typographic weight — never the post-it-yellow background the mockup
// calls out as an anti-pattern. (Issue #20 — earlier code split on <em> and let
// <mark> tags fall through as literal text.) The `overview` field can carry raw
// HTML (<p>, <br>, &nbsp;, &amp;, …) from source bios; strip non-mark tags and
// decode the common named/numeric entities so they don't render as literal text.
//
// Extracted from people-result-card.tsx (#824 Phase 1) so the new
// <ResultEvidence> component renders name/bio/affiliation highlights identically.

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
          <strong key={i} className="font-medium text-[#1a1a1a]">
            {part.replace(/<\/?mark>/g, "")}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
