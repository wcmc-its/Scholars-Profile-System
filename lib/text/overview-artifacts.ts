/**
 * Strip the two tail artifacts the VIVO-era overview corpus carries (#2207).
 *
 * 59 of the 552 seeded `scholar.overview` bodies end with the exact byte
 * sequence
 *
 *     <p></p> <p>[...]</p>
 *
 * which paints as a blank paragraph followed by a visible, literal `[...]`. The
 * `[...]` is an UPSTREAM TRUNCATION SENTINEL — the exporter's marker for "the
 * source bio continued past the cut" — and was never stripped on the one-time
 * corpus load. It is never prose: no scholar ends a bio with a paragraph whose
 * entire content is an ellipsis in brackets.
 *
 * Deliberately TAIL-ANCHORED. A `[...]` mid-paragraph is a real elision inside a
 * quotation and must survive; only a trailing paragraph that consists of nothing
 * BUT the sentinel is removed, along with any structurally-empty paragraph
 * (`<p></p>`, `<p>&nbsp;</p>`, `<p><br></p>`) or bare `<br>` run that trails it.
 * The two interleave in the corpus, so the strip loops until it reaches a fixed
 * point.
 *
 * Byte-preserving on clean input: an overview with no tail artifact comes back
 * `===` the input, including its trailing newline. Only when an artifact is
 * removed is the whitespace in front of it consumed with it, so the result never
 * gains a dangling separator.
 *
 * Two call sites, deliberately:
 *
 *  - `sanitizeOverviewHtml` (`lib/edit/validators.ts`) — the shared overview
 *    HTML boundary, run on BOTH the /edit save path and the `getEffectiveOverview`
 *    read-merge. Putting the strip there (rather than only on a save) is the same
 *    reasoning `repairEncoding` is there for: the read path re-sanitizes, so one
 *    call also heals every already-stored body, and a re-import of the legacy
 *    corpus cannot reintroduce the marker on any rendered surface.
 *  - `scripts/backfills/2026-08-05-strip-overview-tail-artifacts.ts` — the stored
 *    bytes. The read-merge does not cover every consumer: the OpenSearch people
 *    document (`lib/search-index-docs.ts`) and the overview generator's
 *    "existing bio" fact (`lib/edit/overview-facts.ts`) both read the RAW column,
 *    so the sanitizer alone would leave `[...]` in the search index and in an
 *    LLM prompt.
 */

/**
 * Everything that can fill a paragraph without painting a glyph: whitespace
 * (JS `\s` already covers U+00A0), the nbsp entity in its named / decimal / hex
 * forms, and a `<br>`.
 */
const BLANK = String.raw`(?:\s|&nbsp;|&#0*160;|&#[xX]0*[aA]0;|<br\s*\/?>)`;

/** An ellipsis: literal dots (optionally spaced), U+2026, or its entity forms. */
const ELLIPSIS = String.raw`(?:\.\s*\.\s*\.|…|&hellip;|&#0*8230;|&#[xX]0*2026;)`;

/**
 * A trailing paragraph whose entire content is the truncation sentinel —
 * `[...]`, `[…]`, `[. . .]` — with any leading whitespace consumed alongside it.
 * Attribute-tolerant (`<p style=…>`) because the backfill runs against RAW
 * corpus bytes, before DOMPurify has normalized anything.
 */
const TRAILING_TRUNCATION_PARAGRAPH = new RegExp(
  String.raw`\s*<p\b[^>]*>${BLANK}*\[${BLANK}*${ELLIPSIS}${BLANK}*\]${BLANK}*<\/p>\s*$`,
  "i",
);

/** A trailing paragraph that paints nothing at all. */
const TRAILING_BLANK_PARAGRAPH = new RegExp(
  String.raw`\s*<p\b[^>]*>${BLANK}*<\/p>\s*$`,
  "i",
);

/** A trailing run of bare `<br>` — the same "empty tail" defect without the `<p>`. */
const TRAILING_BREAKS = /\s*(?:<br\s*\/?>\s*)+$/i;

/**
 * Remove the trailing truncation sentinel and any empty tail blocks behind it.
 * Idempotent, and `===` the input when there is nothing to strip.
 */
export function stripOverviewTailArtifacts(html: string): string {
  let out = html;
  // Bounded rather than `while (true)`: each pass removes at least one block, so
  // a body would need 32 stacked empty paragraphs to hit the cap, and a
  // pathological input must not be able to spin here.
  for (let pass = 0; pass < 32; pass += 1) {
    const next = out
      .replace(TRAILING_TRUNCATION_PARAGRAPH, "")
      .replace(TRAILING_BLANK_PARAGRAPH, "")
      .replace(TRAILING_BREAKS, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Does this body carry a tail artifact? Defined as "the strip changes it", so
 * detection and repair can never disagree — the backfill's row filter and the
 * value it writes come from the same rule.
 */
export function hasOverviewTailArtifact(html: string): boolean {
  return stripOverviewTailArtifacts(html) !== html;
}
