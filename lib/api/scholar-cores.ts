/**
 * "Cores used" profile-chip data: the WCM core facilities a scholar's
 * publications used, as the read-merge of human `CoreClaim` overrides over the
 * engine-projected `publication_core.status` (see lib/api/core-merge.ts).
 *
 * A (pmid, core) pair counts when its EFFECTIVE status is "confirmed" — either
 * the engine marked it `confirmed` or an owner `claimed` it; a `rejected` claim
 * drops it even if the engine confirmed it. Counts are DISTINCT publications per
 * core.
 *
 * The DB load is a thin wrapper; `groupScholarCores` is pure and unit-tested
 * (same shape as lib/api/core-queue.ts: thin loader + pure partition/group).
 */
import { db } from "@/lib/db";
import type { ClaimStatus } from "@/lib/generated/prisma/client";
import {
  claimKey,
  isEffectiveConfirmed,
  loadActiveCoreClaimsForPmids,
} from "@/lib/api/core-merge";

/** One "Cores used" chip — a core facility + how many of the scholar's
 *  publications confirmed-used it. */
export interface ScholarCoreUsage {
  coreId: string;
  name: string;
  pubCount: number;
}

/** A (pub, core) evidence row reduced to what the grouping needs. */
interface CoreUsageRow {
  pmid: string;
  coreId: string;
  coreName: string;
  /** engine `publication_core.status`. */
  etlStatus: string;
  /** active CoreClaim for the pair, or null. */
  claim: ClaimStatus | null;
}

/**
 * Aggregate effective-confirmed (pub, core) rows into per-core chips, counting
 * DISTINCT publications per core. Pure. Sorted by pubCount desc, then name asc,
 * so the chip order is stable and deterministic.
 */
export function groupScholarCores(rows: ReadonlyArray<CoreUsageRow>): ScholarCoreUsage[] {
  const byCore = new Map<string, { name: string; pmids: Set<string> }>();
  for (const row of rows) {
    if (!isEffectiveConfirmed(row.etlStatus, row.claim)) continue;
    const entry = byCore.get(row.coreId) ?? { name: row.coreName, pmids: new Set<string>() };
    entry.pmids.add(row.pmid);
    byCore.set(row.coreId, entry);
  }
  return [...byCore.entries()]
    .map(([coreId, v]) => ({ coreId, name: v.name, pubCount: v.pmids.size }))
    .sort((a, b) => b.pubCount - a.pubCount || a.name.localeCompare(b.name));
}

/** Minimal read surface so the loader stays injectable for integration tests. */
type CoreReader = Pick<typeof db.read, "publicationCore" | "coreClaim">;

/**
 * The confirmed core usage across a scholar's visible publications. Empty when
 * `pmids` is empty (e.g. the cores lens is off and the caller passes no pmids).
 */
export async function loadScholarConfirmedCores(
  pmids: ReadonlyArray<string>,
  client: CoreReader = db.read,
): Promise<ScholarCoreUsage[]> {
  if (pmids.length === 0) return [];
  const [rows, claims] = await Promise.all([
    client.publicationCore.findMany({
      where: { pmid: { in: [...pmids] } },
      select: { pmid: true, coreId: true, status: true, core: { select: { name: true } } },
    }),
    loadActiveCoreClaimsForPmids(pmids, client),
  ]);
  return groupScholarCores(
    rows.map((r) => ({
      pmid: r.pmid,
      coreId: r.coreId,
      coreName: r.core.name,
      etlStatus: r.status,
      claim: claims.get(claimKey(r.pmid, r.coreId)) ?? null,
    })),
  );
}
