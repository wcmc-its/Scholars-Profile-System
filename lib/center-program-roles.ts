/**
 * #1570 — shared copy for a center program's leadership types.
 *
 * The public program page (`components/scholar/leader-card.tsx`) no longer
 * imports from here as of #2558's contract PR: its "COE" `<abbr>` expansion is
 * now a prop (`LeaderCard`'s `expansion`) sourced per-request from the
 * `center_program` vocabulary's `coe_liaison` row (`OrgUnitRole.expansion`,
 * `lib/api/centers.ts`'s `getCenterProgram`), not a hardcoded import — a
 * steward-renamed label or expansion is honored without a redeploy. This file
 * still holds the STATIC help copy the editor shows beside its leadership-type
 * dropdown (`components/edit/center-program-card.tsx`), which composes
 * `COE_EXPANSION` (re-exported from `lib/org-unit-roles.ts`, the vocabulary's
 * seed value) into a full sentence. Dependency-free (in the `@/lib/db`/prisma
 * sense — see `lib/org-unit-roles.ts`'s own docblock) and safe to import from a
 * server or a client component.
 */
import { COE_EXPANSION } from "@/lib/org-unit-roles";

export { COE_EXPANSION };

/** Sentence shown in the editor's help tooltip next to the leadership dropdown. */
export const COE_HELP =
  `COE stands for ${COE_EXPANSION}. A program's COE Liaison connects its research ` +
  `to the surrounding community. On the public program page, Leaders are listed ` +
  `first, then COE Liaisons in a separate card.`;
