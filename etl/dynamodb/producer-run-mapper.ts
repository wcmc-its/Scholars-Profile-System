/**
 * Pure mapper: ReciterAI's producer stage ledger -> `etl_run` rows.
 *
 * WHY THIS EXISTS. Every ReciterAI-sourced import on /edit/etl-status is graded
 * on whether OUR loader ran, never on whether the producer published. So SPS
 * cannot tell "the producer ran and correctly declined to republish" from "the
 * producer died" — both render green. ReciterAI keeps the missing half in its
 * own stage ledger (`utils/stage_records.py`), which lands in the SAME table
 * this ETL already scans end to end, and which `partitionRecords` discarded
 * until Block 8. Mirroring it into `etl_run` gives the existing status board,
 * the existing SLA grading and the existing heartbeat alarm a producer-side
 * signal for free: no new scan, no new IAM, no new page.
 *
 * The precedent for caring: ReciterAI's own `scripts/deploy_cron.sh` records a
 * spotlight EventBridge rule that was declared but never deployed for two
 * months, while three later commits deployed other rules and all looked
 * correct. What finally caught it was SPS's freshness heartbeat noticing the
 * artifact frozen (SPS #1813) — i.e. exactly this class of check.
 *
 * Kept pure and separate from index.ts because all four of the ledger's sharp
 * edges live here and none of them are visible from a happy-path fixture:
 *
 *  1. TWO SK shapes. `RUN#{iso}` and `RUN#FAILED#{iso}`. The second sorts AFTER
 *     every one of the first ("F" > any digit), so "take the last SK" reports
 *     `hot_run` as permanently failed off five May rows while it is in fact
 *     completing every Monday. We parse the timestamp out and order on THAT.
 *  2. `completed_at` is ABSENT on most `complete` rows. The honest end time is
 *     `started_at + duration_ms`; falling back to `started_at` alone would
 *     record the zero-length runs that tests/unit/etl-run-started-at-guard
 *     exists to keep off the board.
 *  3. FOUR statuses, not three: `complete | skipped | failed | partial`.
 *     `skipped` is a real outcome of the spotlight monthly gate (a cheap
 *     dirty-check that regenerates only when thresholds trip), so it is neither
 *     a success nor a failure. Mapping it to "success" rebuilds the very blind
 *     spot this module closes; mapping it to "failed" cries wolf on correct
 *     behaviour. It is written through VERBATIM, which keeps it out of
 *     `loadEtlStatus`'s `status: "success"` lookup — so freshness anchors on the
 *     last run that genuinely produced something, while the page still shows the
 *     skip as the newest attempt.
 *  4. Scope. The ledger is written per scope: `GLOBAL` for pipeline-level runs,
 *     but also `cwid:{cwid}` and `pmid:{pmid}` for per-record work (thousands of
 *     rows). Only GLOBAL is a pipeline heartbeat.
 *
 * ponytail: GLOBAL scope only, and only the stages that a live EventBridge rule
 * actually drives. The per-cwid/per-pmid rows are a different question
 * (per-record failure rates) that belongs on a data-quality surface, not a
 * liveness board. Upgrade path if that question comes up: aggregate them here
 * into a failure ratio rather than adding thousands of `etl_run` rows.
 */
import type { CoreRecord, DriftDayRecord, ProducerRunRecord } from "./partition";

/**
 * Ledger stage -> `etl_run.source`. Deliberately NOT every stage in the ledger.
 *
 * The bar is: a live EventBridge rule drives it, and nothing else in SPS already
 * covers it AS WELL as a run record would — `cores_run` is here despite cores
 * being graded already, because what grades it is the age of its output, which
 * is a strictly weaker claim (see the Tier C block at the foot of this file).
 * Verified against ReciterAI's `infra/eventbridge.json` and the live
 * account (all eight rules ENABLED, 2026-09-07) — the repo's own deploy script
 * warns that a declared rule is not a deployed one, so this list was checked
 * against AWS rather than against config.
 *
 * Excluded on purpose:
 *  - `spotlight_publish` / `publish_hierarchy` — real, but they run only when
 *    the upstream gate trips, so their gap between runs is unbounded BY DESIGN
 *    and any SLA on them cries wolf. Artifact age for both is already covered
 *    consumer-side by `manifestGeneratedAt` (etl/spotlight, etl/hierarchy).
 *  - `score_publications` / `assign_subtopics` / `compute_top_topic` /
 *    `rollup_by_cwid` — substages of `hot_run`. If the hot path completes they
 *    ran; tracking them separately is four more rows saying the same thing.
 *  - `cold_run` / `hierarchy_version_cutover` / `onboarding` — operator-run, no
 *    schedule, so there is no cadence to be late against.
 */
export const PRODUCER_STAGES: Readonly<Record<string, string>> = {
  // cron(0 11 * * ? *) -> ECS reciterai-enrichment
  daily_enrichment: "ReciterAI-enrichment",
  // cron(0 12 ? * MON *) -> Step Functions reciterai-hot-path
  hot_run: "ReciterAI-hot-path",
  // cron(0 13 1 * ? *) -> ECS reciterai-spotlight (the dirty gate, not the publish)
  spotlight_refresh: "ReciterAI-spotlight-gate",
  // cron(0 13 * * ? *) -> Lambda reciterai-onboarding-detector
  onboarding_detector: "ReciterAI-onboarding-detector",
  // cron(0 5 * * ? *) -> ECS reciterai-cores-daily
  //
  // The one entry here that is FORWARD-DECLARED: ReciterAI is only now teaching
  // `pipeline_cores` to write this row, so until that deploys the lookup below
  // simply never matches. That is deliberate — cores is the one job SPS already
  // grades, on the age of its output (CORES_SOURCE, further down), and output
  // age cannot tell "ran and correctly wrote nothing" from "died". A real run
  // record can, so the day the row appears it takes over; see the call site in
  // etl/dynamodb/index.ts, which drops the output-age row whenever the ledger
  // supplied one so the two paths never both write for the same job.
  cores_run: "ReciterAI-cores",
};

/** One `etl_run` row, ready for `create`. */
export type ProducerRunWrite = {
  source: string;
  status: string;
  startedAt: Date;
  completedAt: Date;
  rowsProcessed: number;
  errorMessage: string | null;
};

/** `RUN#{iso}` and `RUN#FAILED#{iso}` — trap 1. */
const RUN_SK = /^RUN#(?:FAILED#)?(.+)$/;

/** `etl_run.status` is VarChar(16); a longer ledger word would throw on write. */
const STATUS_MAX = 16;

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * `complete` and `failed` are renamed to the words `etl_run` already uses, so
 * the existing success lookup and the existing failed branch both fire. Every
 * other ledger word rides through verbatim — see trap 3.
 */
export function mapLedgerStatus(status: unknown): string {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (s === "complete") return "success";
  if (s === "failed") return "failed";
  return (s === "" ? "unknown" : s).slice(0, STATUS_MAX);
}

/**
 * Trap 2 — prefer a real end time, then a derived one, then the start.
 *
 * Typed structurally rather than as a ProducerRunRecord so the drift rows can
 * use it too: they carry the same `duration_ms` and want the same fallback
 * ladder, and a second copy of this arithmetic is how the two shapes would
 * drift apart.
 */
function resolveCompletedAt(
  rec: { completed_at?: unknown; duration_ms?: unknown },
  startedAt: Date,
): Date {
  const explicit = parseDate(rec.completed_at);
  if (explicit !== null && explicit.getTime() >= startedAt.getTime()) return explicit;
  const ms = toNumber(rec.duration_ms);
  return ms > 0 ? new Date(startedAt.getTime() + ms) : startedAt;
}

function errorText(rec: ProducerRunRecord): string | null {
  const code = typeof rec.error_code === "string" ? rec.error_code.trim() : "";
  const msg = typeof rec.error_message === "string" ? rec.error_message.trim() : "";
  if (code === "" && msg === "") return null;
  return code === "" ? msg : msg === "" ? code : `${code}: ${msg}`;
}

/**
 * Build the `etl_run` rows for producer runs we have not recorded yet.
 *
 * `since` maps `etl_run.source` -> the newest `startedAt` already stored for it.
 * A source absent from the map (or mapped to null) has never been mirrored, so
 * its whole ledger history is written once — which is what gives the board real
 * durations and real failures on day one instead of a single synthetic row.
 *
 * Returns ascending by `startedAt` so the inserts read chronologically.
 */
export function buildProducerRunWrites(
  records: readonly ProducerRunRecord[],
  since: ReadonlyMap<string, Date | null>,
): ProducerRunWrite[] {
  const writes: ProducerRunWrite[] = [];

  for (const rec of records) {
    const parts = String(rec.PK ?? "").split("#");
    // STAGE#{stage}#{scope} — anything else is not a stage row.
    if (parts.length !== 3 || parts[0] !== "STAGE") continue;
    const [, stage, scope] = parts;
    if (scope !== "GLOBAL") continue; // trap 4

    const source = PRODUCER_STAGES[stage];
    if (source === undefined) continue;

    const sk = RUN_SK.exec(String(rec.SK ?? ""));
    if (sk === null) continue;
    // The SK timestamp is authoritative: `started_at` agrees with it on every
    // row observed, but the SK is the one the key shape guarantees exists.
    const startedAt = parseDate(sk[1]) ?? parseDate(rec.started_at);
    if (startedAt === null) continue;

    const seen = since.get(source);
    if (seen != null && startedAt.getTime() <= seen.getTime()) continue;

    const status = mapLedgerStatus(rec.status);
    writes.push({
      source,
      status,
      startedAt,
      completedAt: resolveCompletedAt(rec, startedAt),
      rowsProcessed: toNumber(rec.records_written),
      errorMessage: status === "failed" ? errorText(rec) : null,
    });
  }

  writes.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  return writes;
}

/**
 * The two daily drift Lambdas, keyed by their `DRIFT#` partition.
 *
 * These are the other half of "is the producer alive". They are scheduled
 * (`reciterai-drift-daily` cron(0 14 * * ? *), `reciterai-taxonomy-drift-daily`
 * cron(0 15 * * ? *), both ENABLED) and they were invisible here until now,
 * which is the same gap the stage ledger closed for the four above.
 */
export const DRIFT_SOURCES: Readonly<Record<string, string>> = {
  "DRIFT#evaluation": "ReciterAI-drift",
  "DRIFT#taxonomy": "ReciterAI-taxonomy-drift",
};

/** `DAY#{YYYY-MM-DD}` — the only SK shape these rows use. */
const DAY_SK = /^DAY#(\d{4}-\d{2}-\d{2})$/;

/**
 * Build `etl_run` rows for drift evaluations we have not recorded yet.
 *
 * A drift row carries no status and no duration, so this is a liveness-only
 * signal: the row EXISTS, therefore the Lambda ran, therefore `success`.
 * `severity` is not consulted on purpose — see DriftDayRecord's doc comment, and
 * note DRIFT#evaluation has been WARN every single day of its life.
 *
 * Duration is read WHEN THE PRODUCER SUPPLIES IT: ReciterAI is adding
 * `duration_ms` to the drift row (it already writes one on every STAGE# entry),
 * so this now runs the same completedAt ladder as buildProducerRunWrites — and
 * runs it whether or not that change has deployed yet.
 *
 * Absence is a NO-OP, not a zero, and that is load-bearing rather than tidy:
 * none of the 106 + 33 rows already in the table carry `duration_ms`, so on
 * every one of them `completedAt` still equals `startedAt` and the board's Run
 * duration column still reads 0s — a declared unknown, exactly as before. A
 * junk, zero or negative value takes the same path (toNumber floors it to 0),
 * so a malformed producer field degrades to today's behaviour instead of
 * writing a completion that precedes the start.
 */
export function buildDriftRunWrites(
  records: readonly DriftDayRecord[],
  since: ReadonlyMap<string, Date | null>,
): ProducerRunWrite[] {
  const writes: ProducerRunWrite[] = [];

  for (const rec of records) {
    const source = DRIFT_SOURCES[String(rec.PK ?? "")];
    if (source === undefined) continue;

    const day = DAY_SK.exec(String(rec.SK ?? ""));
    if (day === null) continue;

    // window_end is the instant the evaluation ran; the DAY# key is only a date,
    // so it is the fallback and lands at midnight UTC.
    const at = parseDate(rec.window_end) ?? parseDate(`${day[1]}T00:00:00Z`);
    if (at === null) continue;

    const seen = since.get(source);
    if (seen != null && at.getTime() <= seen.getTime()) continue;

    writes.push({
      source,
      status: "success",
      startedAt: at,
      completedAt: resolveCompletedAt(rec, at),
      rowsProcessed: 0,
      errorMessage: null,
    });
  }

  writes.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  return writes;
}

// ---------------------------------------------------------------------------
// Tier C / Tier B — the two producers that keep NO run record of any kind.
//
// Everything above this line reads a record the producer wrote ABOUT ITSELF:
// "I ran, here is how it went". These two have nothing of the sort, so the only
// available signal is that their OUTPUT moved. That is a genuinely weaker claim
// and the copy on the board says so, because conflating the two would rebuild
// the confusion this whole effort exists to remove:
//
//   a job that runs and correctly writes nothing looks DEAD here.
//
// That is why neither carries its schedule's cadence verbatim -- see the
// TRACKED entries, where cores is deliberately graded weekly against a nightly
// schedule so one quiet night cannot cry wolf.
//
// Cores is leaving this tier: it is gaining the ledger row PRODUCER_STAGES
// already maps, and the caller prefers that row over anything below. Read the
// weaker-claim reasoning here as applying to grants unconditionally, and to
// cores only on the nights no ledger row arrives.
// ---------------------------------------------------------------------------

/**
 * `pipeline_cores` writes no manifest and no S3 -- only PUB#/CORE# rows.
 *
 * It is also the one member of this tier on its way OUT of it: a
 * `STAGE#cores_run#GLOBAL` ledger row is being added upstream, and
 * PRODUCER_STAGES already maps it. Both paths therefore resolve to this same
 * source string, which is the trap: if both wrote, one nightly would file two
 * `etl_run` rows for one job, and the output-age row would keep the watermark
 * moving even on a night the run died -- rebuilding the exact blind spot this
 * module exists to close. buildCoresRecencyWrite below is what keeps that from
 * happening.
 */
export const CORES_SOURCE = "ReciterAI-cores";

/** `pipeline_grants` writes no ledger row; its manifest is the only trace. */
export const GRANTS_SOURCE = "ReciterAI-grants";

/**
 * Newest `scored_at` across the core rows this scan already collected.
 *
 * These rows are in `buckets.cores` regardless, so this costs one pass over an
 * array we hold anyway -- no extra read, no extra request.
 */
export function latestCoreScoredAt(records: readonly CoreRecord[]): Date | null {
  let newest: Date | null = null;
  for (const rec of records) {
    const at = parseDate(rec.scored_at);
    if (at !== null && (newest === null || at.getTime() > newest.getTime())) newest = at;
  }
  return newest;
}

/**
 * One `etl_run` row for a producer whose only signal is the age of its output.
 *
 * Returns nothing when the anchor has not moved since we last recorded it,
 * which is what keeps this idempotent across nightlies: a producer that
 * published nothing new adds no row, and its existing row simply ages.
 *
 * ponytail: startedAt === completedAt, so Run duration reads 0s for these two,
 * same declared-unknown as the drift rows. There is no duration to be had --
 * we are timestamping an ARTIFACT, not observing a run. It stops being a
 * approximation the day either producer writes a STAGE# row, at which point
 * both move to buildProducerRunWrites and this helper loses two callers.
 */
export function buildRecencyWrite(
  source: string,
  latestAt: Date | null,
  since: ReadonlyMap<string, Date | null>,
): ProducerRunWrite[] {
  if (latestAt === null) return [];
  const seen = since.get(source);
  if (seen != null && latestAt.getTime() <= seen.getTime()) return [];
  return [
    {
      source,
      status: "success",
      startedAt: latestAt,
      completedAt: latestAt,
      rowsProcessed: 0,
      errorMessage: null,
    },
  ];
}

/**
 * Cores' output-age row, but ONLY when the ledger did not already speak for it.
 *
 * `cores_run` (PRODUCER_STAGES) and `latestCoreScoredAt` describe the same
 * nightly job and resolve to the same `etl_run.source`, so running both would
 * file two rows for one run and let the output-age watermark advance on a night
 * the run died. A real run record beats the age of its output, so the ledger
 * wins and this drops out.
 *
 * Ordering-independent by construction: it asks what the ledger PRODUCED this
 * pass rather than what is in the table, so it needs no second query and cannot
 * be fooled by a `since` map read before the writes existed. Until ReciterAI
 * deploys the ledger row, `ledgerWrites` never mentions cores and this is
 * byte-for-byte the call it replaces.
 */
export function buildCoresRecencyWrite(
  ledgerWrites: readonly ProducerRunWrite[],
  latestAt: Date | null,
  since: ReadonlyMap<string, Date | null>,
): ProducerRunWrite[] {
  if (ledgerWrites.some((w) => w.source === CORES_SOURCE)) return [];
  return buildRecencyWrite(CORES_SOURCE, latestAt, since);
}
