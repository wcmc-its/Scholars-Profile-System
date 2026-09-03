/**
 * Per-core review queue data (the owner surface at /edit/core/[coreId]).
 *
 * Loads the engine's projected `publication_core` rows for one core, joins each
 * to its publication, and partitions them by EFFECTIVE status (the CoreClaim
 * override read-merged over the engine status, see lib/api/core-merge.ts):
 *   - `candidates` — open engine candidates with no active claim, the review work
 *   - `confirmed`  — effective-confirmed (engine `confirmed` OR human `claimed`)
 *   - `rejected`   — effective-rejected (a human `rejected` claim; the engine has
 *                    no rejected state). Surfaces the Rejected tab (#1239).
 * An engine `below_threshold` row with no claim drops out of all three lists.
 * All three are ranked by likelihood desc.
 *
 * A CLAIMED `core_claim` with no matching `publication_core` row at all — a
 * human attesting usage of a PMID the engine never scored ("Manual PMID add",
 * `POST /api/edit/core-claim/bulk`) — is folded into `confirmed` too, via a
 * second query joined straight to `publication` (`isManual: true` on the row).
 * A REJECTED claim with no engine row isn't surfaced — there's nothing to
 * reject, so it's not meaningful review state.
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
import { normalizeMeshTerms } from "@/lib/api/profile";
import { fetchDirectoryPeopleByCwid } from "@/lib/sources/ldap";

/** A WCM scholar resolved from a CWID, linkable to their public profile. */
export interface QueueScholar {
  cwid: string;
  name: string;
  /** Profile slug, or null for an ED-only person (core staff with no Scholar
   *  row, #1239) — named but not linkable. */
  slug: string | null;
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
  /** 0-1 batch_screen prefilter_prior (signal 5); null when never computed. */
  topicalPrior: number | null;
  /** Scopus citation count for the publication. */
  citationCount: number;
  pubmedUrl: string | null;
  doi: string | null;
  /** True when an active human claim (not just the engine) backs a confirmed row;
   *  set by partitionCoreQueue. Drives the Confirmed-list revoke vs reject path. */
  claimed: boolean;
  /** True when this row has NO engine (`publication_core`) projection at all — a
   *  human claimed a PMID the engine never scored ("Manual PMID add"). Every
   *  signal/likelihood field is a placeholder; the UI should show that plainly
   *  rather than a misleading 0%/no-evidence candidate card. */
  isManual: boolean;
  /** iCite relative citation ratio (reciterdb.analysis_nih), when computed. */
  relativeCitationRatio: number | null;
  /** NIH citation percentile (0-100), when computed. */
  nihPercentile: number | null;
  /** Per-PMID MeSH terms ({ui, label}); `[]` when none. Shown as chips in Details. */
  meshTerms: Array<{ ui: string | null; label: string }>;
}

export interface CoreReviewQueue {
  core: { id: string; name: string };
  candidates: CoreQueueRow[];
  confirmed: CoreQueueRow[];
  /** Effective-rejected pairs (a human `rejected` claim) — the Rejected tab. */
  rejected: CoreQueueRow[];
}

/**
 * Partition queue rows into open candidates / effective-confirmed / effective-
 * rejected, applying the CoreClaim override. Pure — `claimFor` resolves the
 * active claim (or null) for a pmid. Input order is preserved (the caller ranks
 * by likelihood).
 */
export function partitionCoreQueue(
  rows: ReadonlyArray<CoreQueueRow>,
  claimFor: (pmid: string) => ClaimStatus | null,
): { candidates: CoreQueueRow[]; confirmed: CoreQueueRow[]; rejected: CoreQueueRow[] } {
  const candidates: CoreQueueRow[] = [];
  const confirmed: CoreQueueRow[] = [];
  const rejected: CoreQueueRow[] = [];
  for (const row of rows) {
    const claim = claimFor(row.pmid);
    if (isOpenCandidate(row.status, claim)) candidates.push({ ...row, claimed: false });
    else if (effectiveCoreStatus(row.status, claim) === "confirmed")
      confirmed.push({ ...row, claimed: claim === "claimed" });
    // Effective-rejected is ONLY ever a human `rejected` claim (the engine has no
    // rejected state), so a claim always backs it → `claimed: true` drives the
    // Rejected-tab restore (which posts the soft `revoked` undo).
    else if (effectiveCoreStatus(row.status, claim) === "rejected")
      rejected.push({ ...row, claimed: true });
    // an engine `below_threshold` row with no claim falls through (not surfaced)
  }
  return { candidates, confirmed, rejected };
}

type QueueReader = Pick<
  typeof db.read,
  "core" | "publicationCore" | "coreClaim" | "scholar" | "publicationAuthor" | "publication"
>;

/** The `publication` fields a queue card needs — shared by the engine-sourced
 *  and manual-claim-only row builders below. */
const CARD_PUBLICATION_SELECT = {
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
  meshTerms: true,
} as const;

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
      topicalPrior: true,
      publication: { select: CARD_PUBLICATION_SELECT },
    },
  });

  const claims = await loadActiveCoreClaimsByCore(coreId, client);

  // Manual PMID add: a CLAIMED core_claim with no matching publication_core row
  // above — a human attesting usage the engine never scored. (A REJECTED claim
  // with no engine row has nothing to reject, so it's not surfaced.)
  const projectedPmids = new Set(rows.map((r) => r.pmid));
  const manualPmids = [...claims.entries()]
    .filter(([pmid, status]) => status === "claimed" && !projectedPmids.has(pmid))
    .map(([pmid]) => pmid);
  const manualPubs =
    manualPmids.length === 0
      ? []
      : await client.publication.findMany({
          where: { pmid: { in: manualPmids } },
          select: { pmid: true, ...CARD_PUBLICATION_SELECT },
        });

  // --- batched name resolution (one query each, not per row; covers manual rows too) ---
  const coStaffCwids = new Set<string>();
  for (const r of rows) {
    if (Array.isArray(r.signalCoauthors)) {
      for (const c of r.signalCoauthors) if (typeof c === "string") coStaffCwids.add(c);
    }
  }
  const pmids = [...rows.map((r) => r.pmid), ...manualPubs.map((p) => p.pmid)];

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

  // Core staff with no Scholar row AND not on the byline (#1239) — the last
  // resort is the enterprise directory, which knows every employee. Fail-soft:
  // an LDAP hiccup just leaves the bare CWID showing, it never fails the page.
  // ponytail: one uncached lookup per page load, rare by construction (a
  // handful of CWIDs at most); cache it if the directory ever gets slow.
  const namelessCwids = [...coStaffCwids].filter((c) => !scholarByCwidLc.has(c.toLowerCase()));
  if (namelessCwids.length > 0) {
    try {
      for (const p of await fetchDirectoryPeopleByCwid(namelessCwids)) {
        putScholar({ cwid: p.cwid, name: p.name, slug: null, dept: p.dept });
      }
    } catch (err) {
      console.error("[core-queue] ED name enrichment failed", err);
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
      // same nullable-Decimal guard as authorAffinity above.
      topicalPrior: r.topicalPrior == null ? null : Number(r.topicalPrior),
      citationCount: r.publication.citationCount,
      pubmedUrl: r.publication.pubmedUrl,
      doi: r.publication.doi,
      // claimed is resolved per-row in partitionCoreQueue once claims are known.
      claimed: false,
      isManual: false,
      relativeCitationRatio:
        r.publication.relativeCitationRatio == null
          ? null
          : Number(r.publication.relativeCitationRatio),
      nihPercentile:
        r.publication.nihPercentile == null ? null : Number(r.publication.nihPercentile),
      meshTerms: normalizeMeshTerms(r.publication.meshTerms),
    };
  });

  const manualRows: CoreQueueRow[] = manualPubs.map((p) => ({
    pmid: p.pmid,
    title: p.title,
    journal: p.journal,
    year: p.year,
    authorsString: p.authorsString,
    fullAuthorsString: p.fullAuthorsString,
    abstract: p.abstract,
    synopsis: p.synopsis,
    // No engine projection exists — likelihood/status/every signal is a
    // placeholder never read functionally (core-merge resolves purely off the
    // active claim), but isManual tells the UI to render that plainly.
    likelihood: 0,
    status: "confirmed",
    coauthors: [],
    coauthorScholars: [],
    wcmAuthors: wcmByPmid.get(p.pmid) ?? [],
    signalAck: false,
    ackAlias: null,
    ackSnippet: null,
    llmScore: null,
    llmRationale: null,
    authorAffinity: null,
    topicalPrior: null,
    citationCount: p.citationCount,
    pubmedUrl: p.pubmedUrl,
    doi: p.doi,
    claimed: false,
    isManual: true,
    relativeCitationRatio:
      p.relativeCitationRatio == null ? null : Number(p.relativeCitationRatio),
    nihPercentile: p.nihPercentile == null ? null : Number(p.nihPercentile),
    meshTerms: normalizeMeshTerms(p.meshTerms),
  }));

  const { candidates, confirmed, rejected } = partitionCoreQueue(
    [...queueRows, ...manualRows],
    (pmid) => claims.get(pmid) ?? null,
  );
  return { core, candidates, confirmed, rejected };
}
