/** Surname sort/bolding key: drops trailing postnominal segments (", MD",
 *  ", PhD, MPH"), then takes the final whitespace-separated token, lower-cased.
 *  Handles "Maria T. Diaz-Meco" → "diaz-meco" and "Curtis Cole, MD" → "cole".
 *  Compound surnames like "van der Berg" sort by their final token ("berg"),
 *  matching how those are commonly indexed in faculty directories.
 *
 *  Dependency-free by design — imported from both server code
 *  (`lib/edit/cv-export.ts`) and `"use client"` components
 *  (`components/search/author-facet.tsx`, `investigator-facet.tsx`), so it
 *  must never gain an import that pulls in `node:fs` or any other server-only
 *  module (that trap is what kept the two client-side copies duplicated). */
export function lastNameKey(displayName: string): string {
  const noPostnom = displayName.split(/,\s*/)[0] ?? displayName;
  const tokens = noPostnom.trim().split(/\s+/);
  return (tokens[tokens.length - 1] ?? "").toLowerCase();
}
