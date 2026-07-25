/**
 * The descendant-term list, in the two shapes the two surfaces render it:
 * {@link descendantSummary} builds the "(matched …)" parenthetical for the Publications
 * row (`publication-result-row.tsx`), and {@link descendantViaSummary} builds the People
 * card's own "via …" line (`result-evidence.tsx`). Separate exports, separate budgets —
 * they annotate boxes of different widths, so changing one must not move the other.
 *
 * Pure string→string; no React, no server imports (both callers are in the client
 * bundle).
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
 * #1907 — rendered-character budget for the parenthetical, which rides INSIDE the
 * Publications row's truncating reason line. Overflow there does not wrap, it clips
 * mid-word at the pixel boundary, which cuts the parenthetical open: the reader gets
 * "(matched Leukemia, Hairy Cell, Leukemia, Lymphocytic, …" with no closing paren and
 * no "+N more".
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

/**
 * Uniform fold rule — the budget for the People card's "via …" line, and unlike
 * {@link BUDGET} it covers the WHOLE rendered string, tail included.
 *
 * The tail is the part worth protecting: " and 5 related terms" is the only thing saying
 * the list is partial, and it sits LAST, so a clip eats it first and leaves a line that
 * looks complete while being short. Budgeting the joined terms alone measured only part
 * of what ships: a 40-character list passed, then obliged a 19-character tail, and 59
 * characters reached the box.
 *
 * 48, measured in Chromium at 11.5px Inter: the narrowest layout that renders this line
 * is the expandable primary lead at the `lg` breakpoint, whose body column measures
 * 308.4px; the renderer's own "via " prefix takes 15.7px of it, and the widest real MeSH
 * descriptor text runs 5.86px/char, so 48 × 5.86 + 15.7 = 297px with ~11px to spare.
 * Wider viewports leave slack, which is the right direction for a safe-side heuristic.
 * Below `lg` the row stacks and the line is narrower still — it truncates there like any
 * long text, which is why the tail has to be inside the budget rather than trusted to fit.
 */
const VIA_BUDGET = 48;

/**
 * Uniform fold rule — the same list for the People card's own "via …" LINE, where the
 * remainder reads as prose ("and 5 related terms") instead of the "+N more" tail.
 *
 * The tail is the only difference in kind: "+2 more" is a truncation notice that belongs
 * next to a truncated thing, and on its own line the list is not truncated — it is a
 * summary of a set, so it counts the set. Dropping terms WHOLE is the same #1907 property
 * {@link descendantSummary} has; it cannot share that function's loop because dropping a
 * term here also LENGTHENS the tail, so the fit has to be re-tested against the rendered
 * string each time rather than against the joined terms.
 *
 * One term still always survives, and that is the one case a rendered line can exceed
 * {@link VIA_BUDGET} — a lone over-long descriptor plus its tail. Naming the match beats
 * fitting the box, and the alternative (dropping the tail instead) would hide exactly the
 * partiality this line exists to state.
 */
export function descendantViaSummary(terms: string[], cap = 2): string {
  const render = (shown: string[]): string => {
    const more = terms.length - shown.length;
    const body = shown.join(DESCENDANT_SEPARATOR);
    return more > 0 ? `${body} and ${more} related term${more === 1 ? "" : "s"}` : body;
  };
  let shown = terms.slice(0, cap);
  while (shown.length > 1 && render(shown).length > VIA_BUDGET) {
    shown = shown.slice(0, -1);
  }
  return render(shown);
}
