/**
 * Public per-core page data (`/cores/[coreId]`): the catalog facility + the
 * publications that confirmed-used it. "Confirmed" is the read-merge of human
 * `CoreClaim` over the engine `publication_core.status` (lib/api/core-merge.ts) —
 * engine `confirmed` OR human `claimed`, minus any `rejected` claim.
 *
 * PUBLIC fields only — deliberately NOT the owner review queue's evidence
 * (lib/api/core-queue.ts carries LLM scores, ack snippets, co-author CWIDs), which
 * must never reach a public surface. The DB load is a thin wrapper;
 * `selectCorePublications` is pure and unit-tested.
 */
import { db } from "@/lib/db";
import type { ClaimStatus } from "@/lib/generated/prisma/client";
import {
  claimKey,
  effectiveCoreStatus,
  isEffectiveConfirmed,
  loadActiveCoreClaimsByCore,
} from "@/lib/api/core-merge";

/** One confirmed publication on a core's public page (public scalar fields only,
 *  shaped to feed `<PublicationCard>` with no author chips). */
export interface CorePublication {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  citationCount: number;
  doi: string | null;
  pubmedUrl: string | null;
}

/** A public per-core page: the catalog facility + its confirmed publications. */
export interface CorePageData {
  core: { id: string; name: string; facility: string | null };
  publications: CorePublication[];
}

/** A (pub, core) row plus the engine status, the input to the pure selection. */
interface CorePubRow extends CorePublication {
  /** engine `publication_core.status`. */
  status: string;
}

/**
 * Keep only the effective-confirmed publications and order them (year desc, then
 * pmid desc). Pure — `claimFor` resolves the active claim (or null) for a pmid.
 */
export function selectCorePublications(
  rows: ReadonlyArray<CorePubRow>,
  claimFor: (pmid: string) => ClaimStatus | null,
): CorePublication[] {
  return rows
    .filter((r) => isEffectiveConfirmed(r.status, claimFor(r.pmid)))
    .map((r) => ({
      pmid: r.pmid,
      title: r.title,
      journal: r.journal,
      year: r.year,
      citationCount: r.citationCount,
      doi: r.doi,
      pubmedUrl: r.pubmedUrl,
    }))
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.pmid.localeCompare(a.pmid));
}

/** Minimal read surface so the loader stays injectable for integration tests. */
type CoreReader = Pick<typeof db.read, "core" | "publicationCore" | "coreClaim" | "publication">;

/**
 * Public per-core page data, or `null` when the core id is unknown. A core that
 * exists in the catalog but has no confirmed publications yet returns an empty
 * `publications` array (the page renders the facility header + an empty state).
 */
export async function getCorePage(
  coreId: string,
  client: CoreReader = db.read,
): Promise<CorePageData | null> {
  const core = await client.core.findUnique({
    where: { id: coreId },
    select: { id: true, name: true, facility: true },
  });
  if (!core) return null;

  const [rows, claims] = await Promise.all([
    client.publicationCore.findMany({
      where: { coreId },
      select: {
        pmid: true,
        status: true,
        publication: {
          select: {
            title: true,
            journal: true,
            year: true,
            citationCount: true,
            doi: true,
            pubmedUrl: true,
          },
        },
      },
    }),
    loadActiveCoreClaimsByCore(coreId, client),
  ]);

  // Manual PMID add: a CLAIMED core_claim with no matching publication_core row —
  // a human attesting usage the engine never scored. selectCorePublications
  // already resolves it to effective-confirmed via `claims`; it just needs a row
  // to filter, joined straight to `publication` (the engine never projected one).
  const projectedPmids = new Set(rows.map((r) => r.pmid));
  const manualPmids = [...claims.entries()]
    .filter(([pmid, status]) => status === "claimed" && !projectedPmids.has(pmid))
    .map(([pmid]) => pmid);
  const manualPubs =
    manualPmids.length === 0
      ? []
      : await client.publication.findMany({
          where: { pmid: { in: manualPmids } },
          select: { pmid: true, title: true, journal: true, year: true, citationCount: true, doi: true, pubmedUrl: true },
        });

  const publications = selectCorePublications(
    [
      ...rows.map((r) => ({
        pmid: r.pmid,
        status: r.status,
        title: r.publication.title,
        journal: r.publication.journal,
        year: r.publication.year,
        citationCount: r.publication.citationCount,
        doi: r.publication.doi,
        pubmedUrl: r.publication.pubmedUrl,
      })),
      // status is a placeholder — selectCorePublications resolves purely off the
      // active claim (effectiveCoreStatus short-circuits before reading it).
      ...manualPubs.map((p) => ({ ...p, status: "confirmed" })),
    ],
    (pmid) => claims.get(pmid) ?? null,
  );

  return {
    core: { id: core.id, name: core.name, facility: core.facility },
    publications,
  };
}

/** A catalog core for the index surfaces (`/cores`, `/edit/core`). */
export interface CoreListItem {
  id: string;
  name: string;
  facility: string | null;
  /** True when the core has >=1 effective-confirmed publication — the same
   *  CoreClaim merge the per-core page applies (engine `confirmed` minus any
   *  human rejection, plus any human `claimed` override, including
   *  manual-PMID-add pairs the engine never scored). Used to hide empty cores
   *  from the public index. A presence flag, not a displayed count. */
  hasConfirmedPublications: boolean;
}

/** Every catalog core in numeric-id order, each flagged for whether it has any
 *  effective-confirmed publications (full CoreClaim merge). Used by both index
 *  surfaces. */
export async function getCoreList(
  client: Pick<typeof db.read, "core" | "publicationCore" | "coreClaim"> = db.read,
): Promise<CoreListItem[]> {
  const [cores, confirmedPairs, activeClaims] = await Promise.all([
    client.core.findMany({ select: { id: true, name: true, facility: true } }),
    client.publicationCore.findMany({
      where: { status: "confirmed" },
      select: { coreId: true, pmid: true },
    }),
    client.coreClaim.findMany({
      where: { revokedAt: null },
      select: { coreId: true, pmid: true, status: true },
    }),
  ]);

  const claimByKey = new Map(activeClaims.map((c) => [claimKey(c.pmid, c.coreId), c.status]));

  const present = new Set<string>();
  for (const pair of confirmedPairs) {
    const claim = claimByKey.get(claimKey(pair.pmid, pair.coreId)) ?? null;
    if (effectiveCoreStatus("confirmed", claim) === "confirmed") {
      present.add(pair.coreId);
    }
  }
  // Manual-claim-only pairs (and below_threshold rows a human promoted): the
  // engine row may not exist or say "confirmed" at all, but an active
  // `claimed` override is effective-confirmed regardless of engine status.
  for (const claim of activeClaims) {
    if (claim.status === "claimed") {
      present.add(claim.coreId);
    }
  }

  return cores
    .map((c) => ({
      id: c.id,
      name: c.name,
      facility: c.facility,
      hasConfirmedPublications: present.has(c.id),
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** The read surface `loadConfirmedCorePmidsByCore` needs — the two tables the
 *  CoreClaim merge reads, nothing else. The client is REQUIRED (no `db.read`
 *  default, unlike the loaders above) so the `/edit/reports` suite can call it
 *  with its own injected client and stay testable without a live DB. */
type CoreConfirmedReader = Pick<typeof db.read, "publicationCore" | "coreClaim">;

/**
 * The effective-CONFIRMED pmids for each of `coreIds` — one batched pair of
 * queries no matter how many cores are asked about.
 *
 * "Confirmed" is the SAME read-merge `getCorePage` / `getCoreList` apply and
 * nothing else: the engine `publication_core.status` with an ACTIVE
 * (`revokedAt IS NULL`) `CoreClaim` layered over it through
 * `isEffectiveConfirmed` — engine `confirmed` MINUS any human `rejected`
 * claim, PLUS every human `claimed` override. That second set is why the
 * `activeClaims` pass below exists: a `claimed` override is effective-confirmed
 * regardless of engine status, including a "Manual PMID add" the engine never
 * scored (no `publication_core` row exists to iterate). An engine `candidate`
 * or `below_threshold` row with no claim is NOT confirmed. The status strings
 * are never re-derived here — `lib/api/core-merge.ts` owns them.
 *
 * The engine read is FILTERED to `status: "confirmed"` — the
 * `@@index([coreId, status])` shape `getCoreList` already uses — rather than
 * reading every row for these cores and discarding the rest in JS.
 * `publication_core` is dominated by `below_threshold` and `candidate` rows,
 * and `/edit/reports` calls this with EVERY core id on each `force-dynamic`
 * render, so the unfiltered read was close to a full-table scan per page load.
 * The filter is set-equivalent, not an approximation: the only non-`confirmed`
 * engine row the merge loop below ever kept is one carrying an active
 * `claimed` claim, and the `activeClaims` pass re-adds exactly those — it has
 * to, since a `claimed` override can exist with no `publication_core` row at
 * all. The `isEffectiveConfirmed` call stays, because it is what still drops
 * an engine-`confirmed` row an active `rejected` claim has overridden.
 *
 * Every requested core id is a key in the returned map, `[]` when it has no
 * confirmed usages, so a caller never has to tell "unknown core" apart from
 * "no rows" by a missing key.
 */
export async function loadConfirmedCorePmidsByCore(
  coreIds: readonly string[],
  client: CoreConfirmedReader,
): Promise<Map<string, string[]>> {
  if (coreIds.length === 0) return new Map();
  const byCore = new Map<string, Set<string>>(coreIds.map((id) => [id, new Set<string>()]));

  const [rows, activeClaims] = await Promise.all([
    client.publicationCore.findMany({
      where: { coreId: { in: [...coreIds] }, status: "confirmed" },
      select: { coreId: true, pmid: true, status: true },
    }),
    client.coreClaim.findMany({
      where: { coreId: { in: [...coreIds] }, revokedAt: null },
      select: { coreId: true, pmid: true, status: true },
    }),
  ]);

  const claimByKey = new Map(activeClaims.map((c) => [claimKey(c.pmid, c.coreId), c.status]));
  for (const r of rows) {
    if (!isEffectiveConfirmed(r.status, claimByKey.get(claimKey(r.pmid, r.coreId)) ?? null)) continue;
    byCore.get(r.coreId)?.add(r.pmid);
  }
  // Manual-claim-only pairs — see the doc comment. Re-adding a pmid the loop
  // above already kept is a no-op (Set).
  for (const c of activeClaims) {
    if (c.status === "claimed") byCore.get(c.coreId)?.add(c.pmid);
  }

  return new Map([...byCore].map(([coreId, pmids]) => [coreId, [...pmids]]));
}
