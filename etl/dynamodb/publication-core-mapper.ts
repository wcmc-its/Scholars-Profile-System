/**
 * Pure helper for etl/dynamodb/index.ts Block 6 (PUB#/CORE# -> publication_core),
 * split out so the per-record mapping + FK/field guards can be unit-tested
 * without a DynamoDB scan — the same split as ./publication-topic-mapper.ts.
 *
 * The cores inference engine (ReciterAI PR #245) writes one item per
 * (publication, core): PK=`PUB#{pmid}`, SK=`CORE#{core_id}` in the shared
 * `reciterai` table. Unlike TOPIC# rows there is NO scholar dimension — core
 * usage is a property of the publication, not a (pub, scholar) pair — so a row
 * maps on (pmid, coreId) only. Human claims/rejections are NOT projected here;
 * they live in SPS's ADR-005 manual-override layer and take read-time precedence.
 *
 * `below_threshold` rows (scored but deliberately not surfaced by the engine) are
 * dropped here and tallied, so the per-core claim queue holds only surfaceable
 * candidates + confirmed usages.
 */
import { Prisma } from "@/lib/generated/prisma/client";

/**
 * Minimal shape of a PUB#/CORE# DynamoDB record consumed by the mapper. The
 * DocumentClient scan unmarshals the attribute format, so list/number/bool
 * fields arrive as native JS values. Only the fields the mapper reads are typed.
 */
export type CoreRecordInput = {
  PK: string; // "PUB#{pmid}"
  SK: string; // "CORE#{core_id}"
  pmid?: string | number;
  core_id?: string;
  likelihood?: number; // 0-1 combined-signal likelihood
  status?: string; // candidate | confirmed | below_threshold
  scored_at?: string; // ISO timestamp
  signal_coauthors?: unknown; // string[] of core-staff CWIDs on the byline
  signal_ack?: boolean;
  ack_alias?: string;
  ack_snippet?: string;
  llm_score?: number; // 1-10 dense triage
  llm_rationale?: string;
  author_affinity?: number; // 0-1 repeat-user prior
  prefilter_prior?: number; // 0-1 batch_screen noisy-OR prior (author-affinity 0.6 + bare-descriptor MeSH E-tree membership 0.4)
  method_tier?: string; // family-strength band: strong | moderate | weak
  method_evidence?: unknown; // [{ family, tool, sentence }], pre-ranked strongest first
  mesh_evidence?: unknown; // [{ descriptor_ui, descriptor, tree_prefix }]
};

export type PubCoreWrite = {
  pmid: string;
  coreId: string;
  likelihood: Prisma.Decimal;
  status: string;
  signalCoauthors: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  signalAck: boolean;
  ackAlias: string | null;
  ackSnippet: string | null;
  llmScore: number | null;
  llmRationale: string | null;
  authorAffinity: Prisma.Decimal | null;
  topicalPrior: Prisma.Decimal | null;
  methodTier: string | null;
  methodEvidence: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  meshEvidence: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  scoredAt: Date;
};

export type PublicationCoreMapResult = {
  /** Rows that cleared every guard and are ready to upsert. */
  writes: PubCoreWrite[];
  /** Skipped: core_id not in the seeded catalog (FK guard). */
  skippedMissingCore: number;
  /** Skipped: a genuinely-required scalar (pmid / likelihood / status / scored_at) was absent or invalid. */
  skippedMissingFields: number;
  /** Skipped: status === "below_threshold" — scored by the engine but not surfaced. */
  skippedBelowThreshold: number;
  /** Skipped: pmid not yet in the publication table (FK guard). */
  skippedMissingPublication: number;
};

/** Engine status for a scored-but-not-surfaced (pub, core) pair. */
const STATUS_BELOW_THRESHOLD = "below_threshold";

/** Keys the engine always writes on a `method_evidence` entry. */
const METHOD_EVIDENCE_KEYS = ["family", "tool", "sentence"] as const;
/** Keys the engine always writes on a `mesh_evidence` entry. */
const MESH_EVIDENCE_KEYS = ["descriptor_ui", "descriptor", "tree_prefix"] as const;
/** `publication_core.method_tier` is VARCHAR(16); a longer value would 1406. */
const METHOD_TIER_MAX = 16;

/**
 * Keep the well-formed entries of an evidence list, dropping the rest. The scan
 * is untrusted, so an entry missing one of the engine's required string keys is
 * dropped here rather than written through for a consumer to defend against;
 * anything that isn't a list at all yields no entries (never throws). Entries
 * that pass are kept WHOLE — a field the engine adds later then lands without
 * another ETL change, which is the failure this plumbing exists to fix.
 *
 * Upstream order is preserved: `method_evidence` arrives pre-ranked, strongest
 * first, and consumers read `[0]` as the strongest.
 */
function evidenceEntries(
  value: unknown,
  requiredKeys: ReadonlyArray<string>,
): Prisma.InputJsonValue[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Prisma.InputJsonValue => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const rec = entry as Record<string, unknown>;
    return requiredKeys.every((k) => typeof rec[k] === "string");
  });
}

function parseCoreId(it: CoreRecordInput): string {
  if (typeof it.SK === "string" && it.SK.startsWith("CORE#")) return it.SK.slice("CORE#".length);
  return typeof it.core_id === "string" ? it.core_id : "";
}

function parsePmid(it: CoreRecordInput): string {
  if (typeof it.pmid === "number" && Number.isFinite(it.pmid)) return String(it.pmid);
  if (typeof it.pmid === "string" && /^\d+$/.test(it.pmid.trim())) return it.pmid.trim();
  if (typeof it.PK === "string" && it.PK.startsWith("PUB#")) {
    const fromPk = it.PK.slice("PUB#".length).trim();
    if (/^\d+$/.test(fromPk)) return fromPk;
  }
  return "";
}

/**
 * Map PUB#/CORE# scan records to publication_core write payloads, applying the
 * FK/field guards. Skip categories are counted (not thrown) so a partial
 * upstream day is fail-isolated — the index.ts caller logs the tally.
 *
 * Guard order: core (catalog FK) -> required fields -> below-threshold drop ->
 * publication FK.
 */
export function buildPublicationCoreWrites(
  records: ReadonlyArray<CoreRecordInput>,
  sets: {
    knownCoreIds: ReadonlySet<string>;
    knownPmidSet: ReadonlySet<string>;
  },
): PublicationCoreMapResult {
  const { knownCoreIds, knownPmidSet } = sets;
  const writes: PubCoreWrite[] = [];
  let skippedMissingCore = 0;
  let skippedMissingFields = 0;
  let skippedBelowThreshold = 0;
  let skippedMissingPublication = 0;

  for (const it of records) {
    const coreId = parseCoreId(it);
    if (!coreId || !knownCoreIds.has(coreId)) {
      skippedMissingCore += 1;
      continue;
    }

    const pmidStr = parsePmid(it);
    const likelihood = typeof it.likelihood === "number" ? it.likelihood : NaN;
    const status = typeof it.status === "string" && it.status ? it.status : "";
    // scored_at is NOT NULL in MySQL and the engine always emits it; an absent or
    // unparseable value is treated as a missing required field rather than guessed.
    const scoredAtMs = typeof it.scored_at === "string" ? Date.parse(it.scored_at) : NaN;
    if (!pmidStr || !Number.isFinite(likelihood) || !status || !Number.isFinite(scoredAtMs)) {
      skippedMissingFields += 1;
      continue;
    }

    if (status === STATUS_BELOW_THRESHOLD) {
      skippedBelowThreshold += 1;
      continue;
    }

    if (!knownPmidSet.has(pmidStr)) {
      skippedMissingPublication += 1;
      continue;
    }

    const coauthors = Array.isArray(it.signal_coauthors)
      ? it.signal_coauthors.filter((c): c is string => typeof c === "string" && c.length > 0)
      : [];
    const llmScore =
      typeof it.llm_score === "number" && Number.isFinite(it.llm_score)
        ? Math.trunc(it.llm_score)
        : null;
    // The engine writes method_tier and method_evidence together or not at all,
    // but neither is required here — a tier with no evidence (or the reverse)
    // lands as-is rather than dropping the row.
    const methodTier =
      typeof it.method_tier === "string" &&
      it.method_tier.trim() &&
      it.method_tier.trim().length <= METHOD_TIER_MAX
        ? it.method_tier.trim()
        : null;
    const methodEvidence = evidenceEntries(it.method_evidence, METHOD_EVIDENCE_KEYS);
    const meshEvidence = evidenceEntries(it.mesh_evidence, MESH_EVIDENCE_KEYS);

    writes.push({
      pmid: pmidStr,
      coreId,
      likelihood: new Prisma.Decimal(likelihood),
      status,
      signalCoauthors: coauthors.length ? (coauthors as Prisma.InputJsonValue) : Prisma.JsonNull,
      signalAck: it.signal_ack === true,
      ackAlias: typeof it.ack_alias === "string" && it.ack_alias ? it.ack_alias : null,
      ackSnippet: typeof it.ack_snippet === "string" && it.ack_snippet ? it.ack_snippet : null,
      llmScore,
      llmRationale:
        typeof it.llm_rationale === "string" && it.llm_rationale ? it.llm_rationale : null,
      authorAffinity:
        typeof it.author_affinity === "number" && Number.isFinite(it.author_affinity)
          ? new Prisma.Decimal(it.author_affinity)
          : null,
      topicalPrior:
        typeof it.prefilter_prior === "number" && Number.isFinite(it.prefilter_prior)
          ? new Prisma.Decimal(it.prefilter_prior)
          : null,
      methodTier,
      methodEvidence: methodEvidence.length ? methodEvidence : Prisma.JsonNull,
      meshEvidence: meshEvidence.length ? meshEvidence : Prisma.JsonNull,
      scoredAt: new Date(scoredAtMs),
    });
  }

  return {
    writes,
    skippedMissingCore,
    skippedMissingFields,
    skippedBelowThreshold,
    skippedMissingPublication,
  };
}
