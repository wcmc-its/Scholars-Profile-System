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
import { isEffectiveConfirmed, loadActiveCoreClaimsByCore } from "@/lib/api/core-merge";

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
type CoreReader = Pick<typeof db.read, "core" | "publicationCore" | "coreClaim">;

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

  const publications = selectCorePublications(
    rows.map((r) => ({
      pmid: r.pmid,
      status: r.status,
      title: r.publication.title,
      journal: r.publication.journal,
      year: r.publication.year,
      citationCount: r.publication.citationCount,
      doi: r.publication.doi,
      pubmedUrl: r.publication.pubmedUrl,
    })),
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
  /** True when the core has >=1 engine-confirmed `publication_core` row. Cheap
   *  (one indexed `distinct` scan) and used to hide empty cores from the public
   *  index. NOTE: this is the engine status only — the per-core page applies the
   *  full CoreClaim merge, so its heading count can differ once curators claim or
   *  reject rows. Here it is a presence flag, not a displayed count. */
  hasConfirmedPublications: boolean;
}

/** Every catalog core in numeric-id order, each flagged for whether it has any
 *  engine-confirmed publications. Used by both index surfaces. */
export async function getCoreList(
  client: Pick<typeof db.read, "core" | "publicationCore"> = db.read,
): Promise<CoreListItem[]> {
  const [cores, confirmed] = await Promise.all([
    client.core.findMany({ select: { id: true, name: true, facility: true } }),
    client.publicationCore.findMany({
      where: { status: "confirmed" },
      select: { coreId: true },
      distinct: ["coreId"],
    }),
  ]);
  const hasConfirmed = new Set(confirmed.map((r) => r.coreId));
  return cores
    .map((c) => ({
      id: c.id,
      name: c.name,
      facility: c.facility,
      hasConfirmedPublications: hasConfirmed.has(c.id),
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}
