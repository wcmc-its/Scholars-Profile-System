/**
 * The delayed ReCiter re-score scanner (#746) — the durable backstop for the
 * self-edit "Not mine" reject flow, mirroring the ADR-005 layer-3 reconciler
 * (#393). Two passes over `reciter_pending_refresh`:
 *
 *   1. goldstandard retry — any row with `goldstandard_sent_at IS NULL` gets its
 *      reject POSTed to ReCiter; on success the timestamp is stamped, on failure
 *      `attempts`/`last_error` are recorded for the next run. (The reject route
 *      already best-effort sends inline; this catches the ones that failed or
 *      were recorded while the API was dormant.)
 *
 *   2. feature-generator (coalesced + delayed) — for each uid whose rejects have
 *      ALL been gold-standard-delivered AND whose oldest awaiting reject is older
 *      than the delay window, fire ONE `feature-generator?analysisRefreshFlag=true`
 *      (a per-uid full engine re-score) and stamp `feature_generator_sent_at` on
 *      every qualifying row for that uid. Coalescing matters: feature-generator
 *      is per-uid and expensive, so many rejects in one window collapse to one
 *      re-score.
 *
 * Idempotent + safe to run on any cadence. Dormant (off or unconfigured) ⇒ a
 * no-op that touches nothing. Intended to run ~hourly; the EventBridge → Step
 * Function wiring is a follow-up — this scanner + the table are the contract.
 */
import { db } from "@/lib/db";
import {
  isReciterApiConfigured,
  isReciterRejectEnabled,
  postGoldStandardReject,
  runFeatureGenerator,
  withRetry,
} from "@/lib/reciter/client";

export interface RefreshSummary {
  enabled: boolean;
  configured: boolean;
  /** rejects newly POSTed to the gold standard this run */
  goldstandardSent: number;
  /** rejects whose gold-standard POST failed this run */
  goldstandardFailed: number;
  /** uids re-scored (one feature-generator each) this run */
  uidsRefreshed: number;
  /** uids whose feature-generator re-score failed this run */
  uidsFailed: number;
}

const DEFAULT_DELAY_MINUTES = 60;

/** The re-score delay window (minutes after the reject). Env-tunable; default 60. */
export function refreshDelayMinutes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.RECITER_REFRESH_DELAY_MINUTES);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_DELAY_MINUTES;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runReciterRefresh(
  opts: { now?: Date; batchSize?: number } = {},
): Promise<RefreshSummary> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? 200;
  const summary: RefreshSummary = {
    enabled: isReciterRejectEnabled(),
    configured: isReciterApiConfigured(),
    goldstandardSent: 0,
    goldstandardFailed: 0,
    uidsRefreshed: 0,
    uidsFailed: 0,
  };
  // Dormant ⇒ touch nothing; the rows wait for a configured, enabled run.
  if (!summary.enabled || !summary.configured) {
    console.log(JSON.stringify({ event: "reciter_refresh_summary", ...summary }));
    return summary;
  }

  // --- pass 1: deliver any not-yet-sent gold-standard rejects ---
  const pendingPosts = await db.read.reciterPendingRefresh.findMany({
    where: { goldstandardSentAt: null },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: { id: true, uid: true, pmid: true },
  });
  for (const row of pendingPosts) {
    try {
      await withRetry(() => postGoldStandardReject({ uid: row.uid, pmid: row.pmid }));
      await db.write.reciterPendingRefresh.update({
        where: { id: row.id },
        data: { goldstandardSentAt: now, lastError: null },
      });
      summary.goldstandardSent += 1;
    } catch (err) {
      summary.goldstandardFailed += 1;
      await db.write.reciterPendingRefresh.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 }, lastError: errMsg(err) },
      });
    }
  }

  // --- pass 2: coalesced, delayed feature-generator re-score per uid ---
  const cutoff = new Date(now.getTime() - refreshDelayMinutes() * 60_000);
  // uids with a gold-standard-sent reject still awaiting a re-score.
  const awaiting = await db.read.reciterPendingRefresh.findMany({
    where: { featureGeneratorSentAt: null, goldstandardSentAt: { not: null } },
    select: { uid: true, createdAt: true },
  });
  const oldestByUid = new Map<string, Date>();
  for (const r of awaiting) {
    const prev = oldestByUid.get(r.uid);
    if (!prev || r.createdAt < prev) oldestByUid.set(r.uid, r.createdAt);
  }
  // A uid still holding an UNDELIVERED reject is skipped this round — re-score
  // only once all of a uid's evidence is in ReCiter (so the re-score can't miss
  // a just-failed reject; it fires on the next run after delivery).
  const blockedUids = new Set(
    (
      await db.read.reciterPendingRefresh.findMany({
        where: { featureGeneratorSentAt: null, goldstandardSentAt: null },
        select: { uid: true },
      })
    ).map((r) => r.uid),
  );
  const readyUids = [...oldestByUid.entries()]
    .filter(([uid, oldest]) => oldest <= cutoff && !blockedUids.has(uid))
    .map(([uid]) => uid);

  for (const uid of readyUids) {
    try {
      await withRetry(() => runFeatureGenerator({ uid }));
      await db.write.reciterPendingRefresh.updateMany({
        where: { uid, featureGeneratorSentAt: null, goldstandardSentAt: { not: null } },
        data: { featureGeneratorSentAt: now, lastError: null },
      });
      summary.uidsRefreshed += 1;
    } catch (err) {
      summary.uidsFailed += 1;
      await db.write.reciterPendingRefresh.updateMany({
        where: { uid, featureGeneratorSentAt: null },
        data: { attempts: { increment: 1 }, lastError: errMsg(err) },
      });
    }
  }

  console.log(JSON.stringify({ event: "reciter_refresh_summary", ...summary }));
  return summary;
}
