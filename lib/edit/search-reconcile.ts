/**
 * ADR-005 failure-model layer 3 — the durable suppression search-index
 * reconciler (#393).
 *
 * Layers 1 + 2 (the synchronous `reflectSearchSuppression` fast-path and the
 * nightly `etl/search-index` rebuild) leave a recovery gap: a fast-path write
 * lost to a crash, an outage, or a `bulk` partial failure between the DB commit
 * and the index write is invisible until the ≤24h rebuild — and the suppress
 * endpoint's idempotency early-return means a user cannot retry to fix it. This
 * reconciler closes that gap with a bounded ≤5 min SLA.
 *
 * Detection — the sentinel `Suppression.searchReflectedAt`, a freshness flag
 * (not a timestamp of record): NULL whenever a row's latest state transition
 * has not been reflected into OpenSearch. It defaults NULL on create, is reset
 * to NULL on revoke, and is stamped to now() by a successful reflect. So
 * **stale ⟺ `searchReflectedAt IS NULL`** (past a short grace) — no
 * column-to-column comparison, and the `suppression` table is itself the queue.
 *
 * Scope — scholar / publication / grant: the entity types with an OpenSearch
 * fast-path (grant added in #481(a) for the funding index). Education /
 * appointment / org-unit have no fast-path, so their sentinel stays NULL
 * inertly and is excluded here by entity type.
 *
 * Idempotent — each candidate is re-derived from CURRENT DB state via
 * `resolveAffectedProfiles` + `reflectSearchSuppression` (the exact path the
 * suppress / revoke routes use post-commit), so overlapping runs and repeated
 * reflects converge. No op payload is persisted because the reflection is fully
 * recomputable — the deliberate point of difference from #353's CloudFront
 * invalidation outbox, where the paths-to-purge are NOT recomputable and so
 * must be remembered.
 *
 * Best-effort, alarm-shaped logs only — the CloudWatch metric filter / alarm is
 * owned by the infra workstream (B21 / #121); this emits the structured lines
 * it keys on. The EventBridge ≤5 min schedule is the infra follow-on (#393 PR-2,
 * coordinated with #353).
 */
import { db } from "@/lib/db";
import { resolveAffectedProfiles } from "@/lib/edit/revalidation";
import { reflectSearchSuppression } from "@/lib/edit/search-suppression";
import { EntityType } from "@/lib/generated/prisma/client";

/**
 * Entity types with an OpenSearch fast-path — the only rows the reconciler
 * considers. All others have no search projection (see module header).
 */
const RECONCILABLE_ENTITY_TYPES = [
  EntityType.scholar,
  EntityType.publication,
  EntityType.grant,
] as const;

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_GRACE_SECONDS = 60;

export type ReconcileOptions = {
  /** Max rows to process in one run. Default 200. */
  batchSize?: number;
  /**
   * Skip rows whose latest transition is newer than this many seconds — let
   * the in-flight post-commit fast-path (~1s p95) finish before treating a
   * NULL sentinel as a lost write. Default 60.
   */
  graceSeconds?: number;
  /** Injectable clock for tests. Default `new Date()`. */
  now?: Date;
};

export type ReconcileSummary = {
  /** Stale rows selected this run. */
  scanned: number;
  /** Rows brought into agreement with the index. */
  reflected: number;
  /** Rows whose re-reflect failed again (left NULL, retried next run). */
  failed: number;
};

/**
 * Bring the OpenSearch index back into agreement for any suppression whose
 * latest transition was never reflected (sentinel NULL) past the grace window.
 * Returns a run summary and emits alarm-shaped logs; never throws.
 */
export async function reconcileSearchSuppressions(
  opts: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const graceSeconds = opts.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - graceSeconds * 1000);

  // Stale candidates: rows of a reconcilable entity type with the sentinel NULL
  // whose latest transition is older than the grace cutoff. The transition is
  // `revokedAt` when present (a revoke always post-dates its create), else
  // `createdAt` — expressed as the OR below because Prisma cannot COALESCE
  // across columns in a typed filter. Because the filter selects EXACTLY the
  // stale set, `take: batchSize` is a correct bound (no post-filter in JS).
  const stale = await db.read.suppression.findMany({
    where: {
      entityType: { in: [...RECONCILABLE_ENTITY_TYPES] },
      searchReflectedAt: null,
      OR: [
        { revokedAt: { not: null, lt: cutoff } },
        { revokedAt: null, createdAt: { lt: cutoff } },
      ],
    },
    select: {
      id: true,
      entityType: true,
      entityId: true,
      contributorCwid: true,
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let reflected = 0;
  let failed = 0;

  for (const row of stale) {
    // Re-derive the affected profile set from current DB state — identical to
    // the route's post-commit path: the contributor for a per-author hide,
    // every confirmed WCM co-author for a whole-publication takedown.
    const affected = await resolveAffectedProfiles(
      row.entityType,
      row.entityId,
      row.contributorCwid,
    );
    const result = await reflectSearchSuppression({
      suppressionId: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      contributorCwid: row.contributorCwid,
      affectedCwids: affected.map((a) => a.cwid),
    });
    if (result.ok) {
      // The reflector stamped `searchReflectedAt` on success, so this row drops
      // out of the next run's candidate set.
      reflected += 1;
    } else {
      failed += 1;
      // The row stays NULL and is retried next run. The reflector already
      // logged `edit_search_reflect_failed`; this adds the reconciler-dimension
      // line the infra alarm keys on.
      console.error(
        JSON.stringify({
          event: "edit_search_reconcile_failed",
          suppressionId: row.id,
          entityType: row.entityType,
          entityId: row.entityId,
        }),
      );
    }
  }

  const summary: ReconcileSummary = {
    scanned: stale.length,
    reflected,
    failed,
  };
  console.log(JSON.stringify({ event: "edit_search_reconcile_complete", ...summary }));
  return summary;
}
