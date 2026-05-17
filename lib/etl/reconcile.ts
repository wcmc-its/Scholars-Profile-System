/**
 * Issue #352 — shared ETL reconcile primitive.
 *
 * The Grant / Education / Appointment ETLs historically rebuilt their tables
 * with `deleteMany` + `createMany`, minting a fresh `uuid()` primary key for
 * every row on every run. ADR-005's manual-override layer keys suppression and
 * field overrides on a stable identifier, so a churning PK silently orphans
 * every manual edit on the next ETL run.
 *
 * `classifyByExternalId` is the pure, model-agnostic core of the fix. Given the
 * rows an ETL is about to write (`incoming`) and the rows already in the table
 * (`existing`), it partitions the work into create / update / tombstone so the
 * caller can reconcile in place: an existing row is UPDATEd, never deleted and
 * re-created, so its PK survives the run.
 *
 * It is deliberately Prisma-free — the caller issues the typed `createMany` /
 * `update` / `deleteMany` against its own model delegate. That keeps this unit
 * trivially testable and sidesteps Prisma's per-delegate generics.
 */

/** Any row carrying the stable `externalId` reconcile key. */
export type WithExternalId = { externalId: string };

/** The create / update / tombstone partition produced by {@link classifyByExternalId}. */
export type ReconcilePlan<T> = {
  /** `externalId` not present in `existing` — insert these. */
  toCreate: T[];
  /** `externalId` present in both, `contentKey` differs — update these in place. */
  toUpdate: T[];
  /** `externalId` present in `existing` but not in `incoming` — delete these. */
  staleExternalIds: string[];
  /**
   * `externalId` values that appeared more than once in `incoming`. The last
   * occurrence wins; the collision is surfaced here so the caller can log it.
   * A non-empty list means the upstream source emitted two rows for one key —
   * worth investigating, and previously hidden by `createMany({ skipDuplicates })`.
   */
  duplicateExternalIds: string[];
};

/**
 * Partition `incoming` against `existing` for an upsert-by-`externalId`
 * reconcile. See the file header for the why.
 *
 * @param incoming   Rows about to be written; each must carry `externalId`.
 * @param existing   Rows already in the table — `externalId` plus whatever
 *                   fields `contentKey` reads (fetch with a narrow `select`).
 * @param contentKey Serializes the fields that decide whether a row "changed".
 *                   It must read only fields present on BOTH `incoming` and
 *                   `existing`, and only fields this ETL itself owns — never a
 *                   column another ETL or enrichment step writes, or every row
 *                   would falsely classify as changed.
 */
export function classifyByExternalId<
  T extends WithExternalId,
  E extends WithExternalId,
>(args: {
  incoming: T[];
  existing: E[];
  contentKey: (row: T | E) => string;
}): ReconcilePlan<T> {
  const { incoming, existing, contentKey } = args;

  // Dedupe `incoming` by externalId, last occurrence wins. A well-behaved
  // source never emits a duplicate key, but if one slips through, `createMany`
  // against the (now unique) column would throw — so collapse it here and
  // report it rather than fail the run.
  const incomingByEid = new Map<string, T>();
  const duplicated = new Set<string>();
  for (const row of incoming) {
    if (incomingByEid.has(row.externalId)) duplicated.add(row.externalId);
    incomingByEid.set(row.externalId, row);
  }

  const existingByEid = new Map<string, E>();
  for (const row of existing) existingByEid.set(row.externalId, row);

  const toCreate: T[] = [];
  const toUpdate: T[] = [];
  for (const [externalId, row] of incomingByEid) {
    const prior = existingByEid.get(externalId);
    if (!prior) {
      toCreate.push(row);
    } else if (contentKey(row) !== contentKey(prior)) {
      toUpdate.push(row);
    }
    // else: present and unchanged — skipped, no write.
  }

  const staleExternalIds: string[] = [];
  for (const externalId of existingByEid.keys()) {
    if (!incomingByEid.has(externalId)) staleExternalIds.push(externalId);
  }

  return {
    toCreate,
    toUpdate,
    staleExternalIds,
    duplicateExternalIds: [...duplicated],
  };
}
