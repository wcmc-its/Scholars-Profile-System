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
 * 308.4px, and the widest real MeSH descriptor text runs ~6.05px/char.
 *
 * The number no longer buys a ONE-LINE fit and is not meant to. It is measured against the
 * renderer's prefix "matched on narrower term " (144px of the 308px, against 16px for the old
 * "via "), which at one line would leave 27 characters — less than a single descriptor
 * plus its tail. Rather than shrink the budget to something no real term fits, the line
 * WRAPS: it is the last content on its own line with nothing trailing it, so a second
 * line is the whole cost and nothing clips. 48 chars + the prefix is 434px over a 308px
 * box, i.e. bounded at two lines, which is what this number now guarantees.
 *
 * #1955 made that prefix VARIABLE-WIDTH: the shorter "also tagged " renders for a scholar
 * who also carries the parent descriptor, "matched on narrower term " for one who does not.
 * The budget stays measured against the LONGER of the two — which is also the common one
 * (measured on staging, only 28.8% of the scholars this line renders for carry the parent) —
 * so the two-line bound above holds for both. Do NOT re-tighten it on the strength of the
 * shorter string: that would put the majority render back over the box, and the WRAP is what
 * fixed the #1907 tail clip in the first place.
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
