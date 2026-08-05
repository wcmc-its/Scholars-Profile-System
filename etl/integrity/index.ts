/**
 * Post-ETL data-integrity gate — reliability-audit PR-5
 * (docs/etl-reliability-audit-2026-07-02.md).
 *
 * Runs as the TERMINAL step of each cadence state machine, after search:index
 * and revalidate, and fails (exit 1 -> States.TaskFailed -> Catch -> SNS ->
 * on-call relay) when the night's end state looks implausible. This is the
 * volume complement to `etl:freshness` (which checks recency only): freshness
 * answers "did each source run recently?", this answers "did the data that
 * came out look like real data?".
 *
 * Three check families, all read-only:
 *
 *  1. rowsProcessed regressions — every `etl_run` source's latest successful
 *     rowsProcessed vs its previous success; a >50% drop on a previously
 *     substantial source (>= 100 rows) fails. The column has been written by
 *     every module since day one and read by nothing until now.
 *  2. Absolute floors on the user-visible spine tables (active scholars,
 *     publications) — mirrors the PR-1 source guards, catching anything that
 *     slipped past them.
 *  3. OpenSearch alias doc-counts vs the Aurora rows they were built from —
 *     a live index that diverges >20% below its source table means a partial
 *     or stale index is serving.
 *
 * Aggregate canaries (e.g. "most active scholars have at least one
 * publication") are preferred over named-cwid canaries: they catch the same
 * mass-attribution-loss failure without going red when one person's record
 * legitimately changes.
 *
 * Operator bypass: the same ETL_GUARD_BYPASS contract as lib/etl-guard.ts
 * (guard names below are prefixed "integrity:").
 */
import { db } from "@/lib/db";
import { withEtlRun } from "@/lib/etl-run";
import {
  FUNDING_INDEX,
  OPPORTUNITIES_INDEX,
  PEOPLE_INDEX,
  PUBLICATIONS_INDEX,
  searchClient,
} from "@/lib/search";

/** One source's last two successful rowsProcessed values, newest first. */
export interface VolumeHistory {
  readonly source: string;
  readonly latest: number;
  readonly previous: number;
  /**
   * When the `latest` sample completed. Undefined/null means "unknown age", which
   * grades the source as before — the staleness skip below is fail-safe.
   */
  readonly latestAt?: Date | null;
}

export interface VolumeRegression {
  readonly source: string;
  readonly latest: number;
  readonly previous: number;
  readonly dropPct: number;
}

/**
 * Grade only sources that produced a fresh sample in the cycle now running.
 *
 * #2038 — the nightly and the weekly run the SAME `npm run etl:integrity`, and
 * the guard graded every `etl_run` source regardless of which state machine
 * invoked it. A weekly source therefore got re-graded by every nightly in
 * between, against a pair of samples that cannot move until its next weekly
 * run: prod News sat pinned at (1595 backfill -> 5 delta) and failed the
 * nightly identically every night, ~6 nights wide on a Sunday cadence.
 *
 * A source that has not completed since the last cycle produced no new
 * observation, so there is nothing for this run to grade. Deriving that from
 * the sample's own age fixes the general case (any weekly/monthly/ad-hoc
 * source) without a per-source cadence table to keep in sync with
 * `cdk/lib/etl-stack.ts`.
 *
 * This deliberately does NOT cover "a source stopped running entirely" — that
 * is the freshness guard's job (`etl:freshness`), which grades recency; this
 * one grades volume. Splitting them that way is why the skip is safe.
 */
export const MAX_SAMPLE_AGE_HOURS = 26; // one nightly cycle + schedule drift

/** Sources whose newest sample predates the current cycle — graded by nobody this run. */
export function staleSources(
  history: readonly VolumeHistory[],
  now: Date = new Date(),
  maxSampleAgeHours: number = MAX_SAMPLE_AGE_HOURS,
): string[] {
  const maxAgeMs = maxSampleAgeHours * 3600_000;
  return history
    .filter((h) => h.latestAt && now.getTime() - h.latestAt.getTime() > maxAgeMs)
    .map((h) => h.source);
}

/**
 * A >50% overnight drop on a source that previously processed a substantial
 * row count (>= 100) is a truncated read or a mass-delete that slipped past
 * the per-module guards. Sources that legitimately hover near zero (Tools in
 * ddb mode, COI-Gap with no candidates) never had >= 100 rows, so the floor
 * exempts them. Pure function so the threshold logic is unit-testable.
 */
export function findVolumeRegressions(
  history: readonly VolumeHistory[],
  opts: {
    maxDropPct?: number;
    minPreviousRows?: number;
    maxSampleAgeHours?: number;
    now?: Date;
  } = {},
): VolumeRegression[] {
  const {
    maxDropPct = 50,
    minPreviousRows = 100,
    maxSampleAgeHours = MAX_SAMPLE_AGE_HOURS,
    now = new Date(),
  } = opts;
  const maxAgeMs = maxSampleAgeHours * 3600_000;
  const out: VolumeRegression[] = [];
  for (const h of history) {
    if (h.previous < minPreviousRows) continue;
    // #2038 — stale sample, i.e. this source did not run in the current cycle.
    if (h.latestAt && now.getTime() - h.latestAt.getTime() > maxAgeMs) continue;
    const dropPct = ((h.previous - h.latest) / h.previous) * 100;
    if (dropPct > maxDropPct) {
      out.push({ source: h.source, latest: h.latest, previous: h.previous, dropPct });
    }
  }
  return out;
}

function bypassed(guard: string): boolean {
  const raw = process.env.ETL_GUARD_BYPASS;
  if (!raw) return false;
  const list = raw.split(",").map((s) => s.trim().toLowerCase());
  const hit = list.includes("all") || list.includes(guard.toLowerCase());
  if (hit) console.warn(`[integrity:${guard}] BYPASSED via ETL_GUARD_BYPASS`);
  return hit;
}

async function loadVolumeHistory(): Promise<VolumeHistory[]> {
  const distinct = await db.read.etlRun.findMany({
    distinct: ["source"],
    select: { source: true },
  });
  const out: VolumeHistory[] = [];
  for (const { source } of distinct) {
    // Only sample runs that actually processed data (rowsProcessed > 0). A
    // manifest-gated step that no-ops when its s3 input is unchanged (Hierarchy
    // when the taxonomy hasn't moved, Tools in s3 mode) records a *success* row
    // with rowsProcessed = 0 while leaving its table fully populated — that is
    // not a volume observation, and comparing it against the prior real load
    // reads as a bogus 100% drop. Sources that only ever sit at 0 yield < 2
    // samples here and are skipped, same as the old minPreviousRows exemption.
    // True emptiness is still caught by the spine-table floors below.
    const last2 = await db.read.etlRun.findMany({
      where: { source, status: "success", rowsProcessed: { gt: 0 } },
      orderBy: { completedAt: "desc" },
      take: 2,
      select: { rowsProcessed: true, completedAt: true },
    });
    if (last2.length < 2) continue;
    out.push({
      source,
      latest: last2[0].rowsProcessed,
      previous: last2[1].rowsProcessed,
      latestAt: last2[0].completedAt,
    });
  }
  return out;
}

async function countIndexDocs(
  client: ReturnType<typeof searchClient>,
  alias: string,
): Promise<number | null> {
  const resp = await client.count({ index: alias }, { ignore: [404] });
  if (resp.statusCode !== 200) return null; // alias absent (pre-bootstrap)
  return (resp.body as { count?: number }).count ?? 0;
}

async function main(): Promise<void> {
  const violations: string[] = [];
  const note = (guard: string, msg: string) => {
    if (bypassed(guard)) return;
    violations.push(`[integrity:${guard}] ${msg}`);
  };

  // 1. rowsProcessed regressions across all etl_run sources.
  const history = await loadVolumeHistory();
  for (const r of findVolumeRegressions(history)) {
    note(
      `volume:${r.source}`,
      `rowsProcessed fell ${r.dropPct.toFixed(1)}% (${r.previous} -> ${r.latest})`,
    );
  }
  // #2038 — name the sources this run did not grade. A silent skip is how a
  // real regression hides; the whole point of the cadence rule is that the
  // OWNING cycle grades them instead, so it must be visible which those are.
  const stale = staleSources(history);
  console.log(
    `[integrity] volume history checked for ${history.length - stale.length} of ` +
      `${history.length} sources` +
      (stale.length ? ` (skipped, no run this cycle: ${stale.join(", ")})` : ""),
  );

  // 2. Spine-table floors (mirror the PR-1 per-source guard floors).
  const activeScholars = await db.read.scholar.count({ where: { deletedAt: null } });
  if (activeScholars < 5000) {
    note("floor:scholars", `active scholars = ${activeScholars} (< 5000 floor)`);
  }
  const publications = await db.read.publication.count();
  if (publications < 100_000) {
    note("floor:publications", `publications = ${publications} (< 100000 floor)`);
  }

  // Aggregate attribution canary: a healthy corpus has the overwhelming
  // majority of active scholars carrying at least one authorship row. Going
  // below half means mass attribution loss (publication_author wipe) even if
  // raw table counts look plausible.
  const attributed = await db.read.publicationAuthor.groupBy({
    by: ["cwid"],
    where: { cwid: { not: null } },
  });
  if (attributed.length < activeScholars * 0.5) {
    note(
      "canary:attribution",
      `only ${attributed.length} of ${activeScholars} active scholars have any ` +
        `publication_author row (< 50%)`,
    );
  }

  // 3. Live search indices vs the Aurora rows they were built from. The
  //    people/publications indices must not fall >20% below their source
  //    tables; funding/opportunities counts vary with eligibility filters, so
  //    only their emptiness is checked against a populated source table.
  const client = searchClient();
  const peopleDocs = await countIndexDocs(client, PEOPLE_INDEX);
  if (peopleDocs !== null && peopleDocs < activeScholars * 0.8) {
    note(
      "index:people",
      `${PEOPLE_INDEX} has ${peopleDocs} docs vs ${activeScholars} active scholars`,
    );
  }
  const pubDocs = await countIndexDocs(client, PUBLICATIONS_INDEX);
  if (pubDocs !== null && pubDocs < publications * 0.8) {
    note(
      "index:publications",
      `${PUBLICATIONS_INDEX} has ${pubDocs} docs vs ${publications} publications`,
    );
  }
  const grants = await db.read.grant.count();
  const fundingDocs = await countIndexDocs(client, FUNDING_INDEX);
  if (fundingDocs !== null && fundingDocs === 0 && grants > 0) {
    note("index:funding", `${FUNDING_INDEX} is empty while grant has ${grants} rows`);
  }
  const opportunities = await db.read.opportunity.count();
  const oppDocs = await countIndexDocs(client, OPPORTUNITIES_INDEX);
  if (oppDocs !== null && oppDocs === 0 && opportunities > 0) {
    note(
      "index:opportunities",
      `${OPPORTUNITIES_INDEX} is empty while opportunity has ${opportunities} rows`,
    );
  }

  if (violations.length > 0) {
    for (const v of violations) console.error(v);
    throw new Error(
      `[integrity] FAIL — ${violations.length} violation(s); see lines above. ` +
        `If expected, re-run with ETL_GUARD_BYPASS.`,
    );
  }
  console.log("[integrity] OK — volumes, floors, canaries, and indices all plausible");
}

if (!process.env.VITEST) {
  withEtlRun("Integrity", main)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await db.write.$disconnect();
      await db.read.$disconnect();
    });
}
