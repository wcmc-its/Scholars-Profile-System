import type { Prisma } from "@/lib/generated/prisma/client";

/**
 * Per-token `where` clauses for a scholar name / CWID search box, meant to be
 * spread into an AND accumulator: `and.push(...buildScholarNameClauses(q))`.
 *
 * The query is split on whitespace and each token becomes its own clause, so the
 * tokens are AND-ed — "Jane Smith" requires both "Jane" and "Smith", each
 * matching ANY of `preferredName` / `fullName` / `cwid`. Feeding the whole query
 * as one `contains` (the previous shape) missed whenever the stored `fullName`
 * carried a middle name, or the words were ordered differently across the two
 * name columns; AND-ing the tokens fixes that and shrinks the result set so an
 * alphabetical cap stops hiding the intended person. `contains` (not an exact
 * match) preserves partial-CWID search; the columns are case-insensitive by the
 * MariaDB collation, so no Prisma `mode` is needed — nor is it supported on
 * MySQL. Mirrors `buildDirectoryNameFilter` (the LDAP directory typeahead) in
 * Prisma terms.
 *
 * A single-token query yields exactly one `{ OR: [...] }` clause — identical to
 * the old OR-group — so single-word searches are unchanged; only multi-word
 * queries gain the tokenization. A blank query yields `[]` (spreads to nothing).
 */
export function buildScholarNameClauses(query: string): Prisma.ScholarWhereInput[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => ({
      OR: [
        { preferredName: { contains: token } },
        { fullName: { contains: token } },
        { cwid: { contains: token } },
      ],
    }));
}
