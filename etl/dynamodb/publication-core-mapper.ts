/**
 * etl/dynamodb/index.ts Block 6 (PUB#/CORE# -> publication_core): the pure
 * per-record mapping + FK/field guards, and the batched upsert that writes
 * them. Both live here so the whole records -> writes -> payload -> upsert
 * path is unit-testable without a DynamoDB scan or a database — the same
 * split as ./publication-topic-mapper.ts, plus the projector shape
 * ./grant-opportunity-etl.ts uses.
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
  methodEvidence: Prisma.InputJsonValue | typeof Prisma.JsonNull | typeof Prisma.DbNull;
  meshEvidence: Prisma.InputJsonValue | typeof Prisma.JsonNull | typeof Prisma.DbNull;
  scoredAt: Date;
};

/**
 * The columns BOTH halves of the Block 6 `publicationCore.upsert` write, derived
 * once from a mapped write. `create` adds only the key pair (pmid, coreId) on
 * top of this.
 *
 * It exists because the two halves used to be hand-maintained field lists that
 * could silently drift: every column here is optional in Prisma's generated
 * `PublicationCoreUpdateInput`, so deleting a field from one half alone still
 * typechecked and still passed the whole suite — the write just stopped
 * happening. One object, spread into both halves, makes that drift impossible.
 * Module-private on purpose: `projectPublicationCores` below is the only
 * caller, so no other code path can assemble a partial payload.
 */
function toPubCoreUpsertPayload(w: PubCoreWrite) {
  return {
    likelihood: w.likelihood,
    status: w.status,
    signalCoauthors: w.signalCoauthors,
    signalAck: w.signalAck,
    ackAlias: w.ackAlias,
    ackSnippet: w.ackSnippet,
    llmScore: w.llmScore,
    llmRationale: w.llmRationale,
    authorAffinity: w.authorAffinity,
    topicalPrior: w.topicalPrior,
    methodTier: w.methodTier,
    methodEvidence: w.methodEvidence,
    meshEvidence: w.meshEvidence,
    scoredAt: w.scoredAt,
  };
}

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
  /**
   * Dropped FIELD, not row: `method_tier` arrived longer than the VARCHAR(16)
   * column and was nulled so it could not 1406 the batch. Today's vocabulary is
   * strong|moderate|weak, so this can only fire if the engine renames a tier —
   * which is precisely why it is tallied rather than trusted. Silent, it would
   * surface as an unexplained column of nulls.
   */
  droppedMethodTierTooLong: number;
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
  let droppedMethodTierTooLong = 0;

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
    //
    // An over-long tier is nulled (it would 1406 the whole 100-row batch) AND
    // tallied, like every other drop in this mapper. An absent or non-string
    // tier is simply absent and is not counted.
    const rawMethodTier = typeof it.method_tier === "string" ? it.method_tier.trim() : "";
    let methodTier: string | null = null;
    if (rawMethodTier.length > METHOD_TIER_MAX) {
      droppedMethodTierTooLong += 1;
    } else if (rawMethodTier) {
      methodTier = rawMethodTier;
    }
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
      // DbNull, NOT JsonNull, and deliberately unlike `signalCoauthors` above.
      // `Prisma.JsonNull` writes a JSON scalar null, which PASSES `IS NOT NULL`
      // and reports `JSON_LENGTH` = 1 (see the note on `OrgUnitRole` in
      // prisma/schema.prisma) — so with 0 of 21,481 live CORE# items carrying
      // these attributes, every row would read as "populated" and the operator
      // query this plumbing exists to answer ("is the engine emitting yet?")
      // would be a false green. `signalCoauthors` is always a list the engine
      // DID compute (possibly empty), where present-but-empty is a real
      // finding; these two are genuinely ABSENT. Do not make them consistent.
      methodEvidence: methodEvidence.length ? methodEvidence : Prisma.DbNull,
      meshEvidence: meshEvidence.length ? meshEvidence : Prisma.DbNull,
      scoredAt: new Date(scoredAtMs),
    });
  }

  return {
    writes,
    skippedMissingCore,
    skippedMissingFields,
    skippedBelowThreshold,
    skippedMissingPublication,
    droppedMethodTierTooLong,
  };
}

/**
 * The `db.write` surface the Block 6 projection touches — one upsert, nothing
 * else. Declared structurally rather than as the Prisma client type so a test
 * can hand `projectPublicationCores` a recorder and read back exactly what
 * would have been written; `Prisma.PublicationCoreUnchecked*Input` keeps the
 * call site as strictly typed as the version inlined in index.ts was.
 */
export type PubCoreWriter = {
  publicationCore: {
    upsert(args: {
      where: { pmid_coreId: { pmid: string; coreId: string } };
      create: Prisma.PublicationCoreUncheckedCreateInput;
      update: Prisma.PublicationCoreUncheckedUpdateInput;
    }): Promise<unknown>;
  };
};

/** Upsert fan-out per await — same batch shape as Block 2. */
const PUB_CORE_BATCH = 100;

/**
 * Map the CORE# scan records and write them: records -> writes -> payload ->
 * both halves of the idempotent (pmid, coreId) upsert, in a single call.
 *
 * Block 6 in index.ts is now this call and nothing else, deliberately. While
 * the mapping and the write were separate statements there, every line between
 * them was somewhere a later edit could silently stop a column being written
 * — `for (const cw of coreMap.writes) cw.methodTier = null;` over the write
 * set, or a spread-and-override on the payload — with `tsc` at exit 0 (every
 * column is optional in Prisma's generated update input) and the suite green.
 * Two source-text guards tried to fence that window and only moved its edge.
 * There is no window now: the whole path runs inside one function, so
 * `tests/unit/publication-core-mapper.test.ts` asserts on the arguments the
 * upsert actually receives.
 */
export async function projectPublicationCores(
  records: ReadonlyArray<CoreRecordInput>,
  sets: {
    knownCoreIds: ReadonlySet<string>;
    knownPmidSet: ReadonlySet<string>;
  },
  writer: PubCoreWriter,
  opts: { log?: (msg: string) => void } = {},
): Promise<PublicationCoreMapResult & { upserted: number }> {
  const log = opts.log ?? (() => {});
  const mapped = buildPublicationCoreWrites(records, sets);
  log(
    `publication_core candidates: ${mapped.writes.length} (skipped: ` +
      `${mapped.skippedMissingCore} missing core, ` +
      `${mapped.skippedMissingPublication} missing publication, ` +
      `${mapped.skippedMissingFields} missing required fields, ` +
      `${mapped.skippedBelowThreshold} below threshold; ` +
      `dropped field: ${mapped.droppedMethodTierTooLong} over-long method_tier).`,
  );

  let upserted = 0;
  for (let i = 0; i < mapped.writes.length; i += PUB_CORE_BATCH) {
    const chunk = mapped.writes.slice(i, i + PUB_CORE_BATCH);
    await Promise.all(
      chunk.map((w) => {
        const payload = toPubCoreUpsertPayload(w);
        return writer.publicationCore.upsert({
          where: { pmid_coreId: { pmid: w.pmid, coreId: w.coreId } },
          create: { pmid: w.pmid, coreId: w.coreId, ...payload },
          update: payload,
        });
      }),
    );
    upserted += chunk.length;
  }
  log(`publication_core upserts complete: ${upserted} rows.`);

  return { ...mapped, upserted };
}
