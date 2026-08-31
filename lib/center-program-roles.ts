/**
 * #1570 — shared copy for a center program's leadership types.
 *
 * "COE" is the one abbreviation on a program page that a reader can't decode from
 * context, so it is expanded on hover/focus in both places it appears: the public
 * program page (`components/scholar/leader-card.tsx`) and the center editor
 * (`components/edit/center-program-card.tsx`). Kept here so the two never drift —
 * this module is dependency-free (in the `@/lib/db`/prisma sense — see
 * `lib/org-unit-roles.ts`'s own docblock) and safe to import from a server or a
 * client component.
 *
 * #2558 Phase 1 — `COE_EXPANSION`'s canonical value now lives in
 * `lib/org-unit-roles.ts`, as the `center_program` vocabulary's `coe_liaison`
 * entry `expansion`: folding `coe_liaison` into the org-unit role vocabulary
 * means the vocabulary is now the source of truth, not a second hardcoded
 * copy here. Re-exported so this file's two existing importers keep working
 * unchanged, and stay fed from the vocabulary value rather than a duplicate.
 */
import { COE_EXPANSION } from "@/lib/org-unit-roles";

/** The abbreviation as rendered. */
export const COE_ABBR = "COE";

/** What `COE_ABBR` stands for — see the docblock above for where this comes from. */
export { COE_EXPANSION };

/** Sentence shown in the editor's help tooltip next to the leadership dropdown. */
export const COE_HELP =
  `COE stands for ${COE_EXPANSION}. A program's COE Liaison connects its research ` +
  `to the surrounding community. On the public program page, Leaders are listed ` +
  `first, then COE Liaisons in a separate card.`;
