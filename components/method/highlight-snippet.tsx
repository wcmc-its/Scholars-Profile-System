import { Fragment, type ReactNode } from "react";

/**
 * App-standard light matched-term highlight — the pale Cornell-red pill the search
 * results already use (`MARK_CLASS` in components/search/publication-result-row.tsx).
 * Reused here so the methods provenance rail matches the rest of the site rather
 * than the chat-design stand-in the mockups used.
 */
export const SNIPPET_MARK_CLASS = "box-decoration-clone rounded-[3px] bg-[#b31b1b]/10 px-[3px]";

/** Escape a string for safe interpolation into a RegExp (the term is data). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render `sentence` with the matched term `<mark>`-highlighted in place — the
 * load-bearing provenance affordance of the Methods & Tools redesign (spec
 * §4.2-A6/A7, §5.3/§5.4).
 *
 * Prefers `span` — the §7 `matched_span` char offsets, once #1166 emits them:
 * exact, casing-proof, and unambiguous when the term repeats or its acronym is
 * spelled out. Falls back to client-side case-insensitive matching of `term`
 * (the #1119 interim the publication modal shipped) when no span is supplied; per
 * spec §10 that fallback is replaced by offsets when the pipeline carries them.
 * Returns the plain sentence when neither yields a match.
 *
 * Always renders via React text nodes (never `dangerouslySetInnerHTML`), so it is
 * injection-safe by construction (spec §10 "sanitize before injecting").
 */
export function highlightSnippet(
  sentence: string,
  term: string,
  span?: { start: number; end: number } | null,
  markClassName: string = SNIPPET_MARK_CLASS,
): ReactNode {
  // Offset-driven (preferred): slice into pre / match / post. Guarded so a stale
  // or malformed span can never throw or mis-slice — it falls through to matching.
  if (
    span &&
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end > span.start &&
    span.end <= sentence.length
  ) {
    return (
      <>
        {sentence.slice(0, span.start)}
        <mark className={markClassName}>{sentence.slice(span.start, span.end)}</mark>
        {sentence.slice(span.end)}
      </>
    );
  }

  // Interim fallback: case-insensitive term match (capturing split keeps the
  // matched substrings at odd indices, preserving the sentence's own casing).
  const t = term.trim();
  if (!t) return sentence;
  const parts = sentence.split(new RegExp(`(${escapeRegExp(t)})`, "gi"));
  if (parts.length === 1) return sentence; // no occurrence
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className={markClassName}>
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
