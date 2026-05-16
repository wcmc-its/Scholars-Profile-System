/**
 * Pure helper extracted from etl/dynamodb/index.ts Block 2 (TOPIC# ->
 * publication_topic) so the per-record mapping + FK/field guards can be
 * unit-tested without a DynamoDB scan — the same split as ./top-topic-resolver.ts.
 *
 * Issue #348: a TOPIC# row with an empty `author_position` is NO LONGER
 * dropped. ReCiterAI emits `author_position: ""` on ~52% of TOPIC# items;
 * the previous "required field" treatment discarded the whole
 * (pmid, cwid, parentTopicId) association, so publication_topic — and every
 * subtopic page reading it — was built from only ~half the data. The field
 * feeds only the first/last-author rollup filter (`authorPosition IN
 * ('first','last')` in lib/api/topics.ts, home.ts, spotlight.ts), which an
 * empty string never matches, so the row now lands with authorPosition=""
 * and the rollups stay correct. pmid / score / year remain genuinely
 * required — pmid and year are NOT NULL columns and pmid is an FK.
 */
import { Prisma } from "@/lib/generated/prisma/client";

/**
 * Minimal shape of a TOPIC# DynamoDB record consumed by the mapper. The full
 * scan record (index.ts TopicRecord) carries more fields read by other
 * blocks; the mapper only needs these — the same narrowing as
 * ./top-topic-resolver.ts's TopTopicCandidate.
 */
export type TopicRecordInput = {
  PK: string;
  pmid?: string | number;
  faculty_uid?: string; // "cwid_<cwid>"
  primary_subtopic_id?: string;
  subtopic_ids?: unknown;
  subtopic_confidences?: unknown;
  score?: number;
  rationale?: string;
  author_position?: string;
  year?: number;
};

export type PubTopicWrite = {
  pmid: string;
  cwid: string;
  parentTopicId: string;
  primarySubtopicId: string | null;
  subtopicIds: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  subtopicConfidences: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  score: Prisma.Decimal;
  rationale: string | null;
  // synopsis + impact_score are intentionally absent: synopsis is per-pmid
  // (Block 2c writes it to publication, #329) and the impact_score mirror
  // column was dropped in #316. Both are handled outside Block 2.
  authorPosition: string;
  year: number;
};

export type PublicationTopicMapResult = {
  /** Rows that cleared every guard and are ready to upsert. */
  writes: PubTopicWrite[];
  /** Skipped: parent_topic_id not in the local topic catalog (FK guard). */
  skippedMissingTopic: number;
  /** Skipped: cwid not in the active scholar set (FK guard). */
  skippedMissingScholar: number;
  /** Skipped: a genuinely-required scalar (pmid / score / year) was absent. */
  skippedMissingFields: number;
  /** Skipped: pmid not yet in the publication table (FK guard). */
  skippedMissingPublication: number;
  /** Of `writes`, how many carry an empty author_position (#348 observability). */
  emptyAuthorPosition: number;
};

/** Strip the DynamoDB-specific "cwid_" prefix from a faculty_uid fragment. */
function stripCwidPrefix(raw: string): string {
  return raw.startsWith("cwid_") ? raw.slice("cwid_".length) : raw;
}

/**
 * Map TOPIC# scan records to publication_topic write payloads, applying the
 * four FK/field guards. Skip categories are counted (not thrown) so a partial
 * upstream day is fail-isolated — the index.ts caller logs the tally.
 *
 * Guard order mirrors index.ts Block 2: parent topic -> scholar -> required
 * fields -> publication. `author_position` is intentionally NOT a required
 * field (#348) — an empty value lands as "".
 */
export function buildPublicationTopicWrites(
  records: ReadonlyArray<TopicRecordInput>,
  sets: {
    knownTopicIds: ReadonlySet<string>;
    ourCwidSet: ReadonlySet<string>;
    knownPmidSet: ReadonlySet<string>;
  },
): PublicationTopicMapResult {
  const { knownTopicIds, ourCwidSet, knownPmidSet } = sets;
  const writes: PubTopicWrite[] = [];
  let skippedMissingTopic = 0;
  let skippedMissingScholar = 0;
  let skippedMissingFields = 0;
  let skippedMissingPublication = 0;
  let emptyAuthorPosition = 0;

  for (const it of records) {
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
    // to FK-relate to publication.pmid (String @id). Stringify.
    const pmidStr =
      typeof it.pmid === "number" && Number.isFinite(it.pmid)
        ? String(it.pmid)
        : typeof it.pmid === "string" && /^\d+$/.test(it.pmid.trim())
          ? it.pmid.trim()
          : "";
    const score = typeof it.score === "number" ? it.score : NaN;
    const yearNum = typeof it.year === "number" ? it.year : NaN;
    const authorPosition = typeof it.author_position === "string" ? it.author_position : "";

    // pmid / score / year stay required. author_position does NOT (#348): an
    // empty value lands as "" rather than discarding the whole association.
    if (!pmidStr || !Number.isFinite(score) || !Number.isFinite(yearNum)) {
      skippedMissingFields += 1;
      continue;
    }

    if (!knownPmidSet.has(pmidStr)) {
      skippedMissingPublication += 1;
      continue;
    }

    if (!authorPosition) emptyAuthorPosition += 1;

    writes.push({
      pmid: pmidStr,
      cwid: rawCwid,
      parentTopicId,
      primarySubtopicId: typeof it.primary_subtopic_id === "string" ? it.primary_subtopic_id : null,
      subtopicIds:
        it.subtopic_ids !== undefined && it.subtopic_ids !== null
          ? (it.subtopic_ids as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      subtopicConfidences:
        it.subtopic_confidences !== undefined && it.subtopic_confidences !== null
          ? (it.subtopic_confidences as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      score: new Prisma.Decimal(score),
      rationale: typeof it.rationale === "string" && it.rationale ? it.rationale : null,
      authorPosition,
      year: yearNum,
    });
  }

  return {
    writes,
    skippedMissingTopic,
    skippedMissingScholar,
    skippedMissingFields,
    skippedMissingPublication,
    emptyAuthorPosition,
  };
}
