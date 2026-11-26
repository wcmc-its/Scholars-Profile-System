/**
 * Method services: which of a service's supported publications have an author
 * from the unit, judged by the author affiliations PubMed holds. A unit's
 * phrases (its own name, as its people write it) catch staff who are not
 * faculty and people who have since left, neither of whom Scholars can see.
 *
 * Pure, with no imports: the route fetches the affiliations
 * (`fetchAuthorAffiliations`, `lib/edit/pubmed-affiliations.ts`) and stores
 * what this returns as `method_service.coauthored_pmids`.
 */

/** Lowercased, with every run of whitespace as one space. */
const fold = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The supported PMIDs where at least one author has an affiliation containing
 * ANY of the phrases, ignoring case and runs of whitespace. In the order of
 * `supportedPmids`, de-duplicated. No phrases, or a PMID PubMed returned
 * nothing for, matches nothing.
 */
export function matchCoauthoredPmids(
  supportedPmids: ReadonlyArray<string>,
  affiliationsByPmid: ReadonlyMap<string, ReadonlyArray<string>>,
  phrases: ReadonlyArray<string>,
): string[] {
  const needles = phrases.map(fold).filter((p) => p.length > 0);
  if (needles.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pmid of supportedPmids) {
    if (seen.has(pmid)) continue;
    seen.add(pmid);
    const affiliations = affiliationsByPmid.get(pmid) ?? [];
    if (affiliations.some((a) => needles.some((n) => fold(a).includes(n)))) out.push(pmid);
  }
  return out;
}
