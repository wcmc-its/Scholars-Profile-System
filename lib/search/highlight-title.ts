/**
 * Shared "very light red" title-highlight convention for /search.
 *
 * Extracted from `publication-result-row.tsx` so the Publications tab AND the
 * People-card "Key papers" disclosure render matched terms identically: the
 * OpenSearch (or term-wrapped) `<mark>` fragment is whitelisted to scientific
 * markup + `<mark>`, adjacent marks merge into one pill, repeats unwrap
 * (anti-strobe), and the survivors get the pale Cornell-red tint — never the
 * post-it-yellow `<mark>` default (#20). Pure string→string; no React.
 */

// Keep the scientific-notation whitelist + <mark>; the indexed title may carry
// <sub>/<sup>/<i>/<b> markup. Everything else is dropped.
const TITLE_TAG_WHITELIST = /^(?:i|em|b|strong|sup|sub|mark)$/;
export const MARK_CLASS = "box-decoration-clone rounded-[3px] bg-[#b31b1b]/10 px-[3px]";

export function highlightedTitleHtml(fragment: string): string {
  // 1. Keep the scientific-notation whitelist + <mark>; drop everything else.
  //    Normalize marks to a bare tag; the pill class is applied in step 3.
  const cleaned = fragment.replace(
    /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi,
    (_, slash: string, raw: string) => {
      const name = raw.toLowerCase();
      if (!TITLE_TAG_WHITELIST.test(name)) return "";
      return slash ? `</${name}>` : `<${name}>`;
    },
  );
  // 2. Merge adjacent marks separated only by whitespace into one pill, so a
  //    contiguous phrase ("Microbiome Research") reads as a single highlight
  //    rather than two abutting tinted boxes.
  const merged = cleaned.replace(/<\/mark>(\s+)<mark>/gi, "$1");
  // 3. First-occurrence-only: a title that repeats a matched term shouldn't
  //    strobe. Keep the first <mark> per normalized term, unwrap later repeats,
  //    and apply the pale-tint pill to the survivors.
  const seen = new Set<string>();
  return merged.replace(/<mark>([\s\S]*?)<\/mark>/gi, (_, inner: string) => {
    const key = inner.replace(/<[^>]*>/g, "").toLowerCase().trim();
    if (seen.has(key)) return inner;
    seen.add(key);
    return `<mark class="${MARK_CLASS}">${inner}</mark>`;
  });
}
