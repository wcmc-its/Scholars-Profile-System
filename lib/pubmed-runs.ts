/**
 * Shared inline-tag → docx `TextRun` builder for PubMed-style strings
 * (titles, abstracts, justifications). Used by every Word export so a
 * single whitelist controls how `<i>`, `<em>`, `<b>`, `<strong>`,
 * `<sup>`, `<sub>` translate into Word run properties.
 *
 * Tag mapping
 *   <i>, <em>           → italics: true
 *   <b>, <strong>       → bold: true   (only when `allowBold` is set)
 *   <sup>               → superScript: true
 *   <sub>               → subScript: true
 *   anything else       → silently dropped (text between tags is kept)
 *
 * Attribute-bearing whitelist tags (`<i class=x>`) are normalized to bare
 * tags first, and entities (`&lt;18`, `&amp;`, `&#946;`) are decoded so Word
 * shows the character rather than the escape (see `lib/pubmed-segments.ts`).
 *
 * `allowBold` defaults to false so Vancouver bibliography titles stay
 * sentence-case plain (matches NLM style). Abstract callers pass
 * `allowBold: true` so PubMed structured-abstract headers like
 * `<b>Background:</b>` render as bold runs instead of literal tags.
 *
 * Smart quotes / en+em dashes are normalized for citation consistency
 * (PubMed records inherit publisher punctuation and bibliographies
 * look uneven when half the titles have curly quotes and half don't).
 * Set `normalize: false` for surfaces where the original punctuation
 * should be preserved.
 */
import { TextRun } from "docx";
import { pubmedSegments } from "@/lib/pubmed-segments";

function normalizeCitationPunctuation(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'") // curly singles → '
    .replace(/[“”„‟]/g, '"') // curly doubles → "
    .replace(/–/g, "-") // en dash → hyphen (page ranges)
    .replace(/—/g, "--"); // em dash
}

export function buildPubmedRuns(
  text: string,
  opts: { allowBold?: boolean; normalize?: boolean } = {},
): TextRun[] {
  const allowBold = opts.allowBold === true;
  const normalize = opts.normalize !== false; // default true
  // pubmedSegments normalizes attributed tags, drops non-whitelist tags (incl.
  // legacy `<u>` — Word underlines look like links) and decodes entities.
  return pubmedSegments(text).map(
    (seg) =>
      new TextRun({
        text: normalize ? normalizeCitationPunctuation(seg.text) : seg.text,
        ...(seg.italic ? { italics: true } : {}),
        ...(allowBold && seg.bold ? { bold: true } : {}),
        ...(seg.sup ? { superScript: true } : {}),
        ...(seg.sub ? { subScript: true } : {}),
      }),
  );
}
