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
  prestige?: unknown; // { score, mechanism_tier, size_bucket, sponsor_tier, selectivity, label, rationale }
  eligibility?: unknown; // native DDB map (M) → plain object post-DocumentClient: structured eligibility (#290 + v2)
  match_dsl?: unknown; // compact-JSON `S` string: { require, penalize, pediatric_markers, pediatric_required }
  match_query?: unknown; // compact-JSON `S` string: [{ q, w }] weighted BM25 terms
  match_rel?: unknown; // compact-JSON `S` string: { pmid: cosine∈[0,1] } dense relevance map
  is_honorific?: boolean;
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
  prestige: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  eligibility: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  matchDsl: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  matchQuery: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  matchRel: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  isHonorific: boolean | null;
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
 * ReciterAI persists `match_dsl`/`match_query` as compact-JSON DynamoDB `S` strings
 * (the DocumentClient yields them as JS strings). Parse → JSON for the `Json?` column;
 * fail-open to `JsonNull` on absent/blank/malformed so the matcher stays fail-closed.
 * ponytail: also passes through an already-parsed object/array, so a future switch to
 * native DDB maps/lists needs no change here.
 */
function parseJsonAttr(raw: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (raw && typeof raw === "object") return raw as Prisma.InputJsonValue;
  const s = trimStr(raw);
  if (!s) return Prisma.JsonNull;
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" ? (v as Prisma.InputJsonValue) : Prisma.JsonNull;
  } catch {
    return Prisma.JsonNull;
  }
}

const FACULTY_STAGES = new Set([
  "early_career_faculty",
  "mid_career_faculty",
  "senior_faculty",
  "any_faculty",
  "clinician",
]);
const STUDENT_STAGES = new Set(["undergraduate", "graduate_student"]);

/** Derive the 5 flags from the STRUCTURED eligibility map (preferred when present). */
function deriveEligibilityFlagsFromMap(elig: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const orgTypes = asStrings(elig.applicant_org_types);
  const stages = asStrings(elig.career_stages);

  // us_eligible — RETAIN aggressively: the live matcher hard-requires it
  // (`{ term: { eligibilityFlags: "us_eligible" } }`), so clearing it returns zero results.
  // Clear ONLY when the award is exclusively foreign.
  const foreignOnly = orgTypes.length > 0 && orgTypes.every((o) => o === "foreign_org");
  if (!foreignOnly) flags.push("us_eligible");

  // student_only — career_stages present AND wholly within {undergraduate, graduate_student}.
  if (stages.length > 0 && stages.every((s) => STUDENT_STAGES.has(s))) flags.push("student_only");

  // faculty_eligible — no person-level restriction (empty) OR intersects faculty/clinician.
  if (stages.length === 0 || stages.some((s) => FACULTY_STAGES.has(s))) flags.push("faculty_eligible");

  // postdoc_eligible — no restriction (empty) OR postdoc explicitly listed.
  if (stages.length === 0 || stages.includes("postdoc")) flags.push("postdoc_eligible");

  // internal_limited_submission — the structured bool (the prose-regex equivalent).
  if (elig.limited_submission === true) flags.push("internal_limited_submission");

  return flags;
}

/** Derive the 5 flags from the raw eligibility PROSE (fallback for pre-backfill rows). */
function deriveEligibilityFlagsFromProse(eligibilityRaw: string | null | undefined): string[] {
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

/**
 * Derive the eligibility flags. Prefer the STRUCTURED `eligibility` map when present (accurate,
 * #290 + v2 facets); fall back to the raw-prose regexes for pre-backfill rows. Hard gates stay
 * PERMISSIVE — nuanced career-stage fit lives in `appeal_by_stage`, not here (spec §9).
 *
 * Flags: `us_eligible`, `faculty_eligible`, `postdoc_eligible`, `student_only`,
 * `internal_limited_submission`. 🔴 `us_eligible` is RETAINED — the matcher hard-requires it.
 */
export function deriveEligibilityFlags(
  eligibility: unknown,
  eligibilityRaw: string | null | undefined,
): string[] {
  if (eligibility && typeof eligibility === "object" && !Array.isArray(eligibility)) {
    return deriveEligibilityFlagsFromMap(eligibility as Record<string, unknown>);
  }
  return deriveEligibilityFlagsFromProse(eligibilityRaw);
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
      eligibilityFlags: deriveEligibilityFlags(it.eligibility, it.eligibility_raw),
      eligibility:
        it.eligibility && typeof it.eligibility === "object" && !Array.isArray(it.eligibility)
          ? (it.eligibility as Prisma.InputJsonValue)
          : Prisma.JsonNull,
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
      prestige:
        it.prestige && typeof it.prestige === "object" && !Array.isArray(it.prestige)
          ? (it.prestige as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      matchDsl: parseJsonAttr(it.match_dsl),
      matchQuery: parseJsonAttr(it.match_query),
      matchRel: parseJsonAttr(it.match_rel),
      isHonorific: typeof it.is_honorific === "boolean" ? it.is_honorific : null,
      taxonomyVersion: trimStr(it.taxonomy_version),
      ingestedAt: parseIsoDate(it.ingested_at) ?? new Date(0),
    });
  }

  return { writes, skipped: { nonResearch, missingFields } };
}
