/**
 * DynamoDB ETL — Phase 4f + Phase 2 D-02 + Phase 8 D-03 (Block 2b retired) + Issue #316.
 *
 * Four projection blocks land ReCiterAI ground truth into MySQL:
 *
 *   1. TAXONOMY#  → topic                  (68 rows; parent topic catalog)
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
 * Issue #91 — Block 2 gains a post-write regression guard
 * (./publication-topic-guard.ts): an empty TOPIC# -> publication_topic
 * projection silently blanked every subtopic page, so the guard now
 * fails the run loudly instead of reporting a hollow success.
 *
 * Issue #348 — Block 2's per-record mapping moves to a pure, unit-tested
 * module (./publication-topic-mapper.ts), and it stops dropping rows with
 * an empty author_position: ReCiterAI emits "" on ~52% of TOPIC# items,
 * and discarding them built publication_topic from only ~half the data.
 * Such rows now land with authorPosition="".
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
import { db } from "../../lib/db";
import { clearTopicRebuildWindow } from "../../lib/etl-state";
import { resolveTopTopicByPmid } from "./top-topic-resolver";
import { assertPublicationTopicPopulated } from "./publication-topic-guard";
import { planPublicationTopicPrune } from "./publication-topic-prune";
import { buildPublicationTopicWrites } from "./publication-topic-mapper";
import { buildScholarToolWrites } from "./scholar-tool-mapper";
import { buildPublicationCoreWrites } from "./publication-core-mapper";
import { CORE_CATALOG, CORE_CATALOG_SOURCE } from "./core-catalog";
import { resolveScholarToolSource } from "../../lib/etl/scholar-tool-source";
import { projectGrantOpportunities } from "./grant-opportunity-etl";
import { guardedReplace } from "./projection-replace";
import { partitionRecords } from "./partition";

const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

async function main() {
  const start = Date.now();
  const run = await db.write.etlRun.create({
    data: { source: "ReCiterAI-projection", status: "running" },
  });

  try {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

    // ===================================================================
    // Single unfiltered table scan (#1514)
    // ===================================================================
    // A filtered DynamoDB Scan still reads (and bills) the ENTIRE table — the
    // FilterExpression runs server-side AFTER the read. This ETL used to run six
    // separate `begins_with` scans over the same table (one per prefix, Blocks
    // 1–6), for ~6× the table read + wall-clock per run. Collapse them to ONE
    // unfiltered paginated scan and partition the items in memory
    // (./partition.ts). Blocks below read their bucket instead of re-scanning;
    // Block 7 (GRANT#) still runs its own scan in grant-opportunity-etl.ts.
    //
    // ponytail: this buffers the whole table into `all` before partitioning —
    // the ceiling is task memory. It is fine at today's volumes (topics ~78k is
    // the dominant bucket either way, and the six buckets share item objects
    // with `all` rather than copying). If the table outgrows the task's memory,
    // the upgrade path is streaming / per-page partitioning (partition each page
    // and drain buckets as blocks finish) rather than materializing `all`.
    console.log(`Scanning ${TABLE} in a single unfiltered pass (paginated)...`);
    const all: Array<Record<string, unknown>> = [];
    let scanned = 0;
    {
      let lastKey: Record<string, unknown> | undefined;
      let pages = 0;
      do {
        const resp = await ddb.send(
          new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey }),
        );
        for (const it of resp.Items ?? []) all.push(it as Record<string, unknown>);
        scanned += resp.ScannedCount ?? 0;
        pages += 1;
        if (pages % 10 === 0) {
          console.log(`  ...scanned ${all.length} items so far (${pages} pages)`);
        }
        lastKey = resp.LastEvaluatedKey;
      } while (lastKey);
    }
    const buckets = partitionRecords(all);
    console.log(
      `Single scan complete: ~${scanned} items examined; partitioned into ` +
        `tax=${buckets.tax.length}, topics=${buckets.topics.length}, ` +
        `faculty=${buckets.faculty.length}, impact=${buckets.impact.length}, ` +
        `tools=${buckets.tools.length}, cores=${buckets.cores.length}.`,
    );

    // ===================================================================
    // Block 1: TAXONOMY# → topic  (Phase 2 D-02 candidate (e))
    // ===================================================================
    console.log(`Scanning ${TABLE} for TAXONOMY# records...`);
    const taxItems = buckets.tax;
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
      // Sequential upsert — 68 rows is trivial and guarantees deterministic ordering
      // for FK targets used by the TOPIC# block below.
      for (const t of topics) {
        if (!t || typeof t.id !== "string" || typeof t.label !== "string") continue;
        await db.write.topic.upsert({
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

    const topicCount = await db.write.topic.count();
    console.log(`topic table count: ${topicCount} (expected 68 for taxonomy_v2)`);
    if (topicCount !== 68) {
      console.warn(`WARN: topic count ${topicCount} != 68 — investigate TAXONOMY# probe output.`);
    }

    // ===================================================================
    // Block 2: TOPIC# → publication_topic  (Phase 2 D-02 candidate (e))
    // ===================================================================
    // Pre-load the active scholar set to skip rows that would violate the
    // publication_topic.cwid → scholar.cwid FK (rather than failing the whole ETL).
    // Filter matches the existing FACULTY# block below (deletedAt: null + status: active)
    // so both projections agree on which scholars are in scope.
    const ourScholars = await db.write.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    const ourCwidSet = new Set(ourScholars.map((s) => s.cwid));

    // Pre-load the topic id set for the TOPIC# parent_topic_id FK precheck. Any
    // TOPIC# row referencing a parent that is no longer in TAXONOMY# would also
    // violate FK; rare but worth defending against.
    const knownTopics = await db.write.topic.findMany({ select: { id: true } });
    const knownTopicIds = new Set(knownTopics.map((t) => t.id));

    // Pre-load known publication PMIDs. ReCiterAI's TOPIC# scope can include
    // PMIDs that haven't yet been ingested into our `publication` table (the
    // PubMed ETL runs separately); upserting those would violate
    // publication_topic.pmid → publication.pmid FK. Skip them with a counted
    // log line, same pattern as the scholar/parent-topic guards.
    const knownPubs = await db.write.publication.findMany({ select: { pmid: true } });
    const knownPmidSet = new Set(knownPubs.map((p) => p.pmid));

    console.log(`Scanning ${TABLE} for TOPIC# records (paginated)...`);
    const topicItems = buckets.topics;
    console.log(`Found ${topicItems.length} TOPIC# records (expected ~78,103 per probe).`);

    // Map TOPIC# records to publication_topic writes. The per-record
    // classification — FK guards, the required-field check, and the #348
    // empty-author_position relax — is pure and unit-tested; see
    // ./publication-topic-mapper.ts. Skip reasons are tallied by category
    // so the ETL bookkeeping stays auditable.
    const mapResult = buildPublicationTopicWrites(topicItems, {
      knownTopicIds,
      ourCwidSet,
      knownPmidSet,
    });
    const writes = mapResult.writes;
    let pubTopicRowsUpserted = 0;
    console.log(
      `publication_topic candidates: ${writes.length} (skipped: ` +
        `${mapResult.skippedMissingScholar} missing scholar, ` +
        `${mapResult.skippedMissingTopic} missing parent topic, ` +
        `${mapResult.skippedMissingPublication} missing publication, ` +
        `${mapResult.skippedMissingFields} missing required fields; ` +
        `${mapResult.emptyAuthorPosition} landed with empty author_position).`,
    );

    // Idempotent upsert keyed on the composite (pmid, cwid, parentTopicId).
    // Batch via Promise.all in chunks of 100 — Aurora MySQL handles this fine
    // and bounds open connection/transaction count for the local mariadb adapter.
    const BATCH = 100;
    for (let i = 0; i < writes.length; i += BATCH) {
      const chunk = writes.slice(i, i + BATCH);
      await Promise.all(
        chunk.map((w) =>
          db.write.publicationTopic.upsert({
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
              authorPosition: w.authorPosition,
              year: w.year,
            },
            update: {
              primarySubtopicId: w.primarySubtopicId,
              subtopicIds: w.subtopicIds,
              subtopicConfidences: w.subtopicConfidences,
              score: w.score,
              rationale: w.rationale,
              authorPosition: w.authorPosition,
              year: w.year,
            },
          }),
        ),
      );
      pubTopicRowsUpserted += chunk.length;
      if ((i / BATCH) % 50 === 0) {
        console.log(
          `  ...upserted ${pubTopicRowsUpserted}/${writes.length} publication_topic rows`,
        );
      }
    }
    console.log(`publication_topic upserts complete: ${pubTopicRowsUpserted} rows.`);

    // ----- Block 2 regression guard (issue #91) ------------------------
    // Issue #91 shipped only an operational fix (re-run the ETL) and left
    // publication_topic able to silently land empty again. This gate
    // fails the run loudly when the table would leave every subtopic page
    // blank — see ./publication-topic-guard.ts for the two failure modes.
    // Throwing here marks etl_run `failed`, exits non-zero, and surfaces
    // as FAIL in the daily orchestrator. Blocks 2b/2c/3/4 are skipped:
    // 2b/2c derive from the same TOPIC# scan and are equally suspect, and
    // 3/4 are idempotent — they refresh on the next cycle.
    const pubTopicTableCount = await db.write.publicationTopic.count();
    assertPublicationTopicPopulated({
      tableCount: pubTopicTableCount,
      scannedCount: topicItems.length,
      upsertedCount: pubTopicRowsUpserted,
    });
    console.log(`publication_topic guard OK: ${pubTopicTableCount} total rows.`);

    // ----- Block 2 keyed prune (#1511) ---------------------------------
    // The upsert loop only ADDS/updates triples; a (pmid, cwid, parentTopicId)
    // that ReciterAI dropped this run (a paper that fell out of a topic) is
    // never removed, so the stale row persists and keeps the paper on a
    // subtopic page it no longer belongs to. Delete the existing keys absent
    // from this run's write set -- but only when the write set clears the
    // guardedReplace floor, so a partial/truncated TOPIC# scan can never
    // mass-delete (mirrors the sibling projections' floor semantics). The guard
    // above already failed the run on an empty table / all-rejected scan, so
    // this only runs after a plausibly-complete upsert. Delete-only, so it needs
    // no transaction: a partial prune is safe (the next run finishes it).
    const existingPubTopicKeys = await db.write.publicationTopic.findMany({
      select: { pmid: true, cwid: true, parentTopicId: true },
    });
    const prunePlan = planPublicationTopicPrune(
      writes,
      existingPubTopicKeys,
      pubTopicTableCount,
    );
    if (!prunePlan.prune) {
      console.warn(
        `publication_topic prune SKIPPED -- ${prunePlan.reason}; likely a ` +
          "partial TOPIC# scan, retaining stale rows this run.",
      );
    } else if (prunePlan.stale.length === 0) {
      console.log("publication_topic prune: no stale associations.");
    } else {
      let pruned = 0;
      const PRUNE_BATCH = 200;
      for (let i = 0; i < prunePlan.stale.length; i += PRUNE_BATCH) {
        const chunk = prunePlan.stale.slice(i, i + PRUNE_BATCH);
        const res = await db.write.publicationTopic.deleteMany({
          where: {
            OR: chunk.map((k) => ({
              pmid: k.pmid,
              cwid: k.cwid,
              parentTopicId: k.parentTopicId,
            })),
          },
        });
        pruned += res.count;
      }
      console.log(`publication_topic prune: removed ${pruned} stale association(s).`);
    }

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
        const res = await db.write.publication.updateMany({
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
    // Block 2c: TOPIC#.synopsis → publication.synopsis  (issue #329)
    // ===================================================================
    // Same shape as Block 2b: TOPIC#.synopsis is per-paper, denormalized
    // across the N TOPIC# rows for one pmid. The migration moved the column
    // off `publication_topic` (per-(pmid,cwid,topic)) onto `publication`
    // (per-pmid). Collapse to first-non-empty per pmid and write once.
    const synopsisByPmid = new Map<string, string>();
    for (const it of topicItems) {
      const s = typeof it.synopsis === "string" && it.synopsis ? it.synopsis : "";
      if (!s) continue;
      const pmidStr =
        typeof it.pmid === "number" && Number.isFinite(it.pmid)
          ? String(it.pmid)
          : typeof it.pmid === "string" && /^\d+$/.test(it.pmid.trim())
            ? it.pmid.trim()
            : "";
      if (!pmidStr || !knownPmidSet.has(pmidStr)) continue;
      if (!synopsisByPmid.has(pmidStr)) synopsisByPmid.set(pmidStr, s);
      // Producer invariant says all TOPIC# rows for one pmid carry the same
      // synopsis. First-seen wins — same convention as top_topic_id.
    }

    let synopsisRowsUpdated = 0;
    const SYNOPSIS_BATCH = 500;
    const synopsisEntries = [...synopsisByPmid.entries()];
    for (let i = 0; i < synopsisEntries.length; i += SYNOPSIS_BATCH) {
      const chunk = synopsisEntries.slice(i, i + SYNOPSIS_BATCH);
      // updateMany doesn't support per-row data, and synopsis text differs
      // per pmid. One round-trip per pmid in the chunk; Promise.all bounds
      // the open connection count via the existing connection pool.
      await Promise.all(
        chunk.map(([pmid, synopsis]) =>
          db.write.publication.updateMany({
            where: { pmid },
            data: { synopsis },
          }),
        ),
      );
      synopsisRowsUpdated += chunk.length;
    }
    console.log(`synopsis updates: ${synopsisRowsUpdated} pmids set on publication.`);

    // ===================================================================
    // Block 3: FACULTY# → topic_assignment  (existing Q6 minimal projection)
    // ===================================================================
    // PRESERVED UNCHANGED from Phase 4f. Future plans may retire topic_assignment
    // once the Phase 2 surfaces validate against publication_topic.
    console.log(`Active scholars: ${ourCwidSet.size}; scanning ${TABLE} for FACULTY# records...`);

    const items = buckets.faculty;
    console.log(`Scanned ~${scanned} items, kept ${items.length} FACULTY# records.`);

    if (items.length > 0) {
      console.log("Sample record:", JSON.stringify(items[0], null, 2).slice(0, 500));
    }

    type TopicRow = { cwid: string; topic: string; score: number };
    const rows: TopicRow[] = [];
    // #742 v3.1 C3 — collect ReciterAI FACULTY# scale metrics per scholar (h-index,
    // first/last-author counts, scored-pub count) for the overview generator's
    // framing. Collected for every in-scope cwid, even ones with no top_topics.
    type FacultyMetric = {
      cwid: string;
      hIndex: number | null;
      firstAuthorCount: number | null;
      lastAuthorCount: number | null;
      scoredPubCount: number | null;
    };
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const metrics: FacultyMetric[] = [];
    for (const it of items) {
      const m = it.PK.match(/^FACULTY#cwid_(.+)$/);
      if (!m) continue;
      const cwid = m[1];
      if (!ourCwidSet.has(cwid)) continue;
      metrics.push({
        cwid,
        hIndex: num(it.h_index),
        firstAuthorCount: num(it.first_author_count),
        lastAuthorCount: num(it.last_author_count),
        scoredPubCount: num(it.scored_pub_count),
      });
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
    console.log(`Inserting ${rows.length}...`);
    const FACULTY_BATCH = 1000;
    // Atomic, sanity-guarded rebuild (see guardedReplace): refuses an
    // implausible shrink before deleting, and rolls back on a mid-load failure.
    await guardedReplace({
      table: "topic_assignment",
      rows,
      batchSize: FACULTY_BATCH,
      pick: (client) => client.topicAssignment,
      toData: (batch) =>
        batch.map((r) => ({
          cwid: r.cwid,
          topic: r.topic,
          score: r.score,
          source: "ReCiterAI-DynamoDB",
        })),
    });

    // #742 v3.1 C3 — write the FACULTY# scale metrics onto scholar (update-only;
    // scholar rows are created by the ED ETL). Skip scholars with no non-null
    // metric. Promise.all in chunks bounds the open-connection count.
    const metricWrites = metrics.filter(
      (mm) =>
        mm.hIndex !== null ||
        mm.firstAuthorCount !== null ||
        mm.lastAuthorCount !== null ||
        mm.scoredPubCount !== null,
    );
    let scholarMetricsUpdated = 0;
    const METRIC_BATCH = 100;
    for (let i = 0; i < metricWrites.length; i += METRIC_BATCH) {
      const chunk = metricWrites.slice(i, i + METRIC_BATCH);
      await Promise.all(
        chunk.map((mm) =>
          db.write.scholar.updateMany({
            where: { cwid: mm.cwid },
            data: {
              hIndex: mm.hIndex,
              firstAuthorCount: mm.firstAuthorCount,
              lastAuthorCount: mm.lastAuthorCount,
              scoredPubCount: mm.scoredPubCount,
            },
          }),
        ),
      );
      scholarMetricsUpdated += chunk.length;
    }
    console.log(`Scholar FACULTY# metrics updated: ${scholarMetricsUpdated} scholars.`);

    // ===================================================================
    // Block 4: IMPACT# → publication  (issue #316)
    // ===================================================================
    // IMPACT# is per-pmid only (PK=IMPACT#pmid_<pmid>, SK=SCORE). Probe 2026-05-15
    // shows ~7,097 records carrying { impact_score, justification, model }. Lands
    // these as denormalized fields on Publication; PMIDs not in our publication
    // table are skipped (same fail-isolated pattern as Block 2).
    console.log(`Scanning ${TABLE} for IMPACT# records (paginated)...`);
    const impactItems = buckets.impact;
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
          db.write.publication.updateMany({
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
        console.log(
          `  ...updated ${impactRowsUpserted}/${impactWrites.length} publication impact rows`,
        );
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
    // Block 5: TOOL# → scholar_tool  (#742 v3.1 C3)
    // ===================================================================
    // #794 — scholar_tool is being repointed to the A2 canonical S3 taxonomy
    // (etl/tools/index.ts). This legacy DDB rollup runs ONLY while
    // SCHOLAR_TOOL_SOURCE=ddb (the reversible default); when flipped to s3,
    // etl:scholar-tool is the sole scholar_tool writer and this block is skipped
    // so the two writers never both rebuild the table in one nightly run.
    let scholarToolRowsInserted = 0;
    if (resolveScholarToolSource() === "ddb") {
      // ReciterAI TOOL# items are per (tool × pmid × cwid) method/instrument
      // observations. Roll them up to one row per (cwid, tool) for the overview
      // generator's `methods` + a future "Methods & Tools" view. Full rebuild
      // (deleteMany + createMany), same shape as the topic_assignment block.
      console.log(`Scanning ${TABLE} for TOOL# records (paginated)...`);
      const toolItems = buckets.tools;
      console.log(`Found ${toolItems.length} TOOL# records.`);

      // The TOOL# PK carries the (sanitized) tool name and each item its
      // tool_category, so the rollup needs no TOOL_INDEX# join — keeps the scan
      // single-prefix. The mapper is pure + unit-tested (./scholar-tool-mapper.ts).
      const toolResult = buildScholarToolWrites(toolItems, { ourCwidSet });
      console.log(
        `scholar_tool candidates: ${toolResult.writes.length} rows ` +
          `(skipped ${toolResult.skippedMissingCwid} out-of-scope cwid, ` +
          `${toolResult.skippedMissingFields} missing tool/pmid).`,
      );

      console.log("Resetting scholar_tool table...");
      const TOOL_BATCH = 500;
      // Atomic, sanity-guarded rebuild (see guardedReplace): refuses an
      // implausible shrink before deleting, and rolls back on a mid-load failure.
      scholarToolRowsInserted = await guardedReplace({
        table: "scholar_tool",
        rows: toolResult.writes,
        batchSize: TOOL_BATCH,
        pick: (client) => client.scholarTool,
        toData: (batch) =>
          batch.map((w) => ({
            cwid: w.cwid,
            toolName: w.toolName,
            category: w.category,
            pmidCount: w.pmidCount,
            maxConfidence: new Prisma.Decimal(w.maxConfidence),
            sampleContext: w.sampleContext,
            pmids: w.pmids,
          })),
      });
      console.log(`scholar_tool inserts complete: ${scholarToolRowsInserted} rows.`);
    } else {
      console.log(
        "SCHOLAR_TOOL_SOURCE=s3 — skipping legacy TOOL# rollup; etl:scholar-tool owns scholar_tool (#794).",
      );
    }

    // ===================================================================
    // Block 6: PUB#/CORE# → core + publication_core  (cores inference, ReciterAI #245)
    // ===================================================================
    // The cores inference engine writes one item per (publication, core):
    // PK=PUB#{pmid}, SK=CORE#{core_id}. The partition key is the publication, so
    // this block filters on the SK prefix (begins_with(SK, "CORE#")) — the only
    // block keyed off SK rather than PK.
    //
    // There is no DynamoDB catalog record for cores (cf. TAXONOMY# for topics), so
    // the `core` catalog is seeded from the version-controlled CORE_CATALOG mirror
    // of ReciterAI's config/core_dictionary.yaml, then publication_core.coreId is
    // FK-guarded against it — the same Block 1 → Block 2 shape used for topics.
    // Human claims live in the ADR-005 override layer (read-time precedence); the
    // engine only ever sets candidate/confirmed here.
    //
    // No-ops cleanly when the engine hasn't published any CORE# items yet (the
    // current pre-merge state): the scan returns zero rows and the block logs 0.

    // Seed the core catalog (upsert; tiny + deterministic — one row today).
    let coreRowsUpserted = 0;
    for (const c of CORE_CATALOG) {
      await db.write.core.upsert({
        where: { id: c.id },
        create: {
          id: c.id,
          name: c.name,
          facility: c.facility,
          source: CORE_CATALOG_SOURCE,
          refreshedAt: new Date(),
        },
        update: {
          name: c.name,
          facility: c.facility,
          source: CORE_CATALOG_SOURCE,
          refreshedAt: new Date(),
        },
      });
      coreRowsUpserted += 1;
    }
    const knownCores = await db.write.core.findMany({ select: { id: true } });
    const knownCoreIds = new Set(knownCores.map((c) => c.id));
    console.log(
      `core catalog upserts complete: ${coreRowsUpserted} rows (${knownCoreIds.size} known core ids).`,
    );

    console.log(`Scanning ${TABLE} for CORE# records (begins_with SK, paginated)...`);
    const coreItems = buckets.cores;
    console.log(`Found ${coreItems.length} CORE# records.`);

    // Pure, unit-tested per-record mapping + FK guards; see ./publication-core-mapper.ts.
    const coreMap = buildPublicationCoreWrites(coreItems, { knownCoreIds, knownPmidSet });
    console.log(
      `publication_core candidates: ${coreMap.writes.length} (skipped: ` +
        `${coreMap.skippedMissingCore} missing core, ` +
        `${coreMap.skippedMissingPublication} missing publication, ` +
        `${coreMap.skippedMissingFields} missing required fields, ` +
        `${coreMap.skippedBelowThreshold} below threshold).`,
    );

    // Idempotent upsert keyed on (pmid, coreId). Same batch shape as Block 2.
    let pubCoreRowsUpserted = 0;
    const CORE_BATCH = 100;
    for (let i = 0; i < coreMap.writes.length; i += CORE_BATCH) {
      const chunk = coreMap.writes.slice(i, i + CORE_BATCH);
      await Promise.all(
        chunk.map((w) =>
          db.write.publicationCore.upsert({
            where: { pmid_coreId: { pmid: w.pmid, coreId: w.coreId } },
            create: {
              pmid: w.pmid,
              coreId: w.coreId,
              likelihood: w.likelihood,
              status: w.status,
              signalCoauthors: w.signalCoauthors,
              signalAck: w.signalAck,
              ackAlias: w.ackAlias,
              ackSnippet: w.ackSnippet,
              llmScore: w.llmScore,
              llmRationale: w.llmRationale,
              authorAffinity: w.authorAffinity,
              scoredAt: w.scoredAt,
            },
            update: {
              likelihood: w.likelihood,
              status: w.status,
              signalCoauthors: w.signalCoauthors,
              signalAck: w.signalAck,
              ackAlias: w.ackAlias,
              ackSnippet: w.ackSnippet,
              llmScore: w.llmScore,
              llmRationale: w.llmRationale,
              authorAffinity: w.authorAffinity,
              scoredAt: w.scoredAt,
            },
          }),
        ),
      );
      pubCoreRowsUpserted += chunk.length;
    }
    console.log(`publication_core upserts complete: ${pubCoreRowsUpserted} rows.`);

    // ===================================================================
    // Block 7: GRANT# → opportunity  (GrantRecs Phase 2)
    // ===================================================================
    // ReciterAI's pipeline_grants engine emits one GRANT# item per funding
    // OPPORTUNITY (not an awarded grant). Project them into the `opportunity`
    // table (idempotent upsert keyed on opportunity_id); the
    // `scholars-opportunities` OpenSearch index is rebuilt from these rows by
    // the search-index step. Pure map + paged scan live in
    // ./grant-opportunity-etl.ts + ./grant-opportunity-mapper.ts.
    console.log(`Scanning ${TABLE} for GRANT# records (paginated)...`);
    const grantResult = await projectGrantOpportunities(ddb, db.write, {
      table: TABLE,
      log: (m) => console.log(`  ${m}`),
    });
    const opportunityRowsUpserted = grantResult.upserted;

    // ===================================================================
    // Bookkeeping
    // ===================================================================
    const totalRowsProcessed =
      topicRowsUpserted +
      pubTopicRowsUpserted +
      rows.length +
      impactRowsUpserted +
      scholarToolRowsInserted +
      opportunityRowsUpserted +
      coreRowsUpserted +
      pubCoreRowsUpserted;
    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: totalRowsProcessed },
    });

    // #118 — topic edges are rebuilt; close the reciter→dynamodb consistency
    // window so the profile placeholder clears. A failed run (catch below)
    // deliberately leaves it open for the 30-minute auto-expiry.
    await clearTopicRebuildWindow();

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `DynamoDB ETL complete in ${elapsed}s: topic=${topicRowsUpserted}, publication_topic=${pubTopicRowsUpserted}, topic_assignment=${rows.length}, publication_impact=${impactRowsUpserted}, opportunity=${opportunityRowsUpserted}, core=${coreRowsUpserted}, publication_core=${pubCoreRowsUpserted}`,
    );
  } catch (err) {
    await db.write.etlRun.update({
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
    await db.write.$disconnect();
  });
