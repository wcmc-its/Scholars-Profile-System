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

/** A WCM scholar resolved from a CWID, linkable to their public profile. */
export interface QueueScholar {
  cwid: string;
  name: string;
  slug: string;
  /** Primary department, when known (core staff may have none). */
  dept: string | null;
}

/** One row in the review queue — a publication + its core-usage evidence. */
export interface CoreQueueRow {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  authorsString: string | null;
  /** Full author list (the truncated `authorsString` drops the tail). */
  fullAuthorsString: string | null;
  /** 0-1 combined-signal likelihood. */
  likelihood: number;
  /** The engine status (candidate | confirmed | below_threshold). */
  status: string;
  /** Core-staff CWIDs on the byline (signal 2). */
  coauthors: string[];
  /** Core-staff co-authors (signal 2) resolved to named scholars; a subset of
   *  `coauthors` — CWIDs with no Scholar row stay only in `coauthors`. */
  coauthorScholars: QueueScholar[];
  /** WCM scholars on the byline (potential core users), in author order. */
  wcmAuthors: QueueScholar[];
  /** Raw PubMed abstract, shown collapsed behind an expander. */
  abstract: string | null;
  /** One-line plain-language synopsis (issue #329), when present. */
  synopsis: string | null;
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
  /** True when an active human claim (not just the engine) backs a confirmed row;
   *  set by partitionCoreQueue. Drives the Confirmed-list revoke vs reject path. */
  claimed: boolean;
  /** iCite relative citation ratio (reciterdb.analysis_nih), when computed. */
  relativeCitationRatio: number | null;
  /** NIH citation percentile (0-100), when computed. */
  nihPercentile: number | null;
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
    if (isOpenCandidate(row.status, claim)) candidates.push({ ...row, claimed: false });
    else if (effectiveCoreStatus(row.status, claim) === "confirmed")
      confirmed.push({ ...row, claimed: claim === "claimed" });
    // an active 'rejected' claim excludes the pair from both lists
  }
  return { candidates, confirmed };
}

type QueueReader = Pick<
  typeof db.read,
  "core" | "publicationCore" | "coreClaim" | "scholar" | "publicationAuthor"
>;

/** Cap WCM byline authors per card — mega-author papers would otherwise be a wall. */
const WCM_AUTHORS_CAP = 12;

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
          fullAuthorsString: true,
          abstract: true,
          synopsis: true,
          citationCount: true,
          pubmedUrl: true,
          doi: true,
          relativeCitationRatio: true,
          nihPercentile: true,
        },
      },
    },
  });

  // --- batched name resolution (one query each, not per row) ---
  const coStaffCwids = new Set<string>();
  for (const r of rows) {
    if (Array.isArray(r.signalCoauthors)) {
      for (const c of r.signalCoauthors) if (typeof c === "string") coStaffCwids.add(c);
    }
  }
  const pmids = rows.map((r) => r.pmid);

  // Core-staff co-authors (signal-2 CWIDs) → named scholars. CWIDs with no
  // Scholar row simply don't appear here (the component falls back to the CWID).
  // CWIDs are compared case-insensitively across the app (auth/*, proxy-notification,
  // ldap); the engine's signalCoauthors casing can differ from scholar.cwid, so key by
  // lowercase and query both forms. Names also come from the byline join below — a
  // core-staff co-author IS a byline author, so the name is present even when the
  // direct scholar lookup misses.
  const scholarByCwidLc = new Map<string, QueueScholar>();
  const putScholar = (s: QueueScholar) => {
    const key = s.cwid.toLowerCase();
    if (!scholarByCwidLc.has(key)) scholarByCwidLc.set(key, s);
  };
  if (coStaffCwids.size > 0) {
    const lowered = [...coStaffCwids].map((c) => c.toLowerCase());
    const scholars = await client.scholar.findMany({
      where: { cwid: { in: [...coStaffCwids, ...lowered] } },
      select: { cwid: true, preferredName: true, slug: true, primaryDepartment: true },
    });
    for (const s of scholars)
      putScholar({ cwid: s.cwid, name: s.preferredName, slug: s.slug, dept: s.primaryDepartment });
  }

  // WCM scholars on each paper's byline (potential core users), in author order.
  const wcmByPmid = new Map<string, QueueScholar[]>();
  if (pmids.length > 0) {
    const authors = await client.publicationAuthor.findMany({
      where: { pmid: { in: pmids }, cwid: { not: null }, isConfirmed: true },
      orderBy: { position: "asc" },
      select: {
        pmid: true,
        cwid: true,
        scholar: { select: { preferredName: true, slug: true, primaryDepartment: true } },
      },
    });
    for (const a of authors) {
      if (!a.cwid || !a.scholar) continue;
      const scholar: QueueScholar = {
        cwid: a.cwid,
        name: a.scholar.preferredName,
        slug: a.scholar.slug,
        dept: a.scholar.primaryDepartment,
      };
      // byline authors also resolve core-staff co-author CWIDs (case-insensitively)
      putScholar(scholar);
      const list = wcmByPmid.get(a.pmid) ?? [];
      if (list.length >= WCM_AUTHORS_CAP || list.some((w) => w.cwid === a.cwid)) continue;
      list.push(scholar);
      wcmByPmid.set(a.pmid, list);
    }
  }

  const queueRows: CoreQueueRow[] = rows.map((r) => {
    const coauthors = Array.isArray(r.signalCoauthors)
      ? (r.signalCoauthors as unknown[])
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.toLowerCase())
      : [];
    return {
      pmid: r.pmid,
      title: r.publication.title,
      journal: r.publication.journal,
      year: r.publication.year,
      authorsString: r.publication.authorsString,
      fullAuthorsString: r.publication.fullAuthorsString,
      abstract: r.publication.abstract,
      synopsis: r.publication.synopsis,
      likelihood: Number(r.likelihood),
      status: r.status,
      coauthors,
      coauthorScholars: coauthors
        .map((c) => scholarByCwidLc.get(c))
        .filter((s): s is QueueScholar => s !== undefined),
      wcmAuthors: wcmByPmid.get(r.pmid) ?? [],
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
      // claimed is resolved per-row in partitionCoreQueue once claims are known.
      claimed: false,
      relativeCitationRatio:
        r.publication.relativeCitationRatio == null
          ? null
          : Number(r.publication.relativeCitationRatio),
      nihPercentile:
        r.publication.nihPercentile == null ? null : Number(r.publication.nihPercentile),
    };
  });

  const claims = await loadActiveCoreClaimsByCore(coreId, client);
  const { candidates, confirmed } = partitionCoreQueue(queueRows, (pmid) => claims.get(pmid) ?? null);
  return { core, candidates, confirmed };
}
