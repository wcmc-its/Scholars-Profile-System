/**
 * Method services: which of a service's supported publications have an author
 * from the unit, judged by the author affiliations PubMed holds. A unit's
 * phrases (its own name, as its people write it) catch staff who are not
 * faculty and people who have since left, neither of whom Scholars can see.
 *
 * Pure, with no imports: the route fetches the affiliations
 * (`fetchAuthorAffiliations`, `lib/edit/pubmed-affiliations.ts`) and stores
 * what this works out as `method_service.coauthored_pmids` (the matches) and
 * `method_service.affiliation_checked_pmids` (every supported PMID PubMed has
 * answered for, against the current phrases).
 *
 * The second list is what makes the lookup resumable. PubMed is read inside a
 * save request with a deadline, and a long supported list does not fit in one:
 * each save keeps what it read, and the next asks only for the rest. It also
 * means a PMID PubMed was not asked about, or did not answer for, is never
 * mistaken for one with no matching author.
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

/** What is known from PubMed so far: the supported PMIDs already compared
 *  with the phrases, and the ones among them that matched. */
export type AffiliationProgress = { checked: string[]; coauthored: string[] };

const NO_PROGRESS: AffiliationProgress = { checked: [], coauthored: [] };

/**
 * How much of a stored lookup still holds once the supported list and the
 * phrases are what `next` says:
 *   - the same phrases: everything checked that is still supported;
 *   - phrases only added: the stored matches still match, so they are kept,
 *     and every other PMID must be compared again with the new phrases;
 *   - a phrase removed or reworded: nothing, since a stored match may have
 *     been for that phrase.
 * `stored: null` (a new service) and no phrases both carry nothing.
 */
export function carriedAffiliationProgress(
  stored: {
    phrases: ReadonlyArray<string>;
    checked: ReadonlyArray<string>;
    coauthored: ReadonlyArray<string>;
  } | null,
  next: { supportedPmids: ReadonlyArray<string>; phrases: ReadonlyArray<string> },
): AffiliationProgress {
  if (!stored) return NO_PROGRESS;
  const before = new Set(stored.phrases.map(fold).filter((p) => p.length > 0));
  const after = new Set(next.phrases.map(fold).filter((p) => p.length > 0));
  if (after.size === 0 || ![...before].every((p) => after.has(p))) return NO_PROGRESS;
  const supported = new Set(next.supportedPmids);
  const checkedBefore = new Set(stored.checked);
  // A match only stands while PubMed's answer for it is on record.
  const coauthored = [...new Set(stored.coauthored)].filter(
    (p) => supported.has(p) && checkedBefore.has(p),
  );
  if (before.size !== after.size) return { checked: coauthored, coauthored };
  return { checked: [...checkedBefore].filter((p) => supported.has(p)), coauthored };
}

/** The supported PMIDs PubMed still has to be asked about. */
export function pmidsToCheck(
  supportedPmids: ReadonlyArray<string>,
  carried: AffiliationProgress,
): string[] {
  const done = new Set(carried.checked);
  return [...new Set(supportedPmids)].filter((p) => !done.has(p));
}

/**
 * `carried` plus what PubMed has just answered (`affiliationsByPmid`: an entry
 * for each PMID it answered for, none for one it was not asked about or did
 * not answer for). Both lists come back in the order of `supportedPmids`.
 * `complete` when every supported PMID has now been checked.
 */
export function mergeAffiliationLookup(
  supportedPmids: ReadonlyArray<string>,
  phrases: ReadonlyArray<string>,
  carried: AffiliationProgress,
  affiliationsByPmid: ReadonlyMap<string, ReadonlyArray<string>>,
): AffiliationProgress & { complete: boolean } {
  const supported = [...new Set(supportedPmids)];
  const checked = new Set(carried.checked);
  const coauthored = new Set(carried.coauthored);
  const asked = supported.filter((p) => !checked.has(p) && affiliationsByPmid.has(p));
  for (const pmid of asked) checked.add(pmid);
  for (const pmid of matchCoauthoredPmids(asked, affiliationsByPmid, phrases)) coauthored.add(pmid);
  return {
    checked: supported.filter((p) => checked.has(p)),
    coauthored: supported.filter((p) => coauthored.has(p)),
    complete: supported.every((p) => checked.has(p)),
  };
}
