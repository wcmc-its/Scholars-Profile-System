/**
 * Per-core review queue data (the owner surface at /edit/core/[coreId]).
 *
 * Loads the engine's projected `publication_core` rows for one core, joins each
 * to its publication, and partitions them by EFFECTIVE status (the CoreClaim
 * override read-merged over the engine status, see lib/api/core-merge.ts):
 *   - `candidates` — open engine candidates with no active claim, the review work
 *   - `confirmed`  — effective-confirmed (engine `confirmed` OR human `claimed`)
 * A rejected pair drops out of both lists. Both are ranked by likelihood desc.
 *
 * The DB load is a thin wrapper; `partitionCoreQueue` is pure and unit-tested.
 */
import { db } from "@/lib/db";
import type { ClaimStatus } from "@/lib/generated/prisma/client";
import {
  effectiveCoreStatus,
  isOpenCandidate,
  loadActiveCoreClaimsByCore,
} from "@/lib/api/core-merge";

/** One row in the review queue — a publication + its core-usage evidence. */
export interface CoreQueueRow {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  authorsString: string | null;
  /** 0-1 combined-signal likelihood. */
  likelihood: number;
  /** The engine status (candidate | confirmed | below_threshold). */
  status: string;
  /** Core-staff CWIDs on the byline (signal 2). */
  coauthors: string[];
  /** True when a core alias matched in the full text (signal 3). */
  signalAck: boolean;
  /** Matched full-text alias, e.g. "CBIC" (signal 3). */
  ackAlias: string | null;
  ackSnippet: string | null;
  /** 1-10 dense LLM triage score (signal 4). */
  llmScore: number | null;
  /** Plain-language LLM reason for the score (signal 4). */
  llmRationale: string | null;
  /** 0-1 repeat-user prior (signal 1); null when never computed. */
  authorAffinity: number | null;
  /** Scopus citation count for the publication. */
  citationCount: number;
  pubmedUrl: string | null;
  doi: string | null;
}

export interface CoreReviewQueue {
  core: { id: string; name: string };
  candidates: CoreQueueRow[];
  confirmed: CoreQueueRow[];
}

/**
 * Partition queue rows into open candidates vs effective-confirmed, applying the
 * CoreClaim override. Pure — `claimFor` resolves the active claim (or null) for a
 * pmid. Input order is preserved (the caller ranks by likelihood).
 */
export function partitionCoreQueue(
  rows: ReadonlyArray<CoreQueueRow>,
  claimFor: (pmid: string) => ClaimStatus | null,
): { candidates: CoreQueueRow[]; confirmed: CoreQueueRow[] } {
  const candidates: CoreQueueRow[] = [];
  const confirmed: CoreQueueRow[] = [];
  for (const row of rows) {
    const claim = claimFor(row.pmid);
    if (isOpenCandidate(row.status, claim)) candidates.push(row);
    else if (effectiveCoreStatus(row.status, claim) === "confirmed") confirmed.push(row);
    // an active 'rejected' claim excludes the pair from both lists
  }
  return { candidates, confirmed };
}

type QueueReader = Pick<typeof db.read, "core" | "publicationCore" | "coreClaim">;

/**
 * Load the review queue for one core, or `null` when the core does not exist.
 * Rows are FK-joined to their publication and ranked by likelihood descending;
 * `partitionCoreQueue` then splits them by effective status.
 */
export async function loadCoreReviewQueue(
  coreId: string,
  client: QueueReader = db.read,
): Promise<CoreReviewQueue | null> {
  const core = await client.core.findUnique({
    where: { id: coreId },
    select: { id: true, name: true },
  });
  if (!core) return null;

  const rows = await client.publicationCore.findMany({
    where: { coreId },
    orderBy: { likelihood: "desc" },
    select: {
      pmid: true,
      likelihood: true,
      status: true,
      signalCoauthors: true,
      signalAck: true,
      ackAlias: true,
      ackSnippet: true,
      llmScore: true,
      llmRationale: true,
      authorAffinity: true,
      publication: {
        select: {
          title: true,
          journal: true,
          year: true,
          authorsString: true,
          citationCount: true,
          pubmedUrl: true,
          doi: true,
        },
      },
    },
  });

  const queueRows: CoreQueueRow[] = rows.map((r) => ({
    pmid: r.pmid,
    title: r.publication.title,
    journal: r.publication.journal,
    year: r.publication.year,
    authorsString: r.publication.authorsString,
    likelihood: Number(r.likelihood),
    status: r.status,
    coauthors: Array.isArray(r.signalCoauthors)
      ? (r.signalCoauthors as unknown[]).filter((c): c is string => typeof c === "string")
      : [],
    signalAck: r.signalAck,
    ackAlias: r.ackAlias,
    ackSnippet: r.ackSnippet,
    llmScore: r.llmScore,
    llmRationale: r.llmRationale,
    // authorAffinity is a nullable Decimal — Number(null) is 0, so guard the null.
    authorAffinity: r.authorAffinity == null ? null : Number(r.authorAffinity),
    citationCount: r.publication.citationCount,
    pubmedUrl: r.publication.pubmedUrl,
    doi: r.publication.doi,
  }));

  const claims = await loadActiveCoreClaimsByCore(coreId, client);
  const { candidates, confirmed } = partitionCoreQueue(queueRows, (pmid) => claims.get(pmid) ?? null);
  return { core, candidates, confirmed };
}
