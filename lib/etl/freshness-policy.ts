/**
 * ETL freshness POLICY — the pure half of the #595 heartbeat: which sources are
 * expected to run, how long each cadence may go without a successful run, and
 * how an acknowledgement suppresses a staleness we already know about.
 *
 * Extracted from `etl/freshness/index.ts` so it has TWO consumers: that script
 * (which still owns the DB reads and the report), and `lib/api/etl-status.ts`
 * behind the `/edit/etl-status` console page. The extraction is not stylistic —
 * `etl/freshness/index.ts` calls `main()` at module scope and `$disconnect()`s
 * BOTH app Prisma clients in its `finally`, so importing it from a server
 * component would run a heartbeat pass on every cold start and tear down the
 * running app's connection pools.
 *
 * 🔴 This module imports NOTHING, deliberately. Keep it that way: the moment it
 * grows a `@/lib/db` edge (directly or through a helper) the page has to fork
 * the source table again, and a forked TRACKED is a source that is monitored in
 * one place and invisible in the other.
 */

export type Cadence = "nightly" | "weekly" | "monthly" | "annual";

export const HOUR_MS = 60 * 60 * 1000;

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

export type TrackedSpec = {
  readonly cadence: Cadence;
  /** Envs this source is expected in. Omitted = every env. */
  readonly envs?: readonly string[];
  readonly ack?: FreshnessAck;
};

/**
 * `etl_run.source` string -> cadence. The source strings are the exact values
 * the ETLs write (verified against the per-source `etlRun.create` calls under
 * etl/), NOT the StepSpec ids in etl-stack.ts (e.g. step "Ed" writes source
 * "ED", step "Dynamodb" writes "ReCiterAI-projection").
 */
export const TRACKED: Readonly<Record<string, TrackedSpec>> = {
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
  // #2337 — deployed weekly step (cdk/lib/etl-stack.ts DataSharingWeekly,
  // tier:"continue") that writes source "DataSharing" (etl/data-sharing/index.ts's
  // withEtlRun("DataSharing", main) call). Continue-tier, so freshness is the only
  // detector of a silently-dead schedule.
  DataSharing: { cadence: "weekly" },
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
      // Reader-facing copy, deliberately. #2281 started rendering this string to
      // superusers on /edit/etl-status, where it was the most technical sentence
      // on the page and the only card visible on an otherwise green day. The
      // engineering record did not move: the comment above this block is the
      // canonical technical account and is richer than this string ever was. Do
      // not re-technicalise this to match its neighbour — edit the comment.
      reason:
        "This data is still published by hand because its automatic monthly " +
        "refresh has not been switched on yet. The last hand-published update " +
        "was 15 June 2026. Tracked as SPS #1813; there is nothing to do here.",
    },
  },
  // #2293 — durable reconcilers (ADR-005 layer 3), each its own `rate(5 min)`
  // state machine outside the nightly/weekly chains, not deployed steps within
  // them. Both got a CDK status + cadence alarm at 15 min resolution when they
  // shipped (#353/#393) -- THAT is what catches a wedged run or a disabled
  // schedule in real time. This entry adds none of that; it exists so the two
  // show up on `/edit/etl-status` at all (TRACKED x etl_run is what the page
  // reads) now that #2297 makes them write a row per run. `nightly`'s 30h SLA
  // is a slow backstop behind the 15 min alarms, not a replacement for them --
  // a source running every 5 min has to go dark for six hours before this adds
  // anything the CDK alarms had not already caught. Both run unconditionally in
  // BOTH envs (`reconcileScheduleEnabled` / `cdnReconcileScheduleEnabled` are
  // true in both staging and prod, cdk/lib/config.ts), so no `envs` restriction.
  SearchReconcile: { cadence: "nightly" },
  CdnReconcile: { cadence: "nightly" },
  // Annual cadence (cron 0 9 1 7 ? *)
  Hierarchy: { cadence: "annual" },
};

export interface SourceStatus {
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

/**
 * Whether this env is responsible for a source. The cadences genuinely differ
 * per env (InfoEd is excluded from the staging nightly over the on-prem CIDR
 * overlap), and when the env is UNSET — local runs, pre-SCHOLARS_ENV deploys —
 * an env-scoped source is skipped rather than reported missing. Reporting it
 * would tell a superuser on staging that a prod-only import "never ran".
 */
export function isTrackedInEnv(spec: TrackedSpec, env: string | undefined): boolean {
  return spec.envs === undefined || (env !== undefined && spec.envs.includes(env));
}

/**
 * Grade one source from its freshness anchor. Pure: the caller does the read and
 * resolves the anchor (`manifestGeneratedAt ?? completedAt`, via
 * `etl/freshness/anchor.ts`), this decides stale/acknowledged/expired.
 *
 * An ack suppresses the FAILURE, never the staleness itself: `stale` is computed
 * untouched so every report still tells the truth.
 */
export function gradeSource(
  source: string,
  spec: TrackedSpec,
  lastSuccessAt: Date | null,
  now: number,
): SourceStatus {
  const ageHours = lastSuccessAt === null ? null : (now - lastSuccessAt.getTime()) / HOUR_MS;
  const slaHours = SLA_HOURS[spec.cadence];
  // No success on record OR older than the SLA => stale.
  const stale = ageHours === null || ageHours > slaHours;
  const state = ackState(spec.ack, now);
  return {
    source,
    cadence: spec.cadence,
    lastSuccessAt,
    ageHours,
    slaHours,
    stale,
    acknowledged: stale && state === "active",
    ack: spec.ack,
    ackExpired: state === "expired",
  };
}
