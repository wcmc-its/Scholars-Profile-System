/**
 * Pure candidate-selection predicates for the NSF abstracts ETL.
 *
 * Kept out of etl/nsf/index.ts so tests can import them without triggering
 * the module's top-level `withEtlRun(...)` entrypoint.
 */

const REFRESH_TTL_DAYS = 90;

export function isStale(fetchedAt: Date | null): boolean {
  if (!fetchedAt) return true;
  const ageMs = Date.now() - fetchedAt.getTime();
  return ageMs > REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * True when a prior NSF fetch already covered this row and hasn't gone
 * stale — either it yielded an abstract, or it stamped a "NSF has no
 * abstract" marker (abstractSource 'nsf' + abstractFetchedAt set, abstract
 * still null). Both cases skip re-fetching until the TTL lapses; without the
 * marker check, abstract-less awards re-fetch every run.
 */
export function hasFreshNsfResult(g: {
  abstract: string | null;
  abstractSource: string | null;
  abstractFetchedAt: Date | null;
}): boolean {
  const touchedByNsf = Boolean(g.abstract) || g.abstractSource === "nsf";
  return touchedByNsf && !isStale(g.abstractFetchedAt);
}
