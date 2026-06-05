/**
 * COI-gap candidate lifecycle reconciliation (pure).
 *
 * The daily `etl:coi-gap` job recomputes a scholar's current gaps (`fresh`) and
 * reconciles them against what's already persisted (`existing`), so that:
 *   - a NEW gap is inserted as status "new";
 *   - a gap the scholar already DISMISSED (disavowed) stays dismissed — never
 *     re-surfaced, even though it's still a gap;
 *   - a gap that has DISAPPEARED (scholar added the disclosure, or the statement
 *     changed) is closed as "resolved";
 *   - a previously-resolved gap that REAPPEARS is reopened to "new".
 *
 * Pure and DB-free so the transition rules are unit-testable; the ETL applies
 * the returned upserts/resolves.
 */

export type CandidateStatus = "new" | "acknowledged" | "dismissed" | "resolved";

/** A current gap produced by the pipeline for a scholar (one per pmid+entity). */
export interface FreshGap {
  pmid: string;
  normalizedEntity: string;
  entity: string;
  tier: "High" | "Medium";
  attribution: string;
  entityScore: number;
  category: string;
  sourceSentence: string;
}

/** The minimal persisted shape needed to decide a transition. */
export interface ExistingGap {
  pmid: string;
  normalizedEntity: string;
  status: CandidateStatus;
}

export interface ReconcileUpsert extends FreshGap {
  /** Status to write (insert or update). */
  status: CandidateStatus;
  /** True when no row exists yet for this (pmid, entity). */
  isNew: boolean;
}

export interface ReconcileResult {
  /** Fresh gaps to insert or update. */
  upserts: ReconcileUpsert[];
  /** Existing (new/acknowledged) gaps no longer present → close as "resolved". */
  resolve: Array<{ pmid: string; normalizedEntity: string }>;
}

const keyOf = (g: { pmid: string; normalizedEntity: string }) => `${g.pmid}::${g.normalizedEntity}`;

export function reconcileCandidates(existing: ExistingGap[], fresh: FreshGap[]): ReconcileResult {
  const existingByKey = new Map(existing.map((e) => [keyOf(e), e]));
  const freshKeys = new Set(fresh.map(keyOf));

  const upserts: ReconcileUpsert[] = fresh.map((f) => {
    const prev = existingByKey.get(keyOf(f));
    let status: CandidateStatus;
    if (!prev) status = "new"; // brand-new gap
    else if (prev.status === "dismissed") status = "dismissed"; // disavowed — keep, never re-nag
    else if (prev.status === "resolved") status = "new"; // reappeared after being closed → reopen
    else status = prev.status; // "new" or "acknowledged" → preserve the scholar's state
    return { ...f, status, isNew: !prev };
  });

  const resolve: Array<{ pmid: string; normalizedEntity: string }> = [];
  for (const e of existing) {
    if (freshKeys.has(keyOf(e))) continue; // still a gap
    // No longer surfaced. Close only scholar-actionable states; leave dismissed
    // (stays disavowed) and already-resolved untouched.
    if (e.status === "new" || e.status === "acknowledged") {
      resolve.push({ pmid: e.pmid, normalizedEntity: e.normalizedEntity });
    }
  }

  return { upserts, resolve };
}
