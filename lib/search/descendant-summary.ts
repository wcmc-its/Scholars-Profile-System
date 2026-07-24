/**
 * The "(matched …)" descendant list shared by the three surfaces that render one:
 * the People card (`result-evidence.tsx`), the Publications row
 * (`publication-result-row.tsx`), and the sponsor card (`evidence-line.tsx`).
 *
 * Pure string→string; no React, no server imports (these callers are all in the
 * client bundle).
 */

/**
 * #1908 — the separator between descendant terms.
 *
 * NOT `", "`. MeSH descriptors are comma-inverted headings ("Leukemia, Hairy Cell",
 * "Leukemia, Lymphocytic, Chronic, B-Cell"), so a comma join collides with the terms'
 * own punctuation and renders two terms as six with no recoverable boundary. A middot
 * cannot appear inside a descriptor, so it is the one separator that stays unambiguous.
 */
export const DESCENDANT_SEPARATOR = " · ";

/**
 * #1907 — rendered-character budget for the list on the two surfaces whose row
 * CSS-truncates. Overflow there does not wrap, it clips mid-word at the pixel
 * boundary, which cuts the parenthetical open: the reader gets "(matched Leukemia,
 * Hairy Cell, Leukemia, Lymphocytic, …" with no closing paren and no "+N more".
 *
 * Dropping terms WHOLE keeps the sentence closed at a width the row can hold. It is a
 * heuristic (character count is not pixel width) but a safe-side one, and unlike a
 * measurement-based fix it stays deterministic and testable.
 */
const BUDGET = 56;

/**
 * Up to `cap` terms, comma-safe, with the remainder rolled into a "+N more" tail.
 *
 * One term always survives even when it busts the budget on its own: a lone descriptor
 * is the entire reason the row claims a match, so trimming it to nothing would leave
 * the row asserting a match it declines to name. Some descriptors really are that long
 * ("Precursor Cell Lymphoblastic Leukemia-Lymphoma"), and that is the honest render.
 */
export function descendantSummary(terms: string[], cap = 2): string {
  let shown = terms.slice(0, cap);
  while (shown.length > 1 && shown.join(DESCENDANT_SEPARATOR).length > BUDGET) {
    shown = shown.slice(0, -1);
  }
  const more = terms.length - shown.length;
  const body = shown.join(DESCENDANT_SEPARATOR);
  return more > 0 ? `${body}${DESCENDANT_SEPARATOR}+${more} more` : body;
}
