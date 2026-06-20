/**
 * GrantRecs Phase 2 — GRANT# → `opportunity` projection block (extracted from
 * etl/dynamodb/index.ts so the scan→map→upsert wiring is unit-testable with a
 * faked DocumentClient + writer). Heavy logic lives in the pure
 * `grant-opportunity-mapper.ts`; this is the thin paged-scan + batched-upsert.
 */
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
          taxonomyVersion: w.taxonomyVersion,
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
