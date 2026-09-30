/**
 * GrantRecs Phase 2 — GRANT# → `opportunity` projection block (extracted from
 * etl/dynamodb/index.ts so the scan→map→upsert wiring is unit-testable with a
 * faked DocumentClient + writer). Heavy logic lives in the pure
 * `grant-opportunity-mapper.ts`; this is the thin paged-scan + batched-upsert.
 */
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

import { buildOpportunityWrites, type GrantRecordInput } from "./grant-opportunity-mapper";

/**
 * Minimal DocumentClient surface this block needs. `send` takes `any` (not
 * `unknown`) so the real `DynamoDBDocumentClient` — whose `send` is overloaded
 * per-command — remains structurally assignable (contravariant param).
 */
export type ScanClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (cmd: any) => Promise<{ Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> }>;
};

/** Minimal Prisma writer surface this block needs (`any` arg for assignability). */
export type OpportunityWriter = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opportunity: { upsert: (args: any) => Promise<unknown> };
};

export type ProjectGrantResult = {
  scanned: number;
  upserted: number;
  skipped: { nonResearch: number; missingFields: number };
};

const UPSERT_BATCH = 100;

/**
 * Scan every `GRANT#` item, map it, and upsert into `opportunity` keyed on
 * `opportunityId` (idempotent). `now` stamps `lastRefreshedAt`. Returns counts.
 */
export async function projectGrantOpportunities(
  ddb: ScanClient,
  writer: OpportunityWriter,
  opts: { table: string; now?: Date; log?: (msg: string) => void },
): Promise<ProjectGrantResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});

  const items: GrantRecordInput[] = [];
  let lastKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const resp = await ddb.send(
      new ScanCommand({
        TableName: opts.table,
        FilterExpression: "begins_with(PK, :prefix)",
        ExpressionAttributeValues: { ":prefix": "GRANT#" },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const it of (resp.Items ?? []) as GrantRecordInput[]) items.push(it);
    pages += 1;
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  log(`Found ${items.length} GRANT# records (${pages} pages).`);

  const { writes, skipped } = buildOpportunityWrites(items);
  log(
    `opportunity candidates: ${writes.length} rows ` +
      `(skipped ${skipped.nonResearch} non-research, ${skipped.missingFields} missing fields).`,
  );

  let upserted = 0;
  for (let i = 0; i < writes.length; i += UPSERT_BATCH) {
    const chunk = writes.slice(i, i + UPSERT_BATCH);
    await Promise.all(
      chunk.map((w) => {
        const data = {
          source: w.source,
          sourceUrl: w.sourceUrl,
          sponsor: w.sponsor,
          title: w.title,
          synopsis: w.synopsis,
          status: w.status,
          openDate: w.openDate,
          dueDate: w.dueDate,
          eligibilityRaw: w.eligibilityRaw,
          eligibilityFlags: w.eligibilityFlags,
          cfdaList: w.cfdaList,
          mechanism: w.mechanism,
          awardCeiling: w.awardCeiling,
          awardFloor: w.awardFloor,
          estimatedFunding: w.estimatedFunding,
          numberOfAwards: w.numberOfAwards,
          primaryTopicId: w.primaryTopicId,
          topicVector: w.topicVector,
          appealByStage: w.appealByStage,
          isResearch: w.isResearch,
          meshDescriptorUi: w.meshDescriptorUi,
          prestige: w.prestige,
          eligibility: w.eligibility,
          isHonorific: w.isHonorific,
          taxonomyVersion: w.taxonomyVersion,
          matchDsl: w.matchDsl,
          matchQuery: w.matchQuery,
          matchRel: w.matchRel,
          ingestedAt: w.ingestedAt,
          lastRefreshedAt: now,
        };
        return writer.opportunity.upsert({
          where: { opportunityId: w.opportunityId },
          create: { opportunityId: w.opportunityId, ...data },
          update: data,
        });
      }),
    );
    upserted += chunk.length;
  }
  log(`opportunity upserts complete: ${upserted} rows.`);

  return { scanned: items.length, upserted, skipped };
}

/** Minimal Prisma reader surface the freshness metric needs (`any` arg for assignability). */
export type OpportunityFreshnessReader = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opportunity: { groupBy: (args: any) => Promise<unknown> };
};

/** Minimal CloudWatch surface (`any` cmd for assignability); injectable in tests. */
export type MetricClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (cmd: any) => Promise<unknown>;
};

export const FRESHNESS_METRIC_NAMESPACE = "SPS/ETL";
export const FRESHNESS_METRIC_NAME = "OpportunityCorpusIngestAgeDays";

const MS_PER_DAY = 86_400_000;

/**
 * Phase 0a corpus-freshness metric. `ingested_at` is the upstream producer
 * timestamp and the ONLY real freshness signal on `opportunity` —
 * `last_refreshed_at` is re-stamped `now` on every row every night by the
 * upsert above, so it can never look stale even when the corpus is frozen.
 * Per-source MAX is used deliberately: some rows carry an epoch-fallback
 * `ingested_at` (`new Date(0)`), so MIN/AVG would lie while MAX is safe.
 *
 * Emits `SPS/ETL` / `OpportunityCorpusIngestAgeDays` (age in days, float):
 *   - dims {Env}          — corpus-wide age = now − newest ingest across ALL
 *                           sources (what the etl-stack alarm watches)
 *   - dims {Env, Source}  — one datapoint per source, for dashboards
 *
 * Skips silently when SCHOLARS_ENV is unset (local prototype runs have no
 * metric identity). Fail-soft by contract: nothing in here may fail or delay
 * the ETL — every failure path is caught and logged as a warning.
 */
export async function emitOpportunityCorpusFreshnessMetric(
  reader: OpportunityFreshnessReader,
  opts?: { now?: Date; log?: (msg: string) => void; cloudwatch?: MetricClient },
): Promise<void> {
  const env = process.env.SCHOLARS_ENV;
  if (env === undefined || env === "") return;
  const log = opts?.log ?? (() => {});
  try {
    const now = opts?.now ?? new Date();
    const grouped = (await reader.opportunity.groupBy({
      by: ["source"],
      _max: { ingestedAt: true },
    })) as Array<{ source: string; _max: { ingestedAt: Date | null } }>;
    const perSource = grouped.flatMap((g) =>
      g._max.ingestedAt === null
        ? []
        : [{ source: g.source, ageDays: (now.getTime() - g._max.ingestedAt.getTime()) / MS_PER_DAY }],
    );
    if (perSource.length === 0) {
      log("opportunity freshness: no rows with ingested_at; metric not emitted.");
      return;
    }
    // Corpus-wide age = age of the NEWEST ingest anywhere = min over the
    // per-source ages (each of which is already an epoch-safe MAX).
    const corpusAgeDays = Math.min(...perSource.map((s) => s.ageDays));
    const cw =
      opts?.cloudwatch ??
      new CloudWatchClient({
        region: process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
      });
    await cw.send(
      new PutMetricDataCommand({
        Namespace: FRESHNESS_METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: FRESHNESS_METRIC_NAME,
            Dimensions: [{ Name: "Env", Value: env }],
            Value: corpusAgeDays,
          },
          ...perSource.map((s) => ({
            MetricName: FRESHNESS_METRIC_NAME,
            Dimensions: [
              { Name: "Env", Value: env },
              { Name: "Source", Value: s.source },
            ],
            Value: s.ageDays,
          })),
        ],
      }),
    );
    log(
      `opportunity freshness metric emitted: corpus age ${corpusAgeDays.toFixed(1)}d across ${perSource.length} source(s).`,
    );
  } catch (err) {
    log(
      `WARNING: opportunity freshness metric emission failed (ETL continues): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
