/**
 * Method services: which of a service's supported publications have an author
 * from the unit, judged by what PubMed holds about each author. A unit's
 * phrases (its own name, as its people write it in an affiliation) catch staff
 * who are not faculty and people who have since left, neither of whom Scholars
 * can see. A unit's author names catch the same people on a paper where their
 * affiliation is written another way: a parent department, the bare
 * institution, a later employer, or nothing at all.
 *
 * Pure, importing only the pure name comparison: the route fetches the authors
 * (`fetchAuthorAffiliations`, `lib/edit/pubmed-affiliations.ts`) and stores
 * what this works out as `method_service.coauthored_pmids` (the matches) and
 * `method_service.affiliation_checked_pmids` (every supported PMID PubMed has
 * answered for, against the current phrases and names). The matches found by
 * an author name alone are also kept, as `method_service.name_matched_pmids`,
 * only so the editor's review list can say why.
 *
 * The second list is what makes the lookup resumable. PubMed is read inside a
 * save request with a deadline, and a long supported list does not fit in one:
 * each save keeps what it read, and the next asks only for the rest. It also
 * means a PMID PubMed was not asked about, or did not answer for, is never
 * mistaken for one with no matching author.
 */

import {
  authorNameKey,
  pubmedAuthorKey,
  type PubMedAuthorName,
} from "@/lib/method-services/author-names";

/** Lowercased, with every run of whitespace as one space. */
const fold = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

/** How a supported publication was found to have an author from the unit. An
 *  affiliation match wins when both apply. */
export type CoauthorMatch = "affiliation" | "author_name";

const NO_AUTHORS: ReadonlyMap<string, ReadonlyArray<PubMedAuthorName>> = new Map();

/**
 * The supported PMIDs with an author from the unit, each with how it was
 * found, in the order of `supportedPmids`, de-duplicated:
 *   - `affiliation`: an author has an affiliation containing ANY of the
 *     phrases, ignoring case and runs of whitespace;
 *   - `author_name`: otherwise, an author has the family name and the first
 *     initial of ANY of the names (`authorNameKey`): "Rivera Stone B" matches
 *     LastName "Rivera Stone" with Initials "B" or "BK", and not Initials "K".
 * No phrases and no names, or a PMID PubMed returned nothing for, matches
 * nothing.
 */
export function classifyCoauthoredPmids(
  supportedPmids: ReadonlyArray<string>,
  affiliationsByPmid: ReadonlyMap<string, ReadonlyArray<string>>,
  phrases: ReadonlyArray<string>,
  authorsByPmid: ReadonlyMap<string, ReadonlyArray<PubMedAuthorName>> = NO_AUTHORS,
  authorNames: ReadonlyArray<string> = [],
): Map<string, CoauthorMatch> {
  const out = new Map<string, CoauthorMatch>();
  const needles = phrases.map(fold).filter((p) => p.length > 0);
  const names = new Set(authorNames.flatMap((n) => authorNameKey(n) ?? []));
  if (needles.length === 0 && names.size === 0) return out;
  const seen = new Set<string>();
  for (const pmid of supportedPmids) {
    if (seen.has(pmid)) continue;
    seen.add(pmid);
    const affiliations = affiliationsByPmid.get(pmid) ?? [];
    if (affiliations.some((a) => needles.some((n) => fold(a).includes(n)))) {
      out.set(pmid, "affiliation");
      continue;
    }
    if (names.size === 0) continue;
    const authors = authorsByPmid.get(pmid) ?? [];
    if (authors.some((a) => names.has(pubmedAuthorKey(a) ?? ""))) out.set(pmid, "author_name");
  }
  return out;
}

/** {@link classifyCoauthoredPmids} as the list the route stores: the supported
 *  PMIDs matching an affiliation phrase OR an author name. */
export function matchCoauthoredPmids(
  supportedPmids: ReadonlyArray<string>,
  affiliationsByPmid: ReadonlyMap<string, ReadonlyArray<string>>,
  phrases: ReadonlyArray<string>,
  authorsByPmid: ReadonlyMap<string, ReadonlyArray<PubMedAuthorName>> = NO_AUTHORS,
  authorNames: ReadonlyArray<string> = [],
): string[] {
  return [
    ...classifyCoauthoredPmids(supportedPmids, affiliationsByPmid, phrases, authorsByPmid, authorNames).keys(),
  ];
}

/** What is known from PubMed so far: the supported PMIDs already compared
 *  with the phrases and names, the ones among them that matched, and the ones
 *  among THOSE found by an author name and not by an affiliation. */
export type AffiliationProgress = { checked: string[]; coauthored: string[]; nameMatched: string[] };

const NO_PROGRESS: AffiliationProgress = { checked: [], coauthored: [], nameMatched: [] };

/** The phrases and names a check was made against, as one comparable set. */
function criteria(phrases: ReadonlyArray<string>, authorNames: ReadonlyArray<string>): Set<string> {
  return new Set([
    ...phrases.map(fold).filter((p) => p.length > 0).map((p) => `phrase:${p}`),
    ...authorNames.flatMap((n) => authorNameKey(n) ?? []).map((k) => `name:${k}`),
  ]);
}

/**
 * How much of a stored lookup still holds once the supported list, the phrases
 * and the author names are what `next` says. Phrases and names are treated
 * alike:
 *   - the same phrases and names: everything checked that is still supported;
 *   - only added to: the stored matches still match, so they are kept, and
 *     every other PMID must be compared again with what is new;
 *   - a phrase or a name removed or reworded: nothing, since a stored match
 *     may have been for it.
 * `stored: null` (a new service) and neither phrases nor names carry nothing.
 *
 * A carried match keeps the reason it was found by. Each reason stays true (a
 * match by a name that is still listed is still a match by that name), though
 * a publication found by a name is not re-read to see whether a phrase added
 * later would now match it too.
 */
export function carriedAffiliationProgress(
  stored: {
    phrases: ReadonlyArray<string>;
    authorNames?: ReadonlyArray<string>;
    checked: ReadonlyArray<string>;
    coauthored: ReadonlyArray<string>;
    nameMatched?: ReadonlyArray<string>;
  } | null,
  next: {
    supportedPmids: ReadonlyArray<string>;
    phrases: ReadonlyArray<string>;
    authorNames?: ReadonlyArray<string>;
  },
): AffiliationProgress {
  if (!stored) return NO_PROGRESS;
  const before = criteria(stored.phrases, stored.authorNames ?? []);
  const after = criteria(next.phrases, next.authorNames ?? []);
  if (after.size === 0 || ![...before].every((p) => after.has(p))) return NO_PROGRESS;
  const supported = new Set(next.supportedPmids);
  const checkedBefore = new Set(stored.checked);
  // A match only stands while PubMed's answer for it is on record.
  const coauthored = [...new Set(stored.coauthored)].filter(
    (p) => supported.has(p) && checkedBefore.has(p),
  );
  const byName = new Set(stored.nameMatched ?? []);
  const nameMatched = coauthored.filter((p) => byName.has(p));
  if (before.size !== after.size) return { checked: coauthored, coauthored, nameMatched };
  return {
    checked: [...checkedBefore].filter((p) => supported.has(p)),
    coauthored,
    nameMatched,
  };
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
 * not answer for; `authorsByPmid` holds the same records' author names). All
 * three lists come back in the order of `supportedPmids`. `complete` when
 * every supported PMID has now been checked.
 */
export function mergeAffiliationLookup(
  supportedPmids: ReadonlyArray<string>,
  phrases: ReadonlyArray<string>,
  carried: AffiliationProgress,
  affiliationsByPmid: ReadonlyMap<string, ReadonlyArray<string>>,
  authorNames: ReadonlyArray<string> = [],
  authorsByPmid: ReadonlyMap<string, ReadonlyArray<PubMedAuthorName>> = NO_AUTHORS,
): AffiliationProgress & { complete: boolean } {
  const supported = [...new Set(supportedPmids)];
  const checked = new Set(carried.checked);
  const coauthored = new Set(carried.coauthored);
  const nameMatched = new Set(carried.nameMatched);
  const asked = supported.filter((p) => !checked.has(p) && affiliationsByPmid.has(p));
  for (const pmid of asked) checked.add(pmid);
  const found = classifyCoauthoredPmids(asked, affiliationsByPmid, phrases, authorsByPmid, authorNames);
  for (const [pmid, how] of found) {
    coauthored.add(pmid);
    if (how === "author_name") nameMatched.add(pmid);
  }
  return {
    checked: supported.filter((p) => checked.has(p)),
    coauthored: supported.filter((p) => coauthored.has(p)),
    nameMatched: supported.filter((p) => coauthored.has(p) && nameMatched.has(p)),
    complete: supported.every((p) => checked.has(p)),
  };
}
