/**
 * ADR-005 failure-model layer 3 — the durable CloudFront-invalidation
 * reconciler (#353). The CDN analogue of #393's search-index reconciler.
 *
 * Layer 1 (the synchronous `CreateInvalidation` issued in the write request,
 * `lib/edit/revalidation.ts`) is best-effort: a crash, an outage, or an SDK
 * error between the DB commit and the edge purge leaves the suppressed / renamed
 * page edge-cached up to the ≤24h CloudFront TTL — the staleness the urgency
 * split exists to eliminate. This reconciler closes that gap on a ≤5 min cadence.
 *
 * Queue — the `cdn_invalidation` outbox is itself the queue. A row is PENDING
 * while its sentinel `invalidatedAt` is NULL; a successful `CreateInvalidation`
 * stamps it now(). So **pending ⟺ `invalidatedAt IS NULL`** (past a short
 * grace) — no column-to-column comparison.
 *
 * CRITICAL difference from #393: #393 re-derives its OpenSearch payload from
 * CURRENT DB state and persists nothing. #353 CANNOT — the paths-to-purge are
 * NOT recomputable (a slug flip, a `PROFILE_CANONICAL` change, or a mutated
 * author set makes the originally-cached path underivable). So each row REMEMBERS
 * the exact paths in `paths` (a JSON array) and this reconciler replays them
 * verbatim — it never recomputes a path.
 *
 * Bounded retries — `attempts` increments on each failed retry; a row is dropped
 * from the candidate set once it reaches `maxAttempts` (default 10). On reaching
 * the cap the reconciler emits an alarm-shaped `edit_cdn_reconcile_exhausted`
 * line so the operator is paged on a permanently-stuck purge (an IAM regression,
 * a deleted distribution) rather than silently leaving a page stale.
 *
 * Dormant when `SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID` is unset (local /
 * pre-launch): the outbox is never written in that posture, so this returns a
 * zeroed summary without touching the DB — exactly as the synchronous
 * invalidation is dormant.
 *
 * Best-effort, alarm-shaped logs only — the CloudWatch metric filter / alarm and
 * the EventBridge ≤5 min schedule are the infra follow-on (#353 PR-2, mirroring
 * #393's #582); this emits the structured lines they key on and never throws.
 */
import { db } from "@/lib/db";
import { sendCloudFrontInvalidation } from "@/lib/edit/revalidation";

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_GRACE_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 10;

export type CdnReconcileOptions = {
  /** Max rows to process in one run. Default 200. */
  batchSize?: number;
  /**
   * Skip rows created within this many seconds — let the in-flight write-path
   * invalidation finish before treating a NULL sentinel as a lost purge.
   * Default 60.
   */
  graceSeconds?: number;
  /**
   * Stop retrying a row after this many failed attempts; the row drops out of
   * the candidate set and an `edit_cdn_reconcile_exhausted` alarm line fires.
   * Default 10.
   */
  maxAttempts?: number;
  /** Injectable clock for tests. Default `new Date()`. */
  now?: Date;
};

export type CdnReconcileSummary = {
  /** Pending rows selected this run. */
  scanned: number;
  /** Rows whose purge landed this run (sentinel stamped). */
  reflected: number;
  /** Rows whose retry failed again (left pending, retried next run). */
  failed: number;
};

/** Parse a row's persisted `paths` JSON to a string[]; [] on any malformation. */
function parsePaths(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
      return parsed;
    }
  } catch {
    /* fall through to [] */
  }
  return [];
}

/**
 * Replay any pending CloudFront invalidation (sentinel NULL) past the grace
 * window, retrying the remembered paths until the purge lands. Returns a run
 * summary and emits alarm-shaped logs; never throws.
 */
export async function reconcileCdnInvalidations(
  opts: CdnReconcileOptions = {},
): Promise<CdnReconcileSummary> {
  const distributionId = process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID;
  // Dormant: with no distribution the outbox is never written and there is
  // nothing to drain. Return a zeroed summary without querying — empty-queue safe.
  if (!distributionId) {
    return { scanned: 0, reflected: 0, failed: 0 };
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const graceSeconds = opts.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - graceSeconds * 1000);

  // Pending candidates: rows with the sentinel NULL, older than the grace
  // cutoff, that have not yet exhausted their retry budget. Because the filter
  // selects EXACTLY the drainable set, `take: batchSize` is a correct bound
  // (no post-filter in JS). Oldest first so a backlog drains FIFO.
  const pending = await db.read.cdnInvalidation.findMany({
    where: {
      invalidatedAt: null,
      createdAt: { lt: cutoff },
      attempts: { lt: maxAttempts },
    },
    select: { id: true, paths: true, attempts: true },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let reflected = 0;
  let failed = 0;

  for (const row of pending) {
    const paths = parsePaths(row.paths);
    if (paths.length === 0) {
      // A malformed payload can never succeed; burn an attempt so it cannot loop
      // forever, and let the exhaustion path below page on it.
      failed += 1;
      const attempts = row.attempts + 1;
      await db.write.cdnInvalidation
        .update({
          where: { id: row.id },
          data: { attempts, lastError: "unparseable paths payload" },
        })
        .catch(() => {});
      console.error(
        JSON.stringify({ event: "edit_cdn_reconcile_failed", id: row.id, attempts }),
      );
      if (attempts >= maxAttempts) {
        console.error(
          JSON.stringify({ event: "edit_cdn_reconcile_exhausted", id: row.id, attempts }),
        );
      }
      continue;
    }

    try {
      await sendCloudFrontInvalidation(distributionId, paths);
      // The purge landed — stamp the sentinel so the row drops out of the next
      // run's candidate set.
      await db.write.cdnInvalidation.update({
        where: { id: row.id },
        data: { invalidatedAt: now },
      });
      reflected += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      // The row stays pending (invalidatedAt NULL) and is retried next run.
      await db.write.cdnInvalidation
        .update({ where: { id: row.id }, data: { attempts, lastError: message } })
        .catch(() => {});
      console.error(
        JSON.stringify({ event: "edit_cdn_reconcile_failed", id: row.id, attempts }),
      );
      if (attempts >= maxAttempts) {
        // Permanently stuck — alarm-shaped so the operator is paged. The row now
        // falls below the `attempts < maxAttempts` filter and stops retrying.
        console.error(
          JSON.stringify({ event: "edit_cdn_reconcile_exhausted", id: row.id, attempts }),
        );
      }
    }
  }

  const summary: CdnReconcileSummary = { scanned: pending.length, reflected, failed };
  console.log(JSON.stringify({ event: "edit_cdn_reconcile_complete", ...summary }));
  return summary;
}
