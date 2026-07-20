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
 * cdk/lib/etl-stack.ts. Every deployed cadence step writes an `etl_run` row
 * (the stragglers — search:index, revalidate, the weekly grant enrichers, the
 * COI-statements backfill — were wrapped in `withEtlRun` by the
 * reliability-audit PR-4). Sources seen in `etl_run` but absent from the table
 * below are reported as "untracked" and never alarm (manual/on-demand runs).
 * Entries with an `envs` list are only checked in those envs — the cadences
 * genuinely differ per env (InfoEd is excluded from the staging nightly over
 * the 10.20/16 CIDR overlap; MeshAnchor is staging-only until its soak signs
 * off). The env comes from SCHOLARS_ENV (EtlStack container env); when it is
 * unset (local runs, pre-SCHOLARS_ENV deploys) env-scoped entries are skipped
 * rather than false-alarmed.
 */
import { db } from "@/lib/db";
import { freshnessAnchor } from "@/etl/freshness/anchor";

type Cadence = "nightly" | "weekly" | "monthly" | "annual";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Per-cadence freshness SLA in hours. Set slightly above the cadence interval
 * so a single late/slow run does not flap: nightly gets a 30h ceiling (24h +
 * 25% grace, matching the EtlStack nightly cadence-alarm window); weekly gets
 * 8 days (7d + 1d grace); monthly gets 35 days; annual gets ~13 months
 * (operator-triggered behind a manual approval gate, so this is a backstop, not
 * a tight SLA).
 *
 * `monthly` exists for sources whose PRODUCER is monthly. The worst-case gap
 * between two on-time monthly publishes is a 31-day month plus the producing
 * run's own latency, so anything at or below 31 days would false-alarm every
 * long month; 35d = 31d + ~4d grace.
 */
export const SLA_HOURS: Readonly<Record<Cadence, number>> = {
  nightly: 30,
  weekly: 8 * 24,
  monthly: 35 * 24,
  annual: 400 * 24,
};

/**
 * `etl_run.source` string -> cadence. The source strings are the exact values
 * the ETLs write (verified against the per-source `etlRun.create` calls under
 * etl/), NOT the StepSpec ids in etl-stack.ts (e.g. step "Ed" writes source
 * "ED", step "Dynamodb" writes "ReCiterAI-projection").
 */
export const TRACKED: Readonly<
  Record<string, { cadence: Cadence; envs?: readonly string[] }>
> = {
  // Nightly cadence (cron 0 7 * * ? *)
  ED: { cadence: "nightly" },
  // Deployed nightly step (cdk/lib/etl-stack.ts EdAdmins, tier:"continue") that
  // writes source "ED-Admins" (etl/ed-admins/index.ts) — a continue-tier failure
  // is invisible to the ExecutionsFailed alarm, so freshness is its only net.
  "ED-Admins": { cadence: "nightly" },
  ReCiter: { cadence: "nightly" },
  // PubMed competing-interest statements backfill — runs right after ReCiter.
  "ReCiter-COI-Statements": { cadence: "nightly" },
  ASMS: { cadence: "nightly" },
  // Excluded from the STAGING cadence (InfoEd's on-prem range overlaps the Sps
  // VPC CIDR — see the nightlySteps comment in cdk/lib/etl-stack.ts); prod
  // keeps the step.
  InfoEd: { cadence: "nightly", envs: ["prod"] },
  COI: { cadence: "nightly" },
  "COI-Gap": { cadence: "nightly" },
  // #608 — moved from the weekly machine to nightly (mentoring chips).
  Jenzabar: { cadence: "nightly" },
  "ReCiterAI-projection": { cadence: "nightly" },
  // #918 — Scholar.orcid from the WCM Identity table.
  "Identity-orcid": { cadence: "nightly" },
  // #794 — A2 tools taxonomy → scholar_tool. Writes a row every nightly run
  // (a 0-row success in ddb mode), so it is freshness-tracked from the start.
  Tools: { cadence: "nightly" },
  MeshCoverage: { cadence: "nightly" },
  // #1258 — staging-only until the derived-anchor soak signs off (mirrors the
  // nightlySteps env split).
  MeshAnchor: { cadence: "nightly", envs: ["staging"] },
  PubMedRetractions: { cadence: "nightly" },
  // Terminal steps — run in BOTH cadences; the nightly SLA is the binding one.
  SearchIndex: { cadence: "nightly" },
  Revalidate: { cadence: "nightly" },
  // PR-7 — terminal Integrity validator; self-records via withEtlRun("Integrity").
  Integrity: { cadence: "nightly" },
  // Weekly cadence (cron 0 12 ? * SUN *)
  Completeness: { cadence: "weekly" },
  Headshot: { cadence: "weekly" },
  Reporter: { cadence: "weekly" },
  NSF: { cadence: "weekly" },
  Gates: { cadence: "weekly" },
  NihProfile: { cadence: "weekly" },
  // PR-7 — three newly-cadenced weekly sources. Their entrypoints record an
  // etl_run row via withEtlRun ("ReporterGrants"/"ClinicalTrials") or inline
  // ("POPS"); all three run in BOTH envs' weekly cadence (not env-scoped).
  POPS: { cadence: "weekly" },
  ReporterGrants: { cadence: "weekly" },
  ClinicalTrials: { cadence: "weekly" },
  // Deployed weekly step (cdk/lib/etl-stack.ts TechnologyWeekly, tier:"continue")
  // that writes source "Technology" (etl/technologies/index.ts) — continue-tier, so
  // freshness is the only detector of a silent no-op or a dropped schedule.
  Technology: { cadence: "weekly" },
  // Monthly cadence. Spotlight is the one source whose producer is OUTSIDE this
  // repo: ReciterAI publishes the artifact and SPS only loads what it finds, so
  // the SLA here has to track the PRODUCER's schedule, not our loader's. That
  // producer is declared monthly — `reciterai-spotlight-monthly`, cron(0 13 1 *
  // ? *) in ReciterAI infra/eventbridge.json — so the 8-day weekly SLA this
  // source used to carry could never be met and reported stale by construction.
  //
  // Caveat for whoever reads a Spotlight staleness alert next: as of 2026-07-20
  // that EventBridge rule and its `reciterai-spotlight-orchestrator` Lambda are
  // DECLARED IN IaC BUT NOT DEPLOYED (describe-rule and get-function-configuration
  // both return ResourceNotFoundException, and no log group was ever created).
  // Every artifact published so far was a human running `cli/backfill_spotlight.py
  // --publish` by hand, most recently 2026-06-15. So this SLA describes the
  // INTENDED cadence; until the producer is actually deployed, expect staleness
  // and fix it upstream rather than by widening this number again. See SPS #1813.
  Spotlight: { cadence: "monthly" },
  // Annual cadence (cron 0 9 1 7 ? *)
  Hierarchy: { cadence: "annual" },
};

interface SourceStatus {
  readonly source: string;
  readonly cadence: Cadence;
  readonly lastSuccessAt: Date | null;
  readonly ageHours: number | null;
  readonly slaHours: number;
  readonly stale: boolean;
}

async function evaluate(now: number): Promise<SourceStatus[]> {
  const env = process.env.SCHOLARS_ENV;
  const out: SourceStatus[] = [];
  for (const [source, spec] of Object.entries(TRACKED)) {
    const { cadence } = spec;
    if (spec.envs !== undefined && (env === undefined || !spec.envs.includes(env))) {
      console.log(
        `[freshness] skip  ${source.padEnd(22)} (env-scoped to ${spec.envs.join("/")}; ` +
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
    const lastSuccessAt = freshnessAnchor(last);
    const ageHours =
      lastSuccessAt === null
        ? null
        : (now - lastSuccessAt.getTime()) / HOUR_MS;
    const slaHours = SLA_HOURS[cadence];
    // No success on record OR older than the SLA => stale.
    const stale = ageHours === null || ageHours > slaHours;
    out.push({ source, cadence, lastSuccessAt, ageHours, slaHours, stale });
  }
  return out;
}

function fmtAge(ageHours: number | null): string {
  if (ageHours === null) return "never";
  if (ageHours < 48) return `${ageHours.toFixed(1)}h`;
  return `${(ageHours / 24).toFixed(1)}d`;
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
    const mark = s.stale ? "STALE" : "ok";
    console.log(
      `[freshness] ${mark.padEnd(5)} ${s.source.padEnd(22)} cadence=${s.cadence.padEnd(7)} ` +
        `last_success=${fmtAge(s.ageHours)} sla=${(s.slaHours / 24).toFixed(0)}d ` +
        `(${s.lastSuccessAt?.toISOString() ?? "none"})`,
    );
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

  const stale = statuses.filter((s) => s.stale);
  if (stale.length > 0) {
    const summary = stale
      .map((s) => `${s.source} (${fmtAge(s.ageHours)} > ${s.slaHours / 24}d)`)
      .join(", ");
    // stderr so it stands out in the log; the non-zero exit drives the alarm.
    console.error(`[freshness] FAIL — ${stale.length} stale source(s): ${summary}`);
    process.exitCode = 1;
    return;
  }
  console.log("[freshness] OK — all tracked sources within SLA");
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
