/**
 * #2190 — per-step ETL duration MARGIN: how close each source's recent runs
 * came to the timeout that would kill them.
 *
 * The #2197 whole-run alarms (`sps-etl-<cadence>-duration-<env>`) watch total
 * `ExecutionTime`, which cannot see one step creeping inside an otherwise
 * stable total: InfoEd going 500s -> 2000s barely moves a 1.27h nightly, and the
 * first signal is the hard failure once it crosses its own 2400s ceiling. This
 * grades each source's `etl_run` rows (startedAt -> completedAt) against the
 * timeout its step actually runs under, so the creep is visible while there is
 * still headroom.
 *
 * Pure. Its only import is `lib/etl/freshness-policy.ts`, which imports nothing
 * — keep it that way (no `@/lib/db` edge), so the heartbeat
 * (`etl/freshness/index.ts`) and any console page can share it.
 *
 * 🔴 The timeouts below MIRROR values that live in `cdk/lib/etl-stack.ts` and
 * `lib/sources/mssql-infoed.ts`. They are copied, not imported: `cdk/` is
 * excluded from the ETL/app Docker build context, so an `etl/` or `lib/` import
 * of it passes CI and breaks the image. `tests/unit/duration-margin.test.ts`
 * reads those files as TEXT and fails when a mirrored number drifts.
 */

import { HOUR_MS, SLA_HOURS, type Cadence } from "@/lib/etl/freshness-policy";

/** `buildStep` taskTimeout — every nightly/weekly/annual cadence step (etl-stack.ts). */
export const CADENCE_STEP_TIMEOUT_SECONDS = 4 * 60 * 60;
/** `search:reconcile` / `cdn:reconcile` taskTimeout (etl-stack.ts). */
export const RECONCILER_TASK_TIMEOUT_SECONDS = 4 * 60;
/** `etl:honors` taskTimeout on `scholars-honors-<env>` (etl-stack.ts). */
export const HONORS_TASK_TIMEOUT_SECONDS = 45 * 60;
/**
 * `etl:dynamodb` taskTimeout on `scholars-opportunity-projection-<env>`
 * (etl-stack.ts). The same script also runs as the nightly `Dynamodb` cadence
 * step under the 4h cap; the tighter of the two is the one that kills it.
 */
export const PROJECTION_TASK_TIMEOUT_SECONDS = 60 * 60;
/**
 * InfoEd's tedious `requestTimeout` (lib/sources/mssql-infoed.ts). A per-QUERY
 * ceiling, not a per-run one — but it is what actually killed the 2026-08-04/05
 * nightly (three attempts at ~2427s each), long before the 4h task cap. A run's
 * elapsed is always >= its slowest query, so grading the run against it warns
 * early, never late.
 */
export const INFOED_REQUEST_TIMEOUT_SECONDS = 2400;

/**
 * Warn once a run uses 80% of its ceiling. The #2197 whole-run thresholds sit at
 * ~2x median because they have no hard ceiling to measure against; a per-step
 * check does, and 20% headroom is the point at which the next bad night fails
 * hard. The 08-05 InfoEd rows (~2427s / 2400s) read as `over`; a creep to 2000s
 * reads as `near`.
 */
export const MARGIN_WARN_FRACTION = 0.8;

/**
 * Sources whose `etl_run` rows are MIRRORED producer runs (etl/dynamodb/
 * producer-run-mapper.ts writes them with the producer's own timestamps). No SPS
 * task timeout applies to them. Case-sensitive on purpose: "ReCiterAI-projection"
 * is OUR `etl:dynamodb` step and IS graded.
 */
const PRODUCER_MIRRORED_PREFIX = "ReciterAI-";

const TIMEOUT_OVERRIDES_SECONDS: Readonly<Record<string, number>> = {
  InfoEd: INFOED_REQUEST_TIMEOUT_SECONDS,
  SearchReconcile: RECONCILER_TASK_TIMEOUT_SECONDS,
  CdnReconcile: RECONCILER_TASK_TIMEOUT_SECONDS,
  HonorsLists: HONORS_TASK_TIMEOUT_SECONDS,
  "ReCiterAI-projection": PROJECTION_TASK_TIMEOUT_SECONDS,
};

/**
 * The ceiling one run of `source` executes under, in seconds, or null when no
 * SPS timeout applies (producer-mirrored rows). Every other source runs as a
 * `buildStep` cadence step unless it has an override above.
 */
export function stepTimeoutSeconds(source: string): number | null {
  if (source.startsWith(PRODUCER_MIRRORED_PREFIX)) return null;
  return TIMEOUT_OVERRIDES_SECONDS[source] ?? CADENCE_STEP_TIMEOUT_SECONDS;
}

/**
 * How far back to look: one cadence SLA window, i.e. every run since the one
 * freshness itself would accept as the latest. Retries land as separate rows
 * (`buildStep` maxAttempts 2 => a fresh ECS task and a fresh row each), so the
 * window has to cover the whole night, not just the newest row.
 */
export function marginWindowStart(cadence: Cadence, now: number): Date {
  return new Date(now - SLA_HOURS[cadence] * HOUR_MS);
}

export interface MarginRow {
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly status: string;
}

export type MarginLevel = "ok" | "near" | "over";

export interface MarginResult {
  readonly source: string;
  readonly timeoutSeconds: number;
  readonly level: MarginLevel;
  /** The run that came closest to the ceiling; null when there were no rows. */
  readonly worst: {
    readonly startedAt: Date;
    readonly status: string;
    readonly durationSeconds: number;
    /** No completedAt — measured to `now`. */
    readonly open: boolean;
  } | null;
  readonly fraction: number | null;
}

/**
 * Grade one source's recent runs against its ceiling. Pure: the caller reads
 * the rows (already windowed) and resolves the timeout.
 *
 * A row with no `completedAt` is measured to `now`. While it is under the
 * ceiling it is simply in flight (or near, if it is already deep into it). Once
 * it is past the ceiling it cannot still be running: the task was killed at its
 * timeout before it could close the row, which is exactly the silent-overrun
 * this check exists for — so it grades `over`, not ignored.
 */
export function gradeDurationMargin(
  source: string,
  timeoutSeconds: number,
  rows: readonly MarginRow[],
  now: number,
): MarginResult {
  let worst: MarginResult["worst"] = null;
  for (const r of rows) {
    const end = r.completedAt?.getTime() ?? now;
    const durationSeconds = Math.max(0, (end - r.startedAt.getTime()) / 1000);
    if (worst === null || durationSeconds > worst.durationSeconds) {
      worst = {
        startedAt: r.startedAt,
        status: r.status,
        durationSeconds,
        open: r.completedAt === null,
      };
    }
  }
  if (worst === null) {
    return { source, timeoutSeconds, level: "ok", worst: null, fraction: null };
  }
  const fraction = worst.durationSeconds / timeoutSeconds;
  const level: MarginLevel =
    fraction > 1 ? "over" : fraction >= MARGIN_WARN_FRACTION ? "near" : "ok";
  return { source, timeoutSeconds, level, worst, fraction };
}
