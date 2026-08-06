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
 * 8 days (7d + 1d grace); monthly gets 40 days; annual gets ~13 months
 * (operator-triggered behind a manual approval gate, so this is a backstop, not
 * a tight SLA).
 *
 * `monthly` exists for sources whose PRODUCER is monthly. Deriving it needs BOTH
 * intervals, because the age we measure is the artifact's, but the moment we
 * re-read it is our loader's:
 *
 *   31d  worst-case gap between two on-time monthly publishes (a 31-day month)
 * +  7d  worst-case lag before OUR weekly loader picks the new artifact up
 *        (Spotlight is a weekly EtlStack step, cron(0 12 ? * SUN *)), during
 *        which freshness still reports the PREVIOUS artifact's age
 * +  2d  grace
 * = 40d
 *
 * The load lag is the easy term to forget: because freshnessAnchor() anchors on
 * the producer's `manifestGeneratedAt` rather than our row's `completedAt`, a
 * perfectly healthy monthly producer still reads as 38 days old just before our
 * loader next runs. An SLA at or below 38 would false-alarm every long month.
 */
export const SLA_HOURS: Readonly<Record<Cadence, number>> = {
  nightly: 30,
  weekly: 8 * 24,
  monthly: 40 * 24,
  annual: 400 * 24,
};

/**
 * Known, ACCEPTED staleness — with a mandatory expiry.
 *
 * The failure this exists to prevent is not a missing alarm, it is a permanent
 * one. `scholars-heartbeat-prod` failed EVERY day from at least 2026-07-30
 * through 2026-08-05 on a single source (Spotlight, whose producer is not
 * deployed and whose age climbs 1.0d/day forever). Three runs a night, each
 * paging, each identical. When the prod InfoEd import then died on 08-04, its
 * staleness would have been one more line in a message that had already cried
 * wolf ~60 times — so the signal existed and was worthless.
 *
 * An ack keeps the source TRACKED and REPORTED (printed as `ACK`, never
 * hidden) but stops it failing the check, so the heartbeat can sit green and a
 * NEW stale source is a state change rather than noise.
 *
 * `until` is mandatory and enforced: past that date the ack stops applying and
 * the source fails normally. An ack that could not expire would be exactly the
 * permanent blind spot this is meant to remove. An unparseable `until` is
 * treated as NO ack (fail closed) and warned about.
 */
export type FreshnessAck = {
  /** ISO date. After this instant the ack no longer applies. */
  readonly until: string;
  /** Why this staleness is accepted, and what would end it. */
  readonly reason: string;
};

/**
 * `etl_run.source` string -> cadence. The source strings are the exact values
 * the ETLs write (verified against the per-source `etlRun.create` calls under
 * etl/), NOT the StepSpec ids in etl-stack.ts (e.g. step "Ed" writes source
 * "ED", step "Dynamodb" writes "ReCiterAI-projection").
 */
export const TRACKED: Readonly<
  Record<string, { cadence: Cadence; envs?: readonly string[]; ack?: FreshnessAck }>
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
  // #2051 part B — deployed nightly steps (cdk/lib/etl-stack.ts
  // FamilySensitivityNightly / FamilySuppressionNightly, both tier:"continue",
  // both envs, no env split) writing sources "FamilySensitivity" /
  // "FamilySuppression". Freshness is their ONLY detector, on both counts:
  // continue-tier means a failure never reaches the status alarm, and the
  // etl:integrity volume guard cannot see them either — each records
  // `rowsProcessed` = the line count of a curated CSV checked into this repo
  // (33 and 8 rows), which is below the guard's minPreviousRows=100 floor AND
  // constant between two runs of the same image, so its drop ratio is 0 by
  // construction. Lowering that floor would add nothing; see the note above
  // findVolumeRegressions in etl/integrity/index.ts.
  //
  // SCOPE — what an entry here does and does not catch. `evaluate()` grades a
  // source on the recency of its most recent `status:'success'` row and never
  // reads `rowsProcessed`. So this catches the step DYING (a failed run writes
  // no success row, so the age keeps growing past the SLA), the step being
  // dropped from the nightly step list, and the step never being deployed to an
  // env. It does NOT catch a run that succeeds having done nothing: a zero-row
  // success is indistinguishable from a full one here. That case is closed at
  // the source instead — both loaders now refuse a curated CSV that parses to
  // zero rows (readCurated), so the wipe path records status='failed', which is
  // a state this entry does detect.
  FamilySensitivity: { cadence: "nightly" },
  FamilySuppression: { cadence: "nightly" },
  MeshCoverage: { cadence: "nightly" },
  // #1258/#2016 — both envs. The `envs: ["staging"]` restriction is retired with
  // the nightlySteps env split it mirrored. Tracking prod is the POINT of this
  // half of the change: prod's anchors sat at a uniform 2026-06-02 refreshed_at
  // for eight weeks while the nightly reported success every night, and nothing
  // alarmed precisely because prod was excluded here. A promoted step that is not
  // freshness-tracked would re-accumulate that staleness silently.
  MeshAnchor: { cadence: "nightly" },
  // Deployed nightly step (cdk/lib/etl-stack.ts MeshAliasNightly,
  // tier:"continue", both envs) writing source "MeshAlias". Added to the same
  // curated-MeSH block as MeshAnchor directly above, in the same style, one
  // after the other — and only MeshAnchor was tracked, which was an oversight
  // rather than a decision. Same two-way blind spot as the family overlays:
  // continue-tier hides it from the status alarm, and its 77-row curated CSV
  // is both under the volume guard's 100-row floor and constant run to run.
  // Same scope note as the family overlays above: this detects the step dying,
  // being dropped from the nightly list, or never being deployed — not a
  // success that processed nothing. The loader's own zero-row guard covers that
  // half, turning a truncate-to-empty into a failed run this entry can see.
  MeshAlias: { cadence: "nightly" },
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
  // #2200 — deployed weekly step (cdk/lib/etl-stack.ts NewsWeekly, tier:"continue")
  // that writes source "News" (etl/news/index.ts). This entry is load-bearing for
  // the #2038/#2188 volume-guard fix: that fix stops the nightly grading a weekly
  // source once its sample goes stale, and justifies the skip by delegating
  // "a source stopped running entirely" to THIS guard (see the comment above
  // MAX_SAMPLE_AGE_HOURS in etl/integrity/index.ts). News was absent here, so
  // that delegate did not exist and a silent News death alarmed nobody.
  News: { cadence: "weekly" },
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
  Spotlight: {
    cadence: "monthly",
    // Not a widened SLA — the comment above is explicit that widening is the
    // wrong response. This keeps the 40d SLA and the STALE computation intact,
    // and only stops a producer outage we do not own from failing OUR
    // heartbeat every night. Revisit at `until`: either the producer is
    // deployed (drop this ack) or it is not (renew it deliberately, with a
    // fresh date, as a decision rather than by default).
    ack: {
      until: "2026-09-30",
      reason:
        "producer not deployed — reciterai-spotlight-monthly rule + orchestrator " +
        "Lambda are declared in IaC but absent; every artifact so far is a hand-run " +
        "cli/backfill_spotlight.py --publish, last 2026-06-15 (SPS #1813)",
    },
  },
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
  /** Stale, but covered by an ack that has not expired — reported, not failed. */
  readonly acknowledged: boolean;
  /** The ack on record, whether or not it still applies. */
  readonly ack?: FreshnessAck;
  /** An ack exists but its `until` has passed — this source fails again now. */
  readonly ackExpired: boolean;
}

/**
 * Whether an ack applies right now. Pure so the expiry rule is testable without
 * a database — the expiry IS the safety property, so it needs real coverage.
 *
 * Fails CLOSED on a malformed `until`: an unparseable date grades the source
 * normally rather than silencing it. A typo that suppressed a source forever
 * would be strictly worse than the noise this feature exists to remove.
 */
export function ackState(
  ack: FreshnessAck | undefined,
  now: number,
): "none" | "active" | "expired" | "invalid" {
  if (ack === undefined) return "none";
  const until = Date.parse(ack.until);
  if (Number.isNaN(until)) return "invalid";
  return now < until ? "active" : "expired";
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

    // An ack suppresses the FAILURE, never the staleness itself: `stale` above
    // is untouched so the report still tells the truth.
    const ack = spec.ack;
    const state = ackState(ack, now);
    if (state === "invalid") {
      console.warn(
        `[freshness] WARN  ${source}: ack.until "${ack?.until}" is not a parseable ` +
          `date — ignoring the ack and grading this source normally.`,
      );
    }
    const ackActive = state === "active";
    const ackExpired = state === "expired";
    out.push({
      source,
      cadence,
      lastSuccessAt,
      ageHours,
      slaHours,
      stale,
      acknowledged: stale && ackActive,
      ack,
      ackExpired,
    });
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
