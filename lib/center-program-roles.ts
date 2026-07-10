/**
 * #1570 — shared copy for a center program's leadership types.
 *
 * "COE" is the one abbreviation on a program page that a reader can't decode from
 * context, so it is expanded on hover/focus in both places it appears: the public
 * program page (`components/scholar/leader-card.tsx`) and the center editor
 * (`components/edit/center-program-card.tsx`). Kept here so the two never drift —
 * this module is dependency-free and safe to import from a server or a client
 * component.
 */

/** The abbreviation as rendered. */
export const COE_ABBR = "COE";

/** What `COE_ABBR` stands for. */
export const COE_EXPANSION = "Community Outreach & Engagement";

/** Sentence shown in the editor's help tooltip next to the leadership dropdown. */
export const COE_HELP =
  `COE stands for ${COE_EXPANSION}. A program's COE Liaison connects its research ` +
  `to the surrounding community. On the public program page, Leaders are listed ` +
  `first, then COE Liaisons in a separate card.`;
