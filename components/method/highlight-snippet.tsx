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

/** A sentence-final char, optionally followed by a closing quote/bracket. */
const ENDS_A_SENTENCE = /[.!?]["'”’)\]]?$/;

/**
 * Decide whether an extracted snippet reads as a mid-sentence fragment at its
 * start (lowercase initial) or end (no terminal punctuation), so the display can
 * mark the omission with a leading / trailing ellipsis. The durable fix is
 * sentence-aligned extraction in the producer (ReciterAI #254); this is the
 * display-side fallback for the fragments shipping today, applied to EVERY
 * snippet surface because every one renders through `highlightSnippet`.
 */
export function snippetEllipsis(sentence: string): { lead: string; trail: string } {
  const s = sentence.trim();
  if (!s) return { lead: "", trail: "" };
  return {
    lead: /^[a-z]/.test(s) && !s.startsWith("…") ? "…" : "",
    trail: ENDS_A_SENTENCE.test(s) || s.endsWith("…") ? "" : "…",
  };
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
  // Fragment-boundary ellipsis (display fallback until the producer emits
  // sentence-aligned spans — ReciterAI #254). A leading "…" shifts every char
  // index, so the matched span moves with it.
  const { lead, trail } = snippetEllipsis(sentence);
  const text = `${lead}${sentence}${trail}`;
  const adj =
    span && lead ? { start: span.start + lead.length, end: span.end + lead.length } : span;

  // Offset-driven (preferred): slice into pre / match / post. Guarded so a stale
  // or malformed span can never throw or mis-slice — it falls through to matching.
  if (
    adj &&
    Number.isInteger(adj.start) &&
    Number.isInteger(adj.end) &&
    adj.start >= 0 &&
    adj.end > adj.start &&
    adj.end <= text.length
  ) {
    return (
      <>
        {text.slice(0, adj.start)}
        <mark className={markClassName}>{text.slice(adj.start, adj.end)}</mark>
        {text.slice(adj.end)}
      </>
    );
  }

  // Interim fallback: case-insensitive term match (capturing split keeps the
  // matched substrings at odd indices, preserving the sentence's own casing).
  const t = term.trim();
  if (!t) return text;
  const parts = text.split(new RegExp(`(${escapeRegExp(t)})`, "gi"));
  if (parts.length === 1) return text; // no occurrence
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
