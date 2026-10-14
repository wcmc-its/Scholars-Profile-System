/**
 * etl/dynamodb/index.ts Block 10 (AREASIGNAL# -> area_signal_text +
 * area_signal_topic): the pure mapping with its FK/field guards, the prune plan,
 * and the writer that applies both. Pure parts are unit-tested without a scan
 * or a database (tests/unit/area-signal-mapper.test.ts), the same split as
 * ./publication-core-mapper.ts.
 *
 * ReciterAI's `pipeline_area_signals` scores grant and trial TEXTS that
 * etl/area-signal-inputs queued, and writes one item per text:
 *
 *   PK = `AREASIGNAL#{kind}:{text_key}`   kind = grant | trial
 *   SK = `META`
 *   synopsis, synopsis_model, topic_scores [{topic_id, score}], taxonomy_version,
 *   input_hash, scored_at, scorer_fallback_model
 *
 * `topic_scores` holds every dense score >= 0.3 across all areas, excluded ones
 * included; the FK guard against `topic` drops unpublished areas the same way
 * publication_topic does, and the six-area grant exclusion is the ranking's.
 */
import { Prisma } from "@/lib/generated/prisma/client";
import type { AreaSignalRecord } from "./partition";
import { replaceFloor } from "./projection-replace";

export const AREA_SIGNAL_PK_PREFIX = "AREASIGNAL#";
const PK_SHAPE = /^AREASIGNAL#(grant|trial):([A-Za-z0-9]{8,64})$/;

export type AreaSignalTextWrite = {
  textKey: string;
  kind: "grant" | "trial";
  synopsis: string | null;
  synopsisModel: string | null;
  taxonomyVersion: string | null;
  scoredAt: Date | null;
};

export type AreaSignalTopicWrite = {
  textKey: string;
  parentTopicId: string;
  score: Prisma.Decimal;
};

export type AreaSignalMap = {
  texts: AreaSignalTextWrite[];
  topics: AreaSignalTopicWrite[];
  skippedBadKey: number;
  skippedUnknownTopic: number;
  skippedBadScore: number;
};

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : null;

function date(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Map scanned AREASIGNAL# items to rows. A malformed key or a non-META SK drops
 * the item; an unknown topic or a non-numeric score drops only that score. A
 * text with no surviving score still lands (it was scored and fits no
 * published area), so the prune does not mistake it for a vanished one.
 */
export function buildAreaSignalWrites(
  records: readonly AreaSignalRecord[],
  knownTopicIds: ReadonlySet<string>,
): AreaSignalMap {
  const out: AreaSignalMap = {
    texts: [],
    topics: [],
    skippedBadKey: 0,
    skippedUnknownTopic: 0,
    skippedBadScore: 0,
  };
  const seen = new Set<string>();
  for (const r of records) {
    const m = PK_SHAPE.exec(String(r.PK ?? ""));
    if (!m || (r.SK ?? "META") !== "META") {
      out.skippedBadKey += 1;
      continue;
    }
    const kind = m[1] as "grant" | "trial";
    const textKey = m[2];
    if (seen.has(textKey)) continue;
    seen.add(textKey);
    out.texts.push({
      textKey,
      kind,
      synopsis: str(r.synopsis, 2000),
      synopsisModel: str(r.synopsis_model, 128),
      taxonomyVersion: str(r.taxonomy_version, 64),
      scoredAt: date(r.scored_at),
    });
    const best = new Map<string, number>();
    for (const s of Array.isArray(r.topic_scores) ? r.topic_scores : []) {
      const topicId = typeof s?.topic_id === "string" ? s.topic_id : null;
      const score = typeof s?.score === "number" ? s.score : Number(s?.score);
      if (!topicId || !Number.isFinite(score) || score < 0 || score > 1) {
        out.skippedBadScore += 1;
        continue;
      }
      if (!knownTopicIds.has(topicId)) {
        out.skippedUnknownTopic += 1;
        continue;
      }
      best.set(topicId, Math.max(best.get(topicId) ?? 0, score));
    }
    for (const [parentTopicId, score] of best) {
      out.topics.push({ textKey, parentTopicId, score: new Prisma.Decimal(score.toFixed(4)) });
    }
  }
  return out;
}

export type AreaSignalPrunePlan =
  | { prune: false; reason: string; stale: readonly string[] }
  | { prune: true; stale: string[] };

/**
 * The populated-guard. Texts held in `area_signal_text` that this scan did not
 * return are deleted (their topics cascade), but only when this run's write set
 * clears the guardedReplace floor for the live table: an empty or truncated
 * scan, or a producer that stopped publishing, can never wipe the tables.
 */
export function planAreaSignalPrune(
  writeKeys: readonly string[],
  existingKeys: readonly string[],
): AreaSignalPrunePlan {
  const floor = replaceFloor(existingKeys.length);
  if (writeKeys.length < floor) {
    return {
      prune: false,
      reason: `incoming ${writeKeys.length} texts below floor ${floor} (live ${existingKeys.length})`,
      stale: [],
    };
  }
  const keep = new Set(writeKeys);
  return { prune: true, stale: existingKeys.filter((k) => !keep.has(k)) };
}

/** The Prisma surface the writer uses; a recording fake drives it in tests. */
export type AreaSignalWriter = {
  areaSignalText: {
    findMany(args: { select: { textKey: true } }): Promise<{ textKey: string }[]>;
    upsert(args: {
      where: { textKey: string };
      create: Omit<AreaSignalTextWrite, never> & { refreshedAt: Date };
      update: Omit<AreaSignalTextWrite, "textKey" | "kind"> & { kind: string; refreshedAt: Date };
    }): Promise<unknown>;
    deleteMany(args: { where: { textKey: { in: string[] } } }): Promise<{ count: number }>;
  };
  areaSignalTopic: {
    deleteMany(args: { where: { textKey: { in: string[] } } }): Promise<{ count: number }>;
    createMany(args: { data: AreaSignalTopicWrite[]; skipDuplicates?: boolean }): Promise<{
      count: number;
    }>;
  };
  $transaction<T>(fn: (tx: AreaSignalWriter) => Promise<T>): Promise<T>;
};

export type AreaSignalProjection = {
  texts: number;
  topics: number;
  pruned: number;
  pruneSkipped: string | null;
};

const BATCH = 200;

/**
 * Upsert every text, replace each text's topic rows (delete + create per batch
 * of keys, one transaction per batch so a reader never sees a text with half
 * its areas), then the guarded keyed prune.
 */
export async function projectAreaSignals(
  map: AreaSignalMap,
  client: AreaSignalWriter,
  now: Date = new Date(),
): Promise<AreaSignalProjection> {
  for (const t of map.texts) {
    const { textKey, ...rest } = t;
    await client.areaSignalText.upsert({
      where: { textKey },
      create: { ...t, refreshedAt: now },
      update: { ...rest, refreshedAt: now },
    });
  }
  const topicsByKey = new Map<string, AreaSignalTopicWrite[]>();
  for (const w of map.topics) topicsByKey.set(w.textKey, [...(topicsByKey.get(w.textKey) ?? []), w]);
  const keys = map.texts.map((t) => t.textKey);
  let topics = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const data = batch.flatMap((k) => topicsByKey.get(k) ?? []);
    topics += await client.$transaction(async (tx) => {
      await tx.areaSignalTopic.deleteMany({ where: { textKey: { in: batch } } });
      if (data.length === 0) return 0;
      return (await tx.areaSignalTopic.createMany({ data, skipDuplicates: true })).count;
    });
  }

  const existing = (await client.areaSignalText.findMany({ select: { textKey: true } })).map(
    (r) => r.textKey,
  );
  const plan = planAreaSignalPrune(keys, existing);
  let pruned = 0;
  if (plan.prune) {
    for (let i = 0; i < plan.stale.length; i += BATCH) {
      const res = await client.areaSignalText.deleteMany({
        where: { textKey: { in: plan.stale.slice(i, i + BATCH) } },
      });
      pruned += res.count;
    }
  }
  return {
    texts: map.texts.length,
    topics,
    pruned,
    pruneSkipped: plan.prune ? null : plan.reason,
  };
}
