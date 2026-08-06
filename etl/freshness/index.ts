/**
 * ETL data-freshness heartbeat — #595.
 *
 * Run via `npm run etl:freshness`. Reads the `etl_run` audit table and asserts
 * that every tracked source has a SUCCESSFUL run within its cadence SLA. Exit 0
 * when all tracked sources are fresh; exit 1 (with a per-source report on
 * stderr) when one or more are stale, or when the check itself errors.
 *
 * Why this exists alongside the Step Functions alarms (EtlStack D4):
 *   - `sps-etl-<cadence>-status`  (ExecutionsFailed > 0) catches a step that
 *     THROWS.
 *   - `sps-etl-<cadence>-cadence` (ExecutionsStarted < 1, treatMissingData
 *     BREACHING) catches a schedule that never FIRES.
 *   Neither sees **green-but-stale**: an execution that reports success while a
 *   source's data did not actually refresh (an empty upstream fetch that does
 *   not error, a source quietly dropped from the cadence, a partial run whose
 *   `etl_run` success row is now old). This check closes that gap by alarming
 *   on the SEMANTIC outcome — "is each source's data actually fresh?" — rather
 *   than on whether a job process exited 0.
 *
 * Delivery path (no new alarm/IAM): this runs as the single step of the
 * `scholars-heartbeat-<env>` state machine. A non-zero exit surfaces as
 * States.TaskFailed -> the existing `sps-etl-heartbeat-status-<env>` alarm ->
 * `etl-failures-<env>` -> on-call relay -> Teams. The detailed per-source
 * breakdown below lands in the heartbeat's CloudWatch log
 * (`/aws/ecs/sps-etl-<env>`), which the operator opens from the alert.
 *
 * Tracked sources + SLAs are derived from the cadence definitions in
 * cdk/lib/etl-stack.ts and live in `lib/etl/freshness-policy.ts` — extracted so
 * the `/edit/etl-status` console page can grade the same sources by the same
 * rules without importing THIS module, which runs `main()` and disconnects both
 * Prisma clients on import. Every deployed cadence step writes an `etl_run` row
 * (the stragglers — search:index, revalidate, the weekly grant enrichers, the
 * COI-statements backfill — were wrapped in `withEtlRun` by the
 * reliability-audit PR-4). Sources seen in `etl_run` but absent from that table
 * are reported as "untracked" and never alarm (manual/on-demand runs).
 * Entries with an `envs` list are only checked in those envs — the cadences
 * genuinely differ per env (InfoEd is excluded from the staging nightly over
 * the 10.20/16 CIDR overlap; MeshAnchor is staging-only until its soak signs
 * off). The env comes from SCHOLARS_ENV (EtlStack container env); when it is
 * unset (local runs, pre-SCHOLARS_ENV deploys) env-scoped entries are skipped
 * rather than false-alarmed.
 */
import { db } from "@/lib/db";
import { freshnessAnchor } from "@/etl/freshness/anchor";
import {
  type SourceStatus,
  TRACKED,
  ackState,
  gradeSource,
  isTrackedInEnv,
} from "@/lib/etl/freshness-policy";

async function evaluate(now: number): Promise<SourceStatus[]> {
  const env = process.env.SCHOLARS_ENV;
  const out: SourceStatus[] = [];
  for (const [source, spec] of Object.entries(TRACKED)) {
    if (!isTrackedInEnv(spec, env)) {
      console.log(
        `[freshness] skip  ${source.padEnd(22)} (env-scoped to ${spec.envs?.join("/")}; ` +
          `SCHOLARS_ENV=${env ?? "unset"})`,
      );
      continue;
    }
    // Most recent SUCCESSFUL run for this source (a 'running'/'failed' row does
    // not advance freshness). Age anchors on the producer's manifestGeneratedAt
    // when present, NOT completedAt: a sha256 short-circuit stamps a fresh
    // completedAt but the S3 artifact is unchanged, so completedAt would let a
    // frozen producer read as fresh (§2.1). Sources with no S3 manifest fall
    // back to completedAt via freshnessAnchor().
    const last = await db.read.etlRun.findFirst({
      where: { source, status: "success", completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true, manifestGeneratedAt: true },
    });
    if (ackState(spec.ack, now) === "invalid") {
      console.warn(
        `[freshness] WARN  ${source}: ack.until "${spec.ack?.until}" is not a parseable ` +
          `date — ignoring the ack and grading this source normally.`,
      );
    }
    out.push(gradeSource(source, spec, freshnessAnchor(last), now));
  }
  return out;
}

function fmtAge(ageHours: number | null): string {
  if (ageHours === null) return "never";
  if (ageHours < 48) return `${ageHours.toFixed(1)}h`;
  return `${(ageHours / 24).toFixed(1)}d`;
}

/**
 * The nightly SLA is 30h, and `(30/24).toFixed(0)` printed it as "1d" — so the
 * log read `last_success=29.5h sla=1d`, which looks like a guard that is
 * ignoring its own threshold. It was correct; the label was not. Print hours
 * below 48 so the number shown is the number compared.
 */
function fmtSla(slaHours: number): string {
  return slaHours < 48 ? `${slaHours}h` : `${(slaHours / 24).toFixed(0)}d`;
}

async function main(): Promise<void> {
  // A single timestamp for the whole pass so all ages are comparable.
  const now = Date.now();
  const statuses = await evaluate(now);

  // Report every tracked source, freshest-relevant first (stale on top).
  const ordered = [...statuses].sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? -1 : 1;
    return (b.ageHours ?? Infinity) - (a.ageHours ?? Infinity);
  });
  console.log(`[freshness] checked ${statuses.length} tracked sources @ ${new Date(now).toISOString()}`);
  for (const s of ordered) {
    const mark = s.acknowledged ? "ACK" : s.stale ? "STALE" : "ok";
    console.log(
      `[freshness] ${mark.padEnd(5)} ${s.source.padEnd(22)} cadence=${s.cadence.padEnd(7)} ` +
        `last_success=${fmtAge(s.ageHours)} sla=${fmtSla(s.slaHours)} ` +
        `(${s.lastSuccessAt?.toISOString() ?? "none"})`,
    );
    // An ack is never silent: whoever reads this must be able to see what was
    // suppressed, why, and when it stops being suppressed, without opening the
    // source. That is the whole difference between an ack and a blind spot.
    if (s.acknowledged && s.ack !== undefined) {
      console.log(`[freshness]       acknowledged until ${s.ack.until} — ${s.ack.reason}`);
    }
    // An ack outliving its usefulness is clutter that will one day suppress a
    // real regression, so say so while the source is healthy and it is free to
    // remove.
    if (!s.stale && s.ack !== undefined) {
      console.log(
        `[freshness]       NOTE ack on ${s.source} is no longer needed (source is within SLA) — remove it`,
      );
    }
  }

  // Surface sources present in etl_run but not in the SLA table, so a new
  // cadence source is not silently unmonitored. Informational only.
  const distinct = await db.read.etlRun.findMany({
    distinct: ["source"],
    select: { source: true },
  });
  const untracked = distinct
    .map((r) => r.source)
    .filter((s) => !(s in TRACKED))
    .sort();
  if (untracked.length > 0) {
    console.log(`[freshness] untracked sources (not alarmed): ${untracked.join(", ")}`);
  }

  const acked = statuses.filter((s) => s.acknowledged);
  const stale = statuses.filter((s) => s.stale && !s.acknowledged);
  if (stale.length > 0) {
    const summary = stale
      .map((s) => {
        const expired = s.ackExpired ? ` [ack expired ${s.ack?.until}]` : "";
        return `${s.source} (${fmtAge(s.ageHours)} > ${fmtSla(s.slaHours)})${expired}`;
      })
      .join(", ");
    // stderr so it stands out in the log; the non-zero exit drives the alarm.
    console.error(
      `[freshness] FAIL — ${stale.length} stale source(s): ${summary}` +
        (acked.length > 0 ? ` (${acked.length} acknowledged, not counted)` : ""),
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[freshness] OK — all tracked sources within SLA` +
      (acked.length > 0
        ? `, ${acked.length} acknowledged (${acked.map((s) => s.source).join(", ")})`
        : ""),
  );
}

main()
  .catch((err) => {
    console.error("[freshness] ERROR —", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.write.$disconnect();
    void db.read.$disconnect();
  });
