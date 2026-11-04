/**
 * Pure (dependency-free) segmenter for PubMed-style inline markup. Splits a
 * title/abstract string into plain-text segments, each tagged with the inline
 * formatting in force (`<i>`/`<em>` italic, `<b>`/`<strong>` bold, `<sup>`,
 * `<sub>`). Shared by the `docx` TextRun builder (`lib/pubmed-runs.ts`) and the
 * WCM CV template filler (`lib/edit/cv-export.ts`), which has its own run type.
 *
 * The input is normalized with `sanitizePubmedHtml` first, so attribute-bearing
 * whitelist tags (`<i class="x">`) become bare tags and every other tag is
 * dropped (text between tags is kept). Segment text is entity-decoded — stored
 * titles routinely carry escaped comparators (`aged &lt;18`) — and Word/XML
 * writers escape it again on output.
 */
import { sanitizePubmedHtml } from "@/lib/utils";

export type PubmedSegment = {
  text: string;
  italic: boolean;
  bold: boolean;
  sup: boolean;
  sub: boolean;
};

type StackTag = "italic" | "bold" | "sup" | "sub";

/** Decode the entities PubMed strings carry. `&amp;` goes LAST so an escaped
 *  entity (`&amp;lt;`) decodes once, to the literal text `&lt;`. */
export function decodePubmedEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => fromCodePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec: string) => fromCodePoint(parseInt(dec, 10), m))
    .replace(/&amp;/g, "&");
}

function fromCodePoint(cp: number, fallback: string): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return fallback;
  }
}

export function pubmedSegments(input: string): PubmedSegment[] {
  const text = sanitizePubmedHtml(input);
  const segments: PubmedSegment[] = [];
  const tokenRe = /<\/?(i|em|b|strong|sup|sub)>/gi;
  const stack: StackTag[] = [];
  let lastIndex = 0;
  const push = (raw: string) => {
    if (!raw) return;
    const decoded = decodePubmedEntities(raw);
    if (!decoded) return;
    segments.push({
      text: decoded,
      italic: stack.includes("italic"),
      bold: stack.includes("bold"),
      sup: stack.includes("sup"),
      sub: stack.includes("sub"),
    });
  };
  for (const m of text.matchAll(tokenRe)) {
    const start = m.index ?? 0;
    if (start > lastIndex) push(text.slice(lastIndex, start));
    const raw = (m[1] ?? "").toLowerCase();
    const tag: StackTag =
      raw === "i" || raw === "em"
        ? "italic"
        : raw === "b" || raw === "strong"
          ? "bold"
          : raw === "sup"
            ? "sup"
            : "sub";
    if (m[0]!.startsWith("</")) {
      const idx = stack.lastIndexOf(tag);
      if (idx >= 0) stack.splice(idx, 1);
    } else {
      stack.push(tag);
    }
    lastIndex = start + m[0]!.length;
  }
  if (lastIndex < text.length) push(text.slice(lastIndex));
  return segments;
}
