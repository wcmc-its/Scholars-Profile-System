/**
 * `/edit/etl-status` loader — where every expected data import stands right now,
 * read straight off the `etl_run` table on the Aurora reader.
 *
 * Why `etl_run` and not the Step Functions execution history: since #2191 a
 * continue-tier step that exhausts its retries ends the WHOLE execution with a
 * single error that does not name the step, so the execution history tells a
 * superuser "one of ~36 things died" and nothing more. `etl_run` names the
 * source, the timestamp and the error text — and needs no new IAM, no task-def
 * env var and no `cdk deploy`.
 *
 * The expected set comes from `lib/etl/freshness-policy.ts` (the same TRACKED
 * table the nightly heartbeat grades against), NOT from whatever happens to be
 * in `etl_run`. That is the whole point of joining against it: a source with no
 * row at all is the ONLY signal that separates "the chain aborted before this
 * step" from "this step was never deployed in this env", and a page that
 * rendered only the rows it found would show that as nothing.
 *
 * Uncached, and it THROWS rather than degrading: freshness is the entire
 * subject of the page, so a cached loader that fails soft would turn a blip
 * into a sticky, silently-wrong dashboard. The page catches and renders an
 * honest "unavailable" notice instead of 500ing (the /edit/activity pattern).
 */
import { freshnessAnchor } from "@/etl/freshness/anchor";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  type Cadence,
  type FreshnessAck,
  HOUR_MS,
  TRACKED,
  type TrackedSpec,
  gradeSource,
  isTrackedInEnv,
} from "@/lib/etl/freshness-policy";

/** The one Prisma model this module needs — keeps the unit-test client tiny. */
export type EtlStatusClient = Pick<PrismaClient, "etlRun">;

/**
 * Per-attempt ECS task cap on every cadence step (`taskTimeout` in
 * cdk/lib/etl-stack.ts). A row still marked `running` past this window is not
 * still running: the task is gone and nothing ever wrote its terminal row —
 * which is exactly what a hard kill leaves behind for the ~24 sources that
 * create their `etl_run` row up front.
 */
export const RUNNING_TIMEOUT_HOURS = 4;

/**
 * The states a superuser sees, in plain language on the page. Each is
 * DISTINCTLY representable on purpose:
 *  - `known-issue` is never green and never red. There is a live acknowledgement
 *    on Spotlight (its producer is not deployed); painting it green makes the
 *    page lie and painting it red makes it cry wolf every night.
 *  - `never-ran` is a real row, never a blank line.
 */
export type EtlSourceState =
  | "up-to-date"
  | "late"
  | "failed"
  | "stopped"
  | "never-ran"
  | "known-issue";

/** Latest SUCCESSFUL run, as read. */
export type EtlSuccessRow = {
  completedAt: Date | null;
  manifestGeneratedAt: Date | null;
};

/** Latest attempt of ANY outcome, as read. */
export type EtlAttemptRow = {
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
};

export type EtlSourceRow = {
  source: string;
  cadence: Cadence;
  state: EtlSourceState;
  /**
   * Freshness anchor of the newest successful run: the producer's
   * `manifestGeneratedAt` when it has one, else `completedAt`. NEVER
   * `completedAt` alone — the Spotlight and Hierarchy loaders write a fresh
   * success row on an unchanged-sha256 short-circuit, so `completedAt` advances
   * while the artifact stays frozen. Those two are the only sources that write
   * `manifestGeneratedAt`. Tools short-circuits the same way but stays
   * completedAt-anchored ON PURPOSE — its producer is hand-run, so anchoring it
   * on the manifest would false-alarm while healthy (etl/tools/index.ts) — which
   * means Tools gets job-liveness coverage here and no artifact-age coverage.
   */
  lastSuccessAt: Date | null;
  ageHours: number | null;
  /** How long this cadence may go without a success before it reads late. */
  slaHours: number;
  /** When the newest attempt began, whatever its outcome. */
  lastAttemptStartedAt: Date | null;
  /** When the newest attempt finished; null while it is (or looks) in flight. */
  lastAttemptEndedAt: Date | null;
  lastAttemptStatus: string | null;
  /** Carried only when the newest attempt failed. */
  errorMessage: string | null;
  /** The acknowledgement on record, whether or not it still applies. */
  ack?: FreshnessAck;
  /**
   * The ack applies right now. Distinct from `state === "known-issue"`: a
   * failure, a vanished task and a missing row all outrank the ack in the state.
   * Only the missing-row branch surfaces this today — a crash is news even under
   * an ack, so `failed`/`stopped` deliberately say nothing about it.
   */
  ackActive: boolean;
  /** An ack exists but its date has passed — this source counts against us again. */
  ackExpired: boolean;
};

export type EtlStatusSummary = {
  checkedAt: Date;
  runningTimeoutHours: number;
  sources: EtlSourceRow[];
  /** Everything except `up-to-date`, `known-issue`, and a `never-ran` source
   *  whose ack is still live — an ack is the decision that this one does NOT
   *  need attention today. A crash or a vanished task still counts: an ack
   *  covers a known staleness, never a job that died. */
  needsAttention: number;
};

/** @see EtlStatusSummary.needsAttention */
export function needsAttention(row: EtlSourceRow): boolean {
  if (row.state === "up-to-date" || row.state === "known-issue") return false;
  return !(row.state === "never-ran" && row.ackActive);
}

/** Problems first; alphabetical inside a state so the order is stable. */
const STATE_RANK: Readonly<Record<EtlSourceState, number>> = {
  failed: 0,
  stopped: 1,
  "never-ran": 2,
  late: 3,
  "known-issue": 4,
  "up-to-date": 5,
};

/**
 * Grade one source. Pure, so every state is testable without a database.
 *
 * Precedence is deliberate: a hard failure, a vanished task or a missing row
 * outranks an acknowledgement, because an ack covers a known STALENESS we do not
 * own — not a job that crashed. Suppressing a crash under an ack written about
 * an upstream producer is exactly the blind spot acks exist to avoid. An ack
 * that lost the precedence race is still carried on the row (`ackActive`) so the
 * page can say who already accepted it instead of just painting it red.
 */
export function toSourceRow(
  source: string,
  spec: TrackedSpec,
  lastSuccess: EtlSuccessRow | null,
  lastAttempt: EtlAttemptRow | null,
  now: number,
): EtlSourceRow {
  const graded = gradeSource(source, spec, freshnessAnchor(lastSuccess), now);
  const running =
    lastAttempt?.status === "running" &&
    now - lastAttempt.startedAt.getTime() > RUNNING_TIMEOUT_HOURS * HOUR_MS;

  let state: EtlSourceState;
  if (lastAttempt === null && graded.lastSuccessAt === null) state = "never-ran";
  else if (lastAttempt?.status === "failed") state = "failed";
  else if (running) state = "stopped";
  else if (graded.acknowledged) state = "known-issue";
  else state = graded.stale ? "late" : "up-to-date";

  return {
    source,
    cadence: graded.cadence,
    state,
    lastSuccessAt: graded.lastSuccessAt,
    ageHours: graded.ageHours,
    slaHours: graded.slaHours,
    lastAttemptStartedAt: lastAttempt?.startedAt ?? null,
    lastAttemptEndedAt: lastAttempt?.completedAt ?? null,
    lastAttemptStatus: lastAttempt?.status ?? null,
    errorMessage: state === "failed" ? (lastAttempt?.errorMessage ?? null) : null,
    ack: graded.ack,
    ackActive: graded.acknowledged,
    ackExpired: graded.ackExpired,
  };
}

/**
 * Read the state of every source this env is responsible for.
 *
 * Two indexed point-lookups per source, run in parallel: the newest success
 * (`@@index([source, status, completedAt])`) and the newest attempt of any
 * outcome (`@@index([source, startedAt])`). The second is what makes a `failed`
 * or a killed `running` row visible at all — freshness deliberately ignores
 * both, so a source can be an hour into an outage and still look merely fresh.
 *
 * Throws if `etl_run` is unreadable. The caller renders an "unavailable" notice.
 *
 * `env` defaults to the APP's env identifier, `SPS_ENV` (wired per-env and
 * unconditionally on the app task def, cdk/lib/app-stack.ts). NOT `SCHOLARS_ENV`
 * — that one exists only on the ETL task defs (cdk/lib/etl-stack.ts), so reading
 * it here would leave `env` undefined in the running app and silently drop every
 * env-scoped source, InfoEd included. The `SCHOLARS_ENV` fallback keeps this
 * loader usable from an ETL-family task without a second argument.
 */
export async function loadEtlStatus(
  client: EtlStatusClient,
  now: Date = new Date(),
  env: string | undefined = process.env.SPS_ENV ?? process.env.SCHOLARS_ENV,
): Promise<EtlStatusSummary> {
  const ts = now.getTime();
  const expected = Object.entries(TRACKED).filter(([, spec]) => isTrackedInEnv(spec, env));

  // ponytail: ~62 index-covered point lookups, unbounded fan-out — fine for a
  // superuser-only uncached page over ~31 sources, not for a wider audience or a
  // bigger TRACKED. Upgrade path when it stops being fine: bounded concurrency,
  // or collapse to one groupBy over `etl_run`.
  const sources = await Promise.all(
    expected.map(async ([source, spec]) => {
      const [lastSuccess, lastAttempt] = await Promise.all([
        client.etlRun.findFirst({
          where: { source, status: "success", completedAt: { not: null } },
          orderBy: { completedAt: "desc" },
          select: { completedAt: true, manifestGeneratedAt: true },
        }),
        client.etlRun.findFirst({
          where: { source },
          orderBy: { startedAt: "desc" },
          select: { status: true, startedAt: true, completedAt: true, errorMessage: true },
        }),
      ]);
      return toSourceRow(source, spec, lastSuccess, lastAttempt, ts);
    }),
  );

  sources.sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.source.localeCompare(b.source),
  );

  return {
    checkedAt: now,
    runningTimeoutHours: RUNNING_TIMEOUT_HOURS,
    sources,
    needsAttention: sources.filter(needsAttention).length,
  };
}
