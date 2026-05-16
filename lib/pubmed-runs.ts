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

type StackTag = "italic" | "bold" | "sup" | "sub";

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
  const runs: TextRun[] = [];
  // Match opening or closing tags for the inline whitelist plus `<u>`
  // (legacy — silently dropped because Word underlines look like links).
  const tokenRe = /<\/?(i|em|b|strong|sup|sub|u)>/gi;
  let lastIndex = 0;
  const stack: StackTag[] = [];
  const flush = (raw: string) => {
    if (!raw) return;
    const cleaned = normalize ? normalizeCitationPunctuation(raw) : raw;
    runs.push(
      new TextRun({
        text: cleaned,
        ...(stack.includes("italic") ? { italics: true } : {}),
        ...(allowBold && stack.includes("bold") ? { bold: true } : {}),
        ...(stack.includes("sup") ? { superScript: true } : {}),
        ...(stack.includes("sub") ? { subScript: true } : {}),
      }),
    );
  };
  for (const m of text.matchAll(tokenRe)) {
    const start = m.index ?? 0;
    if (start > lastIndex) flush(text.slice(lastIndex, start));
    const raw = (m[1] ?? "").toLowerCase();
    const isClose = m[0]!.startsWith("</");
    let tag: StackTag | null = null;
    if (raw === "i" || raw === "em") tag = "italic";
    else if (raw === "b" || raw === "strong") tag = "bold";
    else if (raw === "sup") tag = "sup";
    else if (raw === "sub") tag = "sub";
    if (tag !== null) {
      if (isClose) {
        const idx = stack.lastIndexOf(tag);
        if (idx >= 0) stack.splice(idx, 1);
      } else {
        stack.push(tag);
      }
    }
    // <u> tokens are silently dropped.
    lastIndex = start + m[0]!.length;
  }
  if (lastIndex < text.length) flush(text.slice(lastIndex));
  if (runs.length === 0) flush(text);
  return runs;
}
