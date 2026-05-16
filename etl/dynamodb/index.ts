/**
 * DynamoDB ETL — Phase 4f + Phase 2 D-02 + Phase 8 D-03 (Block 2b retired) + Issue #316.
 *
 * Four projection blocks land ReCiterAI ground truth into MySQL:
 *
 *   1. TAXONOMY#  → topic                  (67 rows; parent topic catalog)
 *   2. TOPIC#     → publication_topic      (~78,103 rows; per-pub × scholar × parent_topic triples)
 *   3. FACULTY#   → topic_assignment       (Q6 minimal projection — preserved unchanged)
 *   4. IMPACT#    → publication             (issue #316; global per-pmid impact score + GPT justification)
 *
 * The TAXONOMY# + TOPIC# blocks are the Phase 2 D-02 candidate (e) projection
 * locked in .planning/phases/02-algorithmic-surfaces-and-home-composition/02-SCHEMA-DECISION.md.
 * The FACULTY# block stays as-is for backwards compatibility; future plans may
 * retire topic_assignment after Phase 2 surfaces validate against publication_topic.
 *
 * Phase 8 D-03 retirement: the legacy slug-derived sub-topic upsert (formerly
 * a TOPIC# -> sub-topic block that derived labels client-side from the slug
 * and wrote a hard-coded null description) is removed. The Hierarchy ETL
 * (etl/hierarchy/index.ts), which runs immediately before this script per the
 * D-04 orchestrator order, is the SOLE writer of the Subtopic table from this
 * point forward -- it sources display_name and short_description from the
 * canonical reciterai-hierarchy artifact rather than deriving them client-side.
 * Block 3 below still references Subtopic.id via publication_topic.primarySubtopicId
 * / subtopicIds[]; the graceful-skip behavior on missing FK rows handles the
 * rare case where Hierarchy ETL fails on a given day (Q5' fail-isolated semantics).
 *
 * Issue #316 — IMPACT# projection. Probe confirms IMPACT# is per-pmid only
 * (PK=IMPACT#pmid_<pmid>, SK=SCORE), with attributes { impact_score, justification,
 * model }. The schema decision (.planning/drafts/316-impact-etl/schema-decision.md)
 * lands these onto Publication directly rather than PublicationScore (which is
 * per-(cwid, pmid) — wrong scope) or a sibling table (redundant with Publication).
 * Block 2 (TOPIC#) is also extended to persist `rationale` and `synopsis`, which
 * the scan already reads but previously discarded. The downstream MAX-collapse
 * workaround in lib/api/profile.ts:482-491 retires in PR-B once readers migrate
 * to Publication.impactScore; PublicationTopic.impactScore continues to be
 * populated as a denormalized mirror during the transition.
 *
 * Env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION (or AWS_REGION)
 *   SCHOLARS_DYNAMODB_TABLE  (default: reciterai)
 *
 * Usage: `npm run etl:dynamodb`
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "../../lib/db";
import { resolveTopTopicByPmid } from "./top-topic-resolver";

const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

type FacultyRecord = {
  PK: string; // FACULTY#cwid_<cwid>
  SK?: string;
  top_topics?: Array<{ topic_id?: string; topic?: string; score: number }> | unknown;
  [key: string]: unknown;
};

type TaxonomyRecord = {
  PK: string; // TAXONOMY#taxonomy_v2
  SK?: string;
  taxonomy_version?: string;
  topic_count?: number;
  topics?: Array<{ id: string; label: string; description?: string }>;
  [key: string]: unknown;
};

type TopicRecord = {
  PK: string; // TOPIC#<parent_topic_id>
  SK?: string;
  pmid?: string | number;
  faculty_uid?: string; // "cwid_<cwid>" — the cwid_ prefix is DynamoDB-specific (see etl/reciter/index.ts:7)
  primary_subtopic_id?: string;
  subtopic_ids?: unknown;
  subtopic_confidences?: unknown;
  score?: number;
  impact_score?: number;
  rationale?: string; // issue #316: per-topic "why this paper maps here" — persisted to publication_topic.rationale
  synopsis?: string; // issue #316: one-line plain-language synopsis — persisted to publication_topic.synopsis
  /// issue #325: per-paper argmax of the topic-score vector (above the
  /// 0.3 floor; deterministic tiebreak upstream). Denormalized across
  /// the N TOPIC# rows for one pmid; the same value is expected on
  /// every row. Persisted once per pmid to publication.top_topic_id.
  top_topic_id?: string;
  author_position?: string;
  year?: number;
  [key: string]: unknown;
};

type ImpactRecord = {
  PK: string; // IMPACT#pmid_<pmid>
  SK?: string; // "SCORE" (only seen value as of probe 2026-05-15)
  pmid?: string | number;
  impact_score?: number;
  justification?: string;
  model?: string;
  [key: string]: unknown;
};

/** Strip the DynamoDB-specific "cwid_" prefix from a faculty_uid / SK fragment. */
function stripCwidPrefix(raw: string): string {
  return raw.startsWith("cwid_") ? raw.slice("cwid_".length) : raw;
}

async function main() {
  const start = Date.now();
  const run = await prisma.etlRun.create({
    data: { source: "ReCiterAI-projection", status: "running" },
  });

  try {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

    // ===================================================================
    // Block 1: TAXONOMY# → topic  (Phase 2 D-02 candidate (e))
    // ===================================================================
    console.log(`Scanning ${TABLE} for TAXONOMY# records...`);
    const taxItems: TaxonomyRecord[] = [];
    {
      let lastKey: Record<string, unknown> | undefined;
      do {
        const resp = await ddb.send(
          new ScanCommand({
            TableName: TABLE,
            FilterExpression: "begins_with(PK, :prefix)",
            ExpressionAttributeValues: { ":prefix": "TAXONOMY#" },
            ExclusiveStartKey: lastKey,
          }),
        );
        for (const it of (resp.Items ?? []) as TaxonomyRecord[]) taxItems.push(it);
        lastKey = resp.LastEvaluatedKey;
      } while (lastKey);
    }
    console.log(`Found ${taxItems.length} TAXONOMY# record(s).`);

    // The probe confirms there is exactly one TAXONOMY#taxonomy_v2 record carrying
    // the full topics[] array; we still iterate defensively so a future taxonomy_v3
    // record (if added) lands without code changes.
    let topicRowsUpserted = 0;
    for (const tax of taxItems) {
      const taxonomyVersion = String(tax.taxonomy_version ?? tax.PK.replace("TAXONOMY#", ""));
      const source = `reciterai-${taxonomyVersion}`;
      const topics = Array.isArray(tax.topics) ? tax.topics : [];
      console.log(
        `Upserting ${topics.length} topic rows from ${tax.PK} (taxonomy_version=${taxonomyVersion})...`,
      );
      // Sequential upsert — 67 rows is trivial and guarantees deterministic ordering
      // for FK targets used by the TOPIC# block below.
      for (const t of topics) {
        if (!t || typeof t.id !== "string" || typeof t.label !== "string") continue;
        await prisma.topic.upsert({
          where: { id: t.id },
          create: {
            id: t.id,
            label: t.label,
            description: typeof t.description === "string" ? t.description : null,
            source,
            refreshedAt: new Date(),
          },
          update: {
            label: t.label,
            description: typeof t.description === "string" ? t.description : null,
            source,
            refreshedAt: new Date(),
          },
        });
        topicRowsUpserted += 1;
      }
    }
    console.log(`Topic upserts complete: ${topicRowsUpserted} rows.`);

    const topicCount = await prisma.topic.count();
    console.log(`topic table count: ${topicCount} (expected 67 for taxonomy_v2)`);
    if (topicCount !== 67) {
      console.warn(
        `WARN: topic count ${topicCount} != 67 — investigate TAXONOMY# probe output.`,
      );
    }

    // ===================================================================
    // Block 2: TOPIC# → publication_topic  (Phase 2 D-02 candidate (e))
    // ===================================================================
    // Pre-load the active scholar set to skip rows that would violate the
    // publication_topic.cwid → scholar.cwid FK (rather than failing the whole ETL).
    // Filter matches the existing FACULTY# block below (deletedAt: null + status: active)
    // so both projections agree on which scholars are in scope.
    const ourScholars = await prisma.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    const ourCwidSet = new Set(ourScholars.map((s) => s.cwid));

    // Pre-load the topic id set for the TOPIC# parent_topic_id FK precheck. Any
    // TOPIC# row referencing a parent that is no longer in TAXONOMY# would also
    // violate FK; rare but worth defending against.
    const knownTopics = await prisma.topic.findMany({ select: { id: true } });
    const knownTopicIds = new Set(knownTopics.map((t) => t.id));

    // Pre-load known publication PMIDs. ReCiterAI's TOPIC# scope can include
    // PMIDs that haven't yet been ingested into our `publication` table (the
    // PubMed ETL runs separately); upserting those would violate
    // publication_topic.pmid → publication.pmid FK. Skip them with a counted
    // log line, same pattern as the scholar/parent-topic guards.
    const knownPubs = await prisma.publication.findMany({ select: { pmid: true } });
    const knownPmidSet = new Set(knownPubs.map((p) => p.pmid));

    console.log(`Scanning ${TABLE} for TOPIC# records (paginated)...`);
    const topicItems: TopicRecord[] = [];
    {
      let lastKey: Record<string, unknown> | undefined;
      let pages = 0;
      do {
        const resp = await ddb.send(
          new ScanCommand({
            TableName: TABLE,
            FilterExpression: "begins_with(PK, :prefix)",
            ExpressionAttributeValues: { ":prefix": "TOPIC#" },
            ExclusiveStartKey: lastKey,
          }),
        );
        for (const it of (resp.Items ?? []) as TopicRecord[]) topicItems.push(it);
        pages += 1;
        if (pages % 10 === 0) {
          console.log(`  ...scanned ${topicItems.length} TOPIC# items so far (${pages} pages)`);
        }
        lastKey = resp.LastEvaluatedKey;
      } while (lastKey);
    }
    console.log(`Found ${topicItems.length} TOPIC# records (expected ~78,103 per probe).`);

    // Map → upsert. Skip rows where:
    //   - cwid not in our scholar table (FK would reject)
    //   - parent_topic_id not in our topic catalog (FK would reject)
    //   - required scalars missing (pmid, score, year, author_position)
    // Log the skip reasons by category so the ETL bookkeeping is auditable.
    let skippedMissingScholar = 0;
    let skippedMissingTopic = 0;
    let skippedMissingPublication = 0;
    let skippedMissingFields = 0;
    let pubTopicRowsUpserted = 0;

    type PubTopicWrite = {
      pmid: string;
      cwid: string;
      parentTopicId: string;
      primarySubtopicId: string | null;
      subtopicIds: Prisma.InputJsonValue | typeof Prisma.JsonNull;
      subtopicConfidences: Prisma.InputJsonValue | typeof Prisma.JsonNull;
      score: Prisma.Decimal;
      rationale: string | null;
      synopsis: string | null;
      authorPosition: string;
      year: number;
    };

    const writes: PubTopicWrite[] = [];
    for (const it of topicItems) {
      const parentTopicId = it.PK.replace("TOPIC#", "");
      if (!parentTopicId || !knownTopicIds.has(parentTopicId)) {
        skippedMissingTopic += 1;
        continue;
      }

      const rawCwid = typeof it.faculty_uid === "string" ? stripCwidPrefix(it.faculty_uid) : "";
      if (!rawCwid || !ourCwidSet.has(rawCwid)) {
        skippedMissingScholar += 1;
        continue;
      }

      // pmid is numeric in DDB (TOPIC# items) but stored as VARCHAR(32) in MySQL
      // to FK-relate to the existing publication.pmid (String @id). Stringify.
      const pmidStr =
        typeof it.pmid === "number" && Number.isFinite(it.pmid)
          ? String(it.pmid)
          : typeof it.pmid === "string" && /^\d+$/.test(it.pmid.trim())
            ? it.pmid.trim()
            : "";
      const score = typeof it.score === "number" ? it.score : NaN;
      const yearNum = typeof it.year === "number" ? it.year : NaN;
      const authorPosition = typeof it.author_position === "string" ? it.author_position : "";

      if (!pmidStr || !Number.isFinite(score) || !Number.isFinite(yearNum) || !authorPosition) {
        skippedMissingFields += 1;
        continue;
      }

      if (!knownPmidSet.has(pmidStr)) {
        skippedMissingPublication += 1;
        continue;
      }

      writes.push({
        pmid: pmidStr,
        cwid: rawCwid,
        parentTopicId,
        primarySubtopicId:
          typeof it.primary_subtopic_id === "string" ? it.primary_subtopic_id : null,
        subtopicIds:
          it.subtopic_ids !== undefined && it.subtopic_ids !== null
            ? (it.subtopic_ids as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        subtopicConfidences:
          it.subtopic_confidences !== undefined && it.subtopic_confidences !== null
            ? (it.subtopic_confidences as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        score: new Prisma.Decimal(score),
        // it.impact_score is intentionally not persisted to publication_topic;
        // the mirror column was dropped in #316 PR-B-finalize. The IMPACT#
        // Block 4 below writes the canonical value to Publication.impactScore.
        rationale: typeof it.rationale === "string" && it.rationale ? it.rationale : null,
        synopsis: typeof it.synopsis === "string" && it.synopsis ? it.synopsis : null,
        authorPosition,
        year: yearNum,
      });
    }
    console.log(
      `publication_topic candidates: ${writes.length} (skipped: ${skippedMissingScholar} missing scholar, ${skippedMissingTopic} missing parent topic, ${skippedMissingPublication} missing publication, ${skippedMissingFields} missing required fields).`,
    );

    // Idempotent upsert keyed on the composite (pmid, cwid, parentTopicId).
    // Batch via Promise.all in chunks of 100 — Aurora MySQL handles this fine
    // and bounds open connection/transaction count for the local mariadb adapter.
    const BATCH = 100;
    for (let i = 0; i < writes.length; i += BATCH) {
      const chunk = writes.slice(i, i + BATCH);
      await Promise.all(
        chunk.map((w) =>
          prisma.publicationTopic.upsert({
            where: {
              pmid_cwid_parentTopicId: {
                pmid: w.pmid,
                cwid: w.cwid,
                parentTopicId: w.parentTopicId,
              },
            },
            create: {
              pmid: w.pmid,
              cwid: w.cwid,
              parentTopicId: w.parentTopicId,
              primarySubtopicId: w.primarySubtopicId,
              subtopicIds: w.subtopicIds,
              subtopicConfidences: w.subtopicConfidences,
              score: w.score,
              rationale: w.rationale,
              synopsis: w.synopsis,
              authorPosition: w.authorPosition,
              year: w.year,
            },
            update: {
              primarySubtopicId: w.primarySubtopicId,
              subtopicIds: w.subtopicIds,
              subtopicConfidences: w.subtopicConfidences,
              score: w.score,
              rationale: w.rationale,
              synopsis: w.synopsis,
              authorPosition: w.authorPosition,
              year: w.year,
            },
          }),
        ),
      );
      pubTopicRowsUpserted += chunk.length;
      if ((i / BATCH) % 50 === 0) {
        console.log(`  ...upserted ${pubTopicRowsUpserted}/${writes.length} publication_topic rows`);
      }
    }
    console.log(`publication_topic upserts complete: ${pubTopicRowsUpserted} rows.`);

    // ===================================================================
    // Block 2b: TOPIC#.top_topic_id → publication.top_topic_id  (issue #325)
    // ===================================================================
    // ReciterAI #68 lands `top_topic_id` on every TOPIC# row — argmax of the
    // per-paper topic-score vector among topics above the 0.3 floor (deterministic
    // tiebreak upstream). The value is per-paper; producer denormalizes across
    // the N TOPIC# rows for one pmid. We collapse to first-non-empty per pmid
    // and write once to publication.top_topic_id. Forward-compatible: if some
    // pmids haven't been backfilled yet (the field is missing on their rows),
    // those publications keep top_topic_id=NULL until the next producer rebuild.
    //
    // Pure resolution lives in `./top-topic-resolver.ts` so the per-pmid
    // collapse + FK guards can be unit-tested without a DDB scan.
    const {
      byPmid: topTopicByPmid,
      skippedUnknownTopic: topTopicSkippedUnknown,
      perPmidConflicts: topTopicConflicts,
    } = resolveTopTopicByPmid(topicItems, knownPmidSet, knownTopicIds);

    // Group by topTopicId so each updateMany batches all pmids that share a
    // value (cuts the round-trip count from O(pmids) to O(distinct_top_topics)).
    let topTopicPmidsUpdated = 0;
    const groupsByTopTopic = new Map<string, string[]>();
    for (const [pmid, tt] of topTopicByPmid) {
      const arr = groupsByTopTopic.get(tt) ?? [];
      arr.push(pmid);
      groupsByTopTopic.set(tt, arr);
    }
    const TOP_TOPIC_BATCH = 1000;
    for (const [tt, pmids] of groupsByTopTopic) {
      for (let i = 0; i < pmids.length; i += TOP_TOPIC_BATCH) {
        const chunk = pmids.slice(i, i + TOP_TOPIC_BATCH);
        const res = await prisma.publication.updateMany({
          where: { pmid: { in: chunk } },
          data: { topTopicId: tt },
        });
        topTopicPmidsUpdated += res.count;
      }
    }
    console.log(
      `top_topic_id updates: ${topTopicPmidsUpdated} pmids set across ${groupsByTopTopic.size} target topics ` +
        `(skipped ${topTopicSkippedUnknown} unknown topic ids; ${topTopicConflicts} per-pmid conflicts).`,
    );
    if (topTopicByPmid.size === 0 && topTopicSkippedUnknown === 0) {
      console.warn(
        "WARN: zero TOPIC# rows carried top_topic_id — producer rollout (ReciterAI #68) may not have reached this dataset yet.",
      );
    }

    // ===================================================================
    // Block 3: FACULTY# → topic_assignment  (existing Q6 minimal projection)
    // ===================================================================
    // PRESERVED UNCHANGED from Phase 4f. Future plans may retire topic_assignment
    // once the Phase 2 surfaces validate against publication_topic.
    console.log(`Active scholars: ${ourCwidSet.size}; scanning ${TABLE} for FACULTY# records...`);

    const items: FacultyRecord[] = [];
    let lastKey: Record<string, unknown> | undefined;
    let scanned = 0;

    do {
      const resp = await ddb.send(
        new ScanCommand({
          TableName: TABLE,
          FilterExpression: "begins_with(PK, :prefix)",
          ExpressionAttributeValues: { ":prefix": "FACULTY#cwid_" },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const it of (resp.Items ?? []) as FacultyRecord[]) items.push(it);
      scanned += resp.ScannedCount ?? 0;
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    console.log(`Scanned ~${scanned} items, kept ${items.length} FACULTY# records.`);

    if (items.length > 0) {
      console.log("Sample record:", JSON.stringify(items[0], null, 2).slice(0, 500));
    }

    type TopicRow = { cwid: string; topic: string; score: number };
    const rows: TopicRow[] = [];
    for (const it of items) {
      const m = it.PK.match(/^FACULTY#cwid_(.+)$/);
      if (!m) continue;
      const cwid = m[1];
      if (!ourCwidSet.has(cwid)) continue;
      const tt = it.top_topics;
      if (!Array.isArray(tt)) continue;
      for (const t of tt as Array<Record<string, unknown>>) {
        const topic =
          (typeof t.topic === "string" && t.topic) ||
          (typeof t.topic_id === "string" && t.topic_id) ||
          null;
        const score =
          typeof t.score === "number"
            ? t.score
            : typeof t.max_score === "number"
              ? t.max_score
              : null;
        if (!topic || score === null) continue;
        rows.push({ cwid, topic, score });
      }
    }
    console.log(`Built ${rows.length} topic_assignment rows.`);

    console.log("Resetting topic_assignment table...");
    await prisma.topicAssignment.deleteMany();

    console.log(`Inserting ${rows.length}...`);
    const FACULTY_BATCH = 1000;
    for (let i = 0; i < rows.length; i += FACULTY_BATCH) {
      await prisma.topicAssignment.createMany({
        data: rows.slice(i, i + FACULTY_BATCH).map((r) => ({
          cwid: r.cwid,
          topic: r.topic,
          score: r.score,
          source: "ReCiterAI-DynamoDB",
        })),
        skipDuplicates: true,
      });
    }

    // ===================================================================
    // Block 4: IMPACT# → publication  (issue #316)
    // ===================================================================
    // IMPACT# is per-pmid only (PK=IMPACT#pmid_<pmid>, SK=SCORE). Probe 2026-05-15
    // shows ~7,097 records carrying { impact_score, justification, model }. Lands
    // these as denormalized fields on Publication; PMIDs not in our publication
    // table are skipped (same fail-isolated pattern as Block 2).
    console.log(`Scanning ${TABLE} for IMPACT# records (paginated)...`);
    const impactItems: ImpactRecord[] = [];
    {
      let lastKey: Record<string, unknown> | undefined;
      do {
        const resp = await ddb.send(
          new ScanCommand({
            TableName: TABLE,
            FilterExpression: "begins_with(PK, :prefix)",
            ExpressionAttributeValues: { ":prefix": "IMPACT#pmid_" },
            ExclusiveStartKey: lastKey,
          }),
        );
        for (const it of (resp.Items ?? []) as ImpactRecord[]) impactItems.push(it);
        lastKey = resp.LastEvaluatedKey;
      } while (lastKey);
    }
    console.log(`Found ${impactItems.length} IMPACT# records (expected ~7,097 per probe).`);

    let impactSkippedMissingPublication = 0;
    let impactSkippedMissingFields = 0;
    let impactRowsUpserted = 0;
    let impactJustificationLengthSum = 0;
    let impactJustificationCount = 0;

    type ImpactWrite = {
      pmid: string;
      impactScore: Prisma.Decimal;
      impactJustification: string | null;
      impactScoreModel: string | null;
    };

    const impactWrites: ImpactWrite[] = [];
    for (const it of impactItems) {
      const pmidStr =
        typeof it.pmid === "number" && Number.isFinite(it.pmid)
          ? String(it.pmid)
          : typeof it.pmid === "string" && /^\d+$/.test(it.pmid.trim())
            ? it.pmid.trim()
            : it.PK.startsWith("IMPACT#pmid_")
              ? it.PK.slice("IMPACT#pmid_".length)
              : "";
      const scoreNum = typeof it.impact_score === "number" ? it.impact_score : NaN;
      if (!pmidStr || !Number.isFinite(scoreNum)) {
        impactSkippedMissingFields += 1;
        continue;
      }
      if (!knownPmidSet.has(pmidStr)) {
        impactSkippedMissingPublication += 1;
        continue;
      }
      const justification =
        typeof it.justification === "string" && it.justification ? it.justification : null;
      if (justification) {
        impactJustificationLengthSum += justification.length;
        impactJustificationCount += 1;
      }
      impactWrites.push({
        pmid: pmidStr,
        impactScore: new Prisma.Decimal(scoreNum),
        impactJustification: justification,
        impactScoreModel: typeof it.model === "string" && it.model ? it.model : null,
      });
    }
    console.log(
      `IMPACT# candidates: ${impactWrites.length} (skipped: ${impactSkippedMissingPublication} missing publication, ${impactSkippedMissingFields} missing required fields).`,
    );

    // Update-only by pmid. Publication rows are created by the ReCiter ETL; this
    // block only fills in the impact fields on existing rows. `updateMany` with a
    // single-row where clause stays idempotent and avoids `update` throwing on a
    // missing row in the (rare) race where a publication was deleted between
    // knownPmidSet load and write.
    const IMPACT_BATCH = 100;
    for (let i = 0; i < impactWrites.length; i += IMPACT_BATCH) {
      const chunk = impactWrites.slice(i, i + IMPACT_BATCH);
      await Promise.all(
        chunk.map((w) =>
          prisma.publication.updateMany({
            where: { pmid: w.pmid },
            data: {
              impactScore: w.impactScore,
              impactJustification: w.impactJustification,
              impactScoreModel: w.impactScoreModel,
              impactRefreshedAt: new Date(),
            },
          }),
        ),
      );
      impactRowsUpserted += chunk.length;
      if ((i / IMPACT_BATCH) % 20 === 0) {
        console.log(`  ...updated ${impactRowsUpserted}/${impactWrites.length} publication impact rows`);
      }
    }
    const avgJustificationLen =
      impactJustificationCount > 0
        ? Math.round(impactJustificationLengthSum / impactJustificationCount)
        : 0;
    console.log(
      `publication impact updates complete: ${impactRowsUpserted} rows; avg justification length ${avgJustificationLen} chars across ${impactJustificationCount} non-null justifications.`,
    );

    // ===================================================================
    // Bookkeeping
    // ===================================================================
    const totalRowsProcessed =
      topicRowsUpserted + pubTopicRowsUpserted + rows.length + impactRowsUpserted;
    await prisma.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: totalRowsProcessed },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `DynamoDB ETL complete in ${elapsed}s: topic=${topicRowsUpserted}, publication_topic=${pubTopicRowsUpserted}, topic_assignment=${rows.length}, publication_impact=${impactRowsUpserted}`,
    );
  } catch (err) {
    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
