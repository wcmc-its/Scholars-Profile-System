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
 * ponytail: GLOBAL scope only, and only the four stages that a live EventBridge
 * rule actually drives. The per-cwid/per-pmid rows are a different question
 * (per-record failure rates) that belongs on a data-quality surface, not a
 * liveness board. Upgrade path if that question comes up: aggregate them here
 * into a failure ratio rather than adding thousands of `etl_run` rows.
 */
import type { ProducerRunRecord } from "./partition";

/**
 * Ledger stage -> `etl_run.source`. Deliberately NOT every stage in the ledger.
 *
 * The bar is: a live EventBridge rule drives it, and nothing else in SPS already
 * covers it. Verified against ReciterAI's `infra/eventbridge.json` and the live
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

/** Trap 2 — prefer a real end time, then a derived one, then the start. */
function resolveCompletedAt(rec: ProducerRunRecord, startedAt: Date): Date {
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
