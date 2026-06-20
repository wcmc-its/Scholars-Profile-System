/**
 * Pure mapper: ReciterAI `GRANT#` DynamoDB items → `opportunity` rows
 * (GrantRecs Phase 2). Kept side-effect-free + unit-tested, mirroring
 * `scholar-tool-mapper.ts` / `publication-topic-mapper.ts`, so the
 * parse/coerce/gate logic is verifiable without a DDB scan or a DB.
 *
 * Each `GRANT#` item (PK=`GRANT#<opportunity_id>`, SK=`META`) is one funding
 * opportunity emitted by the ReciterAI `pipeline_grants` engine. The
 * DocumentClient (`@aws-sdk/lib-dynamodb`) yields it already unwrapped, so we
 * receive plain JS — no `{"S":…}`/`{"N":…}` handling needed. We parse ISO dates,
 * coerce award amounts to BigInt, derive structured eligibility flags from the
 * raw eligibility prose, and drop non-research / malformed records (the engine
 * should already exclude non-research, but the gate is cheap insurance).
 *
 * See `2026-06-19-grantrecs-phase2-matching-engine-design.md` §5/§9.
 */
import { Prisma } from "@/lib/generated/prisma/client";

/** The subset of a `GRANT#` item this mapper reads (post-DocumentClient, plain JS). */
export type GrantRecordInput = {
  PK: string; // GRANT#<opportunity_id>
  SK?: string;
  opportunity_id?: string;
  source?: string;
  source_url?: string;
  sponsor?: string;
  title?: string;
  synopsis?: string;
  status?: string;
  open_date?: string; // ISO; "" / absent = none
  due_date?: string; // ISO; "" / absent = continuous (null)
  eligibility_raw?: string;
  cfda_list?: unknown; // string[]
  mechanism?: string;
  award_ceiling?: number | null;
  award_floor?: number | null;
  estimated_funding?: number | null;
  number_of_awards?: number | null;
  primary_topic_id?: string;
  topic_vector?: unknown; // [{ topic_id, score, rationale }]
  appeal_by_stage?: unknown; // { grad, postdoc, early, mid, senior }
  is_research?: boolean;
  mesh_descriptor_ui?: unknown; // string[]
  taxonomy_version?: string;
  ingested_at?: string; // ISO
  [key: string]: unknown;
};

/** One `opportunity` row to upsert. `lastRefreshedAt` is set by the ETL/DB default. */
export type OpportunityWrite = {
  opportunityId: string;
  source: string;
  sourceUrl: string;
  sponsor: string;
  title: string;
  synopsis: string;
  status: string;
  openDate: Date | null;
  dueDate: Date | null;
  eligibilityRaw: string;
  eligibilityFlags: Prisma.InputJsonValue;
  cfdaList: Prisma.InputJsonValue;
  mechanism: string | null;
  awardCeiling: bigint | null;
  awardFloor: bigint | null;
  estimatedFunding: bigint | null;
  numberOfAwards: number | null;
  primaryTopicId: string | null;
  topicVector: Prisma.InputJsonValue;
  appealByStage: Prisma.InputJsonValue;
  isResearch: boolean;
  meshDescriptorUi: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  taxonomyVersion: string;
  ingestedAt: Date;
};

export type BuildOpportunityResult = {
  writes: OpportunityWrite[];
  skipped: { nonResearch: number; missingFields: number };
};

/** `GRANT#grants_gov:359855` → `grants_gov:359855`; non-GRANT# / bare → "". */
function parseOpportunityId(pk: string): string {
  if (typeof pk !== "string" || !pk.startsWith("GRANT#")) return "";
  return pk.slice("GRANT#".length).trim();
}

/** ISO string → Date; blank/absent/invalid → null. */
function parseIsoDate(s: string | null | undefined): Date | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Finite number → BigInt (truncated); null/undefined/non-finite → null. */
function toBigIntOrNull(n: number | null | undefined): bigint | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return BigInt(Math.trunc(n));
}

/** Finite integer → number; else null. */
function toIntOrNull(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function trimStr(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

/**
 * Derive structured eligibility flags from the raw eligibility prose. Hard gates
 * are intentionally PERMISSIVE — only exclude on a clear signal — because the
 * nuanced career-stage fit lives in `appeal_by_stage`, not here (spec §9).
 *
 * Flags: `us_eligible`, `faculty_eligible`, `postdoc_eligible`, `student_only`,
 * `internal_limited_submission`.
 */
export function deriveEligibilityFlags(eligibilityRaw: string | null | undefined): string[] {
  const text = (typeof eligibilityRaw === "string" ? eligibilityRaw : "").toLowerCase();
  const flags: string[] = [];

  // US eligibility — default true; clear only on explicit foreign-only language.
  const foreignOnly =
    /\bforeign (institutions?|organizations?|entities)\s+only\b/.test(text) ||
    /\bnon-?u\.?s\.?\s+(institutions?|organizations?|entities)\s+only\b/.test(text) ||
    /\boutside the united states only\b/.test(text);
  if (!foreignOnly) flags.push("us_eligible");

  // Student/predoctoral-only — the one audience gate that withholds faculty.
  const studentOnly =
    /\b(predoctoral|pre-doctoral|dissertation)\b/.test(text) ||
    /\bstudents? only\b/.test(text) ||
    /\bmust be (a|an )?(enrolled|currently enrolled) (student|predoctoral)\b/.test(text) ||
    /\benrolled (predoctoral|doctoral) students?\b/.test(text);
  if (studentOnly) flags.push("student_only");

  // Faculty eligibility — true unless it's a student-only opportunity.
  if (!studentOnly) flags.push("faculty_eligible");

  // Postdoc eligibility — true unless restricted to independent/faculty PIs only.
  const facultyOnly =
    /\bindependent (faculty )?(investigators?|researchers?)\b/.test(text) ||
    /\bmust hold (an? )?(independent )?faculty appointment\b/.test(text) ||
    /\bno postdoctoral (fellows?|researchers?)\b/.test(text);
  if (!facultyOnly && !studentOnly) flags.push("postdoc_eligible");

  // Limited / internal submission.
  if (
    /\blimited submission\b/.test(text) ||
    /\binternal competition\b/.test(text) ||
    /\b(only|up to)\s+\w+\s+applications? per institution\b/.test(text)
  ) {
    flags.push("internal_limited_submission");
  }

  return flags;
}

/** Build `opportunity` upsert writes from a flat list of `GRANT#` items. */
export function buildOpportunityWrites(items: GrantRecordInput[]): BuildOpportunityResult {
  const writes: OpportunityWrite[] = [];
  let nonResearch = 0;
  let missingFields = 0;

  for (const it of items) {
    // Defensive non-research gate (engine should already exclude these).
    if (it.is_research === false) {
      nonResearch += 1;
      continue;
    }

    const opportunityId = trimStr(it.opportunity_id) || parseOpportunityId(it.PK);
    const title = trimStr(it.title);
    const synopsis = trimStr(it.synopsis);
    if (!opportunityId || !title || !synopsis) {
      missingFields += 1;
      continue;
    }

    const meshUi = it.mesh_descriptor_ui;
    writes.push({
      opportunityId,
      source: trimStr(it.source),
      sourceUrl: trimStr(it.source_url),
      sponsor: trimStr(it.sponsor),
      title,
      synopsis,
      status: trimStr(it.status),
      openDate: parseIsoDate(it.open_date),
      dueDate: parseIsoDate(it.due_date),
      eligibilityRaw: trimStr(it.eligibility_raw),
      eligibilityFlags: deriveEligibilityFlags(it.eligibility_raw),
      cfdaList: (Array.isArray(it.cfda_list) ? it.cfda_list : []) as Prisma.InputJsonValue,
      mechanism: trimStr(it.mechanism) || null,
      awardCeiling: toBigIntOrNull(it.award_ceiling),
      awardFloor: toBigIntOrNull(it.award_floor),
      estimatedFunding: toBigIntOrNull(it.estimated_funding),
      numberOfAwards: toIntOrNull(it.number_of_awards),
      primaryTopicId: trimStr(it.primary_topic_id) || null,
      topicVector: (Array.isArray(it.topic_vector) ? it.topic_vector : []) as Prisma.InputJsonValue,
      appealByStage: (it.appeal_by_stage &&
      typeof it.appeal_by_stage === "object"
        ? it.appeal_by_stage
        : {}) as Prisma.InputJsonValue,
      isResearch: it.is_research ?? true, // reached only when not === false; undefined ⇒ research
      meshDescriptorUi: Array.isArray(meshUi)
        ? (meshUi as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      taxonomyVersion: trimStr(it.taxonomy_version),
      ingestedAt: parseIsoDate(it.ingested_at) ?? new Date(0),
    });
  }

  return { writes, skipped: { nonResearch, missingFields } };
}
