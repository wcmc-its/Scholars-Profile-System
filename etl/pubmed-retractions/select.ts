/**
 * Pure selection helper for the PubMed-retraction ETL (issue #604). Kept
 * separate from index.ts so it is unit-testable without a DB or network.
 */

/** A corpus publication row, reduced to what the stamp decision needs. */
export interface CorpusPub {
  pmid: string;
  publicationType: string | null;
}

export const RETRACTION_TYPE = "Retraction";

/**
 * Given the corpus and the set of PMIDs PubMed marks as retracted, return the
 * PMIDs whose `publication_type` should be overwritten to 'Retraction'.
 *
 * We only stamp rows that are (a) in the retracted set and (b) not already
 * typed 'Retraction' — so re-running is a no-op once the corpus is converged,
 * and the count returned is the true number of newly-hidden papers.
 *
 * Un-retraction is handled implicitly by the pipeline, not here: the nightly
 * `etl:reciter` step overwrites `publication_type` from ReciterDB first, so a
 * row no longer in the retracted set reverts to its real type on the next
 * cycle and this step simply doesn't re-stamp it.
 */
export function selectPmidsToStamp(corpus: CorpusPub[], retracted: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const pub of corpus) {
    if (pub.publicationType === RETRACTION_TYPE) continue;
    if (retracted.has(pub.pmid)) out.push(pub.pmid);
  }
  return out;
}
