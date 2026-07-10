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

export type Buckets = {
  tax: TaxonomyRecord[];
  topics: TopicRecord[];
  faculty: FacultyRecord[];
  impact: ImpactRecord[];
  tools: ToolRecord[];
  cores: CoreRecord[];
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
 *
 * The buckets are disjoint (one `continue` per match), so the union exactly
 * reproduces what the six independent filtered scans kept. Block 7 (GRANT#) is
 * NOT handled here — it delegates to grant-opportunity-etl.ts's own scan.
 */
export function partitionRecords(items: Array<Record<string, unknown>>): Buckets {
  const b: Buckets = { tax: [], topics: [], faculty: [], impact: [], tools: [], cores: [] };
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
    // else: unmatched (e.g. a GRANT# item, or a PUB# item without an SK CORE#
    // prefix) — dropped into no bucket, identical to today's filtered scans
    // ignoring the items their FilterExpression excludes.
  }
  return b;
}
