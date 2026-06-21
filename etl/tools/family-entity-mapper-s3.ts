/**
 * #1166 — Methods Surface B specific-entity mapper. Projects the ReciterAI
 * `entities.json` (the entity DIMENSION) + `entity_context.json` (the per-(pub ×
 * entity) FACTS, tools-a2-v4 sidecars) into the `family_entity` + `family_entity_usage`
 * tables, written from the SAME tools artifact fetch as scholar_tool / scholar_family
 * (etl/tools/index.ts) under the same SCHOLAR_TOOL_SOURCE gate.
 *
 * Unlike the scholar mappers, the entity layer is INSTITUTION-WIDE (per method
 * family), not per-scholar — so there is no cwid scope. Two gates still apply:
 *   - ADR-005 publication suppression: a (pub × entity) FACT whose pmid is a whole-
 *     publication takedown (`darkPmids`) is dropped, so a dark paper's sentence never
 *     resurfaces on the public Method page. (`hiddenAuthorsByPmid` is per-(pmid, cwid)
 *     and does NOT apply — an entity fact is not attributed to a scholar.)
 *   - `evidenced` is RECOMPUTED here: an entity whose only facts were all suppressed
 *     is no longer evidenced (so SPS renders it as a plain label, not clickable).
 * Family-level relevance/sensitivity overlays (#800/#801) are applied at READ time
 * (lib/api/methods-overlay.ts), exactly as for the tool-usage strip — not here.
 *
 * `usage_count` is taken verbatim from the artifact (institution-wide distinct
 * pub_count); it is intentionally NOT recomputed from surviving facts, which are a
 * subset (only pmids that have a usable sentence, minus suppressed ones).
 *
 * Pure + side-effect-free (no I/O, no DB) — the loader fetches + verifies the bytes
 * and owns the write; this module only shapes rows, so the projection is unit-testable
 * without S3 or a DB (the sibling-mapper discipline).
 */
import type { PublicationSuppressions } from "@/lib/api/manual-layer";

// --- raw artifact shapes (entities.json / entity_context.json, tools-a2-v4) ---

/** One record in `entities.json` `entities[]` — the entity DIMENSION. */
export type RawFamilyEntity = {
  normalized_entity_id?: unknown;
  entity_label?: unknown;
  supercategory?: unknown;
  family_label?: unknown;
  parent_entity_id?: unknown;
  parent_label?: unknown;
  parent_descriptor?: unknown;
  entity_role?: unknown;
  usage_count?: unknown;
  evidenced?: unknown;
};

/** One usage fact in `entity_context.json` (`entity_id → pmid → RawUsage[]`). */
export type RawUsage = {
  usage_sentence?: unknown;
  span?: unknown; // [start, end] | null
  centrality_score?: unknown;
  role?: unknown;
};
export type RawEntityContext = Record<string, Record<string, RawUsage[]>>;

export type FamilyEntityArtifact = {
  entities: RawFamilyEntity[];
  entityContext: RawEntityContext;
};

// --- write shapes (one per table row; the loader maps these to Prisma create data) ---

export type FamilyEntityWrite = {
  supercategory: string;
  familyLabel: string;
  normalizedEntityId: string;
  entityLabel: string;
  parentEntityId: string | null;
  parentLabel: string | null;
  parentDescriptor: string | null;
  entityRole: string | null;
  usageCount: number;
  evidenced: boolean;
};

export type FamilyEntityUsageWrite = {
  supercategory: string;
  familyLabel: string;
  normalizedEntityId: string;
  pmid: string;
  usageSentence: string;
  matchedSpanStart: number | null;
  matchedSpanEnd: number | null;
  centralityScore: number | null;
  entityRole: string | null;
};

export type BuildFamilyEntityS3Result = {
  entityWrites: FamilyEntityWrite[];
  usageWrites: FamilyEntityUsageWrite[];
  /** Entity records dropped for a missing required field (id/label/family/count). */
  skippedMalformedEntities: number;
  /** Usage facts dropped because their pmid is an ADR-005 whole-pub takedown. */
  suppressedFacts: number;
  /** Usage facts dropped because no entity DIMENSION record matched their id. */
  orphanFacts: number;
  /** Entities re-marked NOT evidenced because every fact was suppressed/absent. */
  evidencedEntities: number;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** A clamped, finite span pair, or null. Guards against malformed offsets. */
function spanPair(v: unknown, sentenceLen: number): [number | null, number | null] {
  if (!Array.isArray(v) || v.length !== 2) return [null, null];
  const [a, b] = v;
  if (typeof a !== "number" || typeof b !== "number") return [null, null];
  if (!Number.isInteger(a) || !Number.isInteger(b)) return [null, null];
  if (a < 0 || b <= a || b > sentenceLen) return [null, null]; // out-of-range -> term-match fallback
  return [a, b];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Project the entity artifact into table rows. Drops suppressed facts (ADR-005),
 * recomputes `evidenced` against the surviving facts, and skips malformed entity
 * records (logged via the returned counters, never thrown).
 */
export function buildFamilyEntityWritesFromS3(
  artifact: FamilyEntityArtifact,
  opts: { suppression?: PublicationSuppressions } = {},
): BuildFamilyEntityS3Result {
  const darkPmids = opts.suppression?.darkPmids;

  // Index the DIMENSION by entity id so facts can resolve their (supercat, family).
  const entityById = new Map<string, { supercategory: string; familyLabel: string }>();
  for (const e of artifact.entities ?? []) {
    const id = str(e.normalized_entity_id);
    const supercategory = str(e.supercategory);
    const familyLabel = str(e.family_label);
    if (id && supercategory && familyLabel) {
      entityById.set(id, { supercategory, familyLabel });
    }
  }

  // FACTS first — so `evidenced` can be recomputed against the survivors.
  const usageWrites: FamilyEntityUsageWrite[] = [];
  const evidencedIds = new Set<string>();
  let suppressedFacts = 0;
  let orphanFacts = 0;
  for (const [entityId, byPmid] of Object.entries(artifact.entityContext ?? {})) {
    const dim = entityById.get(entityId);
    if (!dim) {
      orphanFacts += Object.values(byPmid ?? {}).reduce((n, list) => n + (list?.length ?? 0), 0);
      continue;
    }
    for (const [pmidRaw, usages] of Object.entries(byPmid ?? {})) {
      const pmid = str(pmidRaw);
      if (!pmid) continue;
      if (darkPmids?.has(pmid)) {
        suppressedFacts += usages?.length ?? 0;
        continue;
      }
      for (const u of usages ?? []) {
        const sentence = str(u.usage_sentence);
        if (!sentence) continue;
        const [start, end] = spanPair(u.span, sentence.length);
        usageWrites.push({
          supercategory: dim.supercategory,
          familyLabel: dim.familyLabel,
          normalizedEntityId: entityId,
          pmid,
          usageSentence: sentence,
          matchedSpanStart: start,
          matchedSpanEnd: end,
          centralityScore: num(u.centrality_score),
          entityRole: str(u.role) || null,
        });
        evidencedIds.add(entityId);
      }
    }
  }

  // DIMENSION — recompute `evidenced` from the surviving facts.
  const entityWrites: FamilyEntityWrite[] = [];
  let skippedMalformedEntities = 0;
  for (const e of artifact.entities ?? []) {
    const normalizedEntityId = str(e.normalized_entity_id);
    const entityLabel = str(e.entity_label);
    const supercategory = str(e.supercategory);
    const familyLabel = str(e.family_label);
    const usageCount = typeof e.usage_count === "number" && Number.isFinite(e.usage_count)
      ? Math.max(0, Math.trunc(e.usage_count))
      : null;
    if (!normalizedEntityId || !entityLabel || !supercategory || !familyLabel || usageCount === null) {
      skippedMalformedEntities += 1;
      continue;
    }
    entityWrites.push({
      supercategory,
      familyLabel,
      normalizedEntityId,
      entityLabel,
      parentEntityId: str(e.parent_entity_id) || null,
      parentLabel: str(e.parent_label) || null,
      parentDescriptor: str(e.parent_descriptor) || null,
      entityRole: str(e.entity_role) || null,
      usageCount,
      evidenced: evidencedIds.has(normalizedEntityId),
    });
  }

  return {
    entityWrites,
    usageWrites,
    skippedMalformedEntities,
    suppressedFacts,
    orphanFacts,
    evidencedEntities: evidencedIds.size,
  };
}
