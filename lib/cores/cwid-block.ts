/**
 * Pure CWID-block parser shared by the "Known clients" server loader
 * (`lib/api/core-clients.ts`) and the panel component
 * (`components/edit/core-clients-panel.tsx`). Split out into its own module
 * so the client bundle can import the parser WITHOUT pulling in
 * `lib/api/core-clients.ts`'s `@/lib/db` import (a value import can't be
 * tree-shaken away from its module's other top-level imports the way a
 * type-only import can) — the same `lib/edit/manageable-units.ts` /
 * `home-panel.tsx` trap this repo already hit once.
 *
 * No imports from `@/lib/db` or anything that constructs prisma.
 */

/** A CWID is 2-5 letters followed by 1-6 digits (e.g. `djb2001`, `ab123`). */
export const CWID_PATTERN = /^[a-z]{2,5}[0-9]{1,6}$/;

/**
 * Split a pasted block on any run of whitespace, commas, or semicolons;
 * lowercase + trim each token, de-dupe, and classify as a well-formed CWID or
 * `invalid`. Pure — unit-tested without the network, mirroring
 * `parsePmidBlock`'s contract (nothing is silently dropped).
 */
export function parseCwidBlock(text: string): { cwids: string[]; invalid: string[] } {
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const cwids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (CWID_PATTERN.test(t)) {
      if (!seen.has(t)) {
        seen.add(t);
        cwids.push(t);
      }
    } else {
      invalid.push(t);
    }
  }
  return { cwids, invalid };
}
