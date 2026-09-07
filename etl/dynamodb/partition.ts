/**
 * Pure record partitioner for the ReCiterAI -> app-DB projection ETL (#1514).
 *
 * A filtered DynamoDB Scan still reads (and bills) the ENTIRE table: the
 * FilterExpression is applied server-side AFTER the read, so a `begins_with`
 * scan pays for every item examined. etl/dynamodb/index.ts historically ran six
 * such filtered scans over the same table (one prefix each), for ~6x the table
 * read per projection run. This module lets that collapse to ONE unfiltered scan
 * whose items are partitioned in memory here.
 *
 * partitionRecords replicates each block's `begins_with()` predicate EXACTLY --
 * routing is the blast-radius-sensitive part of the collapse (it projects topics
 * / impact / cores for the whole app), so it lives in a pure, side-effect-free
 * function that tests/unit/dynamo-partition.test.ts can prove without a live
 * DynamoDB table. Do NOT "improve" or normalize the prefixes.
 *
 * The record types below are the canonical definitions (moved out of index.ts so
 * this module carries no top-level ETL side effects); index.ts consumes the
 * typed buckets returned here.
 */

export type FacultyRecord = {
  PK: string; // FACULTY#cwid_<cwid>
  SK?: string;
  top_topics?: Array<{ topic_id?: string; topic?: string; score: number }> | unknown;
  // #742 v3.1 C3 — ReciterAI scale metrics on the FACULTY#…/PROFILE item.
  h_index?: number;
  first_author_count?: number;
  last_author_count?: number;
  scored_pub_count?: number;
  [key: string]: unknown;
};

export type ToolRecord = {
  PK: string; // TOOL#<tool_id>
  SK?: string;
  faculty_uid?: string; // "cwid_<cwid>"
  pmid?: string | number;
  tool_category?: string;
  context?: string;
  score?: number; // normalized confidence [0,1]
  [key: string]: unknown;
};

export type TaxonomyRecord = {
  PK: string; // TAXONOMY#taxonomy_v2
  SK?: string;
  taxonomy_version?: string;
  topic_count?: number;
  topics?: Array<{ id: string; label: string; description?: string }>;
  [key: string]: unknown;
};

export type TopicRecord = {
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

export type ImpactRecord = {
  PK: string; // IMPACT#pmid_<pmid>
  SK?: string; // "SCORE" (only seen value as of probe 2026-05-15)
  pmid?: string | number;
  impact_score?: number;
  justification?: string;
  model?: string;
  [key: string]: unknown;
};

export type CoreRecord = {
  PK: string; // PUB#{pmid} — note: partition is the publication, not the core
  SK: string; // CORE#{core_id}
  pmid?: string | number;
  core_id?: string;
  likelihood?: number;
  status?: string; // candidate | confirmed | below_threshold
  scored_at?: string;
  signal_coauthors?: unknown; // string[] of core-staff CWIDs
  signal_ack?: boolean;
  ack_alias?: string;
  ack_snippet?: string;
  llm_score?: number;
  llm_rationale?: string;
  author_affinity?: number;
  [key: string]: unknown;
};

/**
 * The engine's per-core staff-count item: PK=`CORE#{core_id}`,
 * SK=`STAFF_DICT`. One item per core carrying two SIZES taken from the
 * facility dictionary — never the CWIDs themselves (see
 * etl/dynamodb/core-staff-mapper.ts):
 *
 *   `staff_count`          how many CWIDs the dictionary LISTS under `staff:`
 *   `staff_tracked_count`  how many of those the co-author signal can MATCH
 *
 * `STAFF_DICT`, not `STAFF`, and the suffix is the direction marker: this item
 * is dictionary-sourced and flows ReciterAI -> SPS. The bare `STAFF` key is
 * reserved for a future SPS-CURATED staff list, which by the existing
 * `(CORE#{id}, CLIENTS)` precedent (SPS writes, the engine reads) would want
 * exactly that key and would run the other way.
 *
 * Note the key shape is the MIRROR of a CoreRecord's: the core is the
 * PARTITION here (`PK`), where a CoreRecord puts the publication in `PK` and
 * the core in `SK`. That is why the routing below cannot lean on the `CORE#`
 * prefix alone.
 */
export type CoreStaffRecord = {
  PK: string; // CORE#{core_id}
  SK: string; // "STAFF_DICT"
  core_id?: string;
  staff_count?: number | string;
  staff_tracked_count?: number | string;
  [key: string]: unknown;
};

/**
 * A ReciterAI PRODUCER run, from the engine's own stage ledger
 * (`utils/stage_records.py` in the ReciterAI repo):
 *
 *   PK = `STAGE#{stage}#{scope}`     e.g. STAGE#daily_enrichment#GLOBAL
 *   SK = `RUN#{started_at}`          ISO8601, so lexical order is chronological
 *
 * This is the ONLY producer-side run record ReciterAI keeps, and it is the
 * answer to a question `etl_run` alone cannot ask: every ReciterAI-sourced
 * import here is graded on whether OUR loader ran, so a producer that stopped
 * publishing reads green forever. See etl/dynamodb/producer-run-mapper.ts for
 * the two SK shapes and the four statuses.
 *
 * Note `pipeline_tools`, `pipeline_grants` and `pipeline_cores` write NO stage
 * row at all — their liveness is not observable from this table.
 */
export type ProducerRunRecord = {
  PK: string; // STAGE#{stage}#{scope}
  SK: string; // RUN#{iso} | RUN#FAILED#{iso}
  stage?: string;
  scope?: string;
  status?: string; // complete | skipped | failed | partial
  started_at?: string;
  completed_at?: string;
  duration_ms?: number | string;
  records_written?: number | string;
  error_code?: string;
  error_message?: string;
  [key: string]: unknown;
};

export type Buckets = {
  tax: TaxonomyRecord[];
  topics: TopicRecord[];
  faculty: FacultyRecord[];
  impact: ImpactRecord[];
  tools: ToolRecord[];
  cores: CoreRecord[];
  coreStaff: CoreStaffRecord[];
  producerRuns: ProducerRunRecord[];
};

/**
 * Route each scanned item into exactly one bucket, replicating the six
 * `begins_with` FilterExpressions the six inline scans used:
 *
 *   Block 1 TAXONOMY# -> topic              begins_with(PK, "TAXONOMY#")
 *   Block 2 TOPIC#     -> publication_topic  begins_with(PK, "TOPIC#")
 *   Block 3 FACULTY#   -> topic_assignment   begins_with(PK, "FACULTY#cwid_")
 *   Block 4 IMPACT#    -> publication         begins_with(PK, "IMPACT#pmid_")
 *   Block 5 TOOL#      -> scholar_tool        begins_with(PK, "TOOL#")
 *   Block 6 PUB#/CORE# -> core                begins_with(SK, "CORE#")   <- SK, not PK
 *   Block 6b CORE#/STAFF_DICT -> core.staff_*  PK CORE# AND SK === "STAFF_DICT"
 *   Block 8  STAGE#    -> etl_run       begins_with(PK, "STAGE#")
 *
 * The buckets are disjoint (one `continue` per match), so the union exactly
 * reproduces what the six independent filtered scans kept. Block 7 (GRANT#) is
 * NOT handled here — it delegates to grant-opportunity-etl.ts's own scan.
 *
 * Block 6b is the one bucket that never had a filtered scan of its own: the
 * STAFF_DICT item is new (ReciterAI writes it, SPS reads it), and it was
 * previously dropped as unmatched. It is matched on the EXACT
 * `SK === "STAFF_DICT"`, not a prefix, so BOTH siblings under the same `CORE#`
 * partition keep falling through unmatched exactly as before: `SK = "CLIENTS"`
 * (which SPS writes and this ETL must never read back) and the reserved
 * `SK = "STAFF"` (a future SPS-curated list, likewise SPS-written).
 */
export function partitionRecords(items: Array<Record<string, unknown>>): Buckets {
  const b: Buckets = {
    tax: [],
    topics: [],
    faculty: [],
    impact: [],
    tools: [],
    cores: [],
    coreStaff: [],
    producerRuns: [],
  };
  for (const it of items) {
    const pk = String(it.PK ?? "");
    const sk = String(it.SK ?? "");
    // Block 6 keys on SK, regardless of PK (PK=PUB#{pmid}, SK=CORE#{core_id}).
    // Check FIRST: a PUB#… item matches no PK prefix and would otherwise be
    // dropped, which is exactly what its own filtered scan does today (it keeps
    // only SK-CORE# items).
    if (sk.startsWith("CORE#")) {
      b.cores.push(it as CoreRecord);
      continue;
    }
    // Block 6b keys on BOTH halves: PK=CORE#{core_id}, SK="STAFF_DICT". The SK
    // is matched exactly rather than by prefix so the sibling PK=CORE#… items
    // SPS writes stay unmatched — SK="CLIENTS" (lib/cores/client-writeback.ts)
    // today, and the reserved SK="STAFF" tomorrow. Reading our own writeback
    // back in would be a loop, not an ingest, and a `sk.startsWith("STAFF")`
    // here would swallow that reserved key the day it is used.
    if (pk.startsWith("CORE#") && sk === "STAFF_DICT") {
      b.coreStaff.push(it as CoreStaffRecord);
      continue;
    }
    if (pk.startsWith("TAXONOMY#")) {
      b.tax.push(it as TaxonomyRecord);
      continue;
    }
    if (pk.startsWith("TOPIC#")) {
      b.topics.push(it as TopicRecord);
      continue;
    }
    if (pk.startsWith("FACULTY#cwid_")) {
      b.faculty.push(it as FacultyRecord);
      continue;
    }
    if (pk.startsWith("IMPACT#pmid_")) {
      b.impact.push(it as ImpactRecord);
      continue;
    }
    if (pk.startsWith("TOOL#")) {
      b.tools.push(it as ToolRecord);
      continue;
    }
    // Block 8 — the producer's own run ledger. Unlike every bucket above it,
    // this one is not projected into a table: it is mirrored into `etl_run` so
    // /edit/etl-status can grade the PRODUCER, not just our loader. Matched on
    // the PK prefix alone; the per-scope split (GLOBAL vs cwid:/pmid:) is the
    // mapper's business, not the router's.
    if (pk.startsWith("STAGE#")) {
      b.producerRuns.push(it as ProducerRunRecord);
      continue;
    }
    // else: unmatched (e.g. a GRANT# item, or a PUB# item without an SK CORE#
    // prefix) — dropped into no bucket, identical to today's filtered scans
    // ignoring the items their FilterExpression excludes.
  }
  return b;
}
