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
  /** NLM/Index Medicus abbreviation ("J Am Med Inform Assoc"). The queue card
   *  header shows this in place of the full `journal`, falling back to it when
   *  null — some publications have no abbreviation on file. */
  journalAbbrev: string | null;
  year: number | null;
  /** The date PubMed indexed the record, as `YYYY-MM-DD` (the column is
   *  `@db.Date`, so it is a calendar date with no time or zone — kept as a
   *  string here so nothing downstream can re-interpret it in a local zone and
   *  slip a day). Null when never ingested; the card falls back to `year`. */
  dateAddedToEntrez: string | null;
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
  /** True when `WCM_AUTHORS_CAP` cut a DISTINCT WCM author off the end of
   *  `wcmAuthors` — the list is a prefix of the byline, not the byline.
   *
   *  It exists because the card decides a byline surname is unambiguous by
   *  looking at this list: a second holder of that surname past the cap is
   *  invisible, and the card would then rename a token and attach one specific
   *  person's CWID, name and department to it. A truncated row must refuse that,
   *  since the assertion is wrong rather than merely absent.
   *
   *  Absent means "not truncated", and the loader writes the key ONLY when it is
   *  true — truncation is the rare case, and `CoreClaimQueue` is a client
   *  component, so a `false` on every ordinary row is ~64 KB of RSC payload on a
   *  core the size of core 14 (2,428 untruncated rows) saying nothing. Read it as
   *  a truthiness test, never `=== false`. */
  wcmAuthorsTruncated?: boolean;
  /** Raw PubMed abstract. NOTHING RENDERS THIS any more — the Details disclosure
   *  that showed it came out with the direction-A queue rebuild, and the only
   *  reads left in the repo are this loader's own shape assertions in
   *  tests/unit/core-queue.test.ts. Kept for now because a test still reads it;
   *  drop it (with `meshTerms` below) the moment nothing does, since every queue
   *  row otherwise ships a full abstract to the client for no consumer. */
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
  /** 0-1 batch_screen prefilter_prior; null when never computed. The engine's
   *  fifth signal, but NOT one of the four the UI counts: round 2 demoted it to
   *  an italic footnote under the evidence panel (`SIGNAL_COUNT` is 4). It
   *  blends a MeSH-branch match on the paper's own descriptors with the
   *  repeat-user number it already restates, so counting it would count that
   *  number twice — see `priorFootnote` for the wording each case earns. */
  topicalPrior: number | null;
  /** Method-family strength band from the engine's extractor
   *  ("strong" | "moderate" | "weak"); null when it found no family.
   *
   *  `method_evidence` beside it IS now selected — the card renders a chip per
   *  family and a "Methods used" evidence row — bounded as `methodEvidence`
   *  below describes. `mesh_evidence` stays deliberately unselected: nothing
   *  renders it, and `CoreClaimQueue` is a `"use client"` component, so every
   *  selected column ships in the RSC payload for every queued row (1,281 on
   *  core 14 in staging today) — and that one is a list of free-text sentences
   *  up to 500 chars each. The ETL writes all three columns regardless.
   *
   *  NOT a counted signal, decided 2026-09-07: it renders as an uncounted
   *  tier-labelled token in the evidence strip and a strong+moderate facet, and
   *  `SIGNAL_COUNT` is untouched by it (4 since round 2 demoted the prefilter
   *  prior to a footnote). Two reasons it is not a counted signal — it is
   *  weighted 0.00 in the engine's `combine.WEIGHTS` so it moves no likelihood,
   *  and 63% of rows carrying a tier are `weak`, where the measured lift inverts
   *  to BELOW background (1.7x -> 0.7x). Counting it would assert a signal that
   *  anti-correlates on two of every three rows that gain it. */
  methodTier: string | null;
  /** The extractor entries behind `methodTier`, pre-ranked strongest first;
   *  `[]` when the engine wrote none (every row scored before it started
   *  emitting the column).
   *
   *  `family`/`tool` are short labels and ride along on EVERY entry — the card
   *  puts one chip per family at the top. `sentence` is the extractor's quoted
   *  free text, up to 500 chars, and rides on the TOP-RANKED entry ONLY: it is
   *  the only one the evidence row quotes, and this list crosses to the client
   *  for all 1,281 rows. Dropping the sentences nothing renders is how the
   *  payload is bounded — the one that IS rendered is never truncated, so the
   *  quote can't end mid-word the way `llmRationale` does. */
  methodEvidence: Array<{ family: string; tool: string; sentence: string | null }>;
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
  /** Per-PMID MeSH terms ({ui, label}); `[]` when none. Same standing as
   *  `abstract` above: the Details chips that showed these are gone, so the only
   *  reads left are this loader's shape assertions. The queue's free-text filter
   *  deliberately does NOT search them either — a match a reviewer cannot see on
   *  the card is worse than a miss. */
  meshTerms: Array<{ ui: string | null; label: string }>;
}

export interface CoreReviewQueue {
  core: {
    id: string;
    name: string;
    /** How many core staff ReciterAI's facility dictionary LISTS for this core
     *  (ETL-owned, projected by etl/dynamodb Block 6b). NULL means the engine
     *  has not published counts for this core yet, which is NOT the same as 0:
     *  0 means the dictionary lists no staff at all. */
    staffCount: number | null;
    /** Of those listed staff, how many the co-author signal can actually MATCH
     *  — the number the signal really runs on, and the one the toolbar chip
     *  leads with. It is routinely smaller than `staffCount` (the two differ on
     *  9 of the 14 live cores) because the signal reads the core's tracked
     *  staff CWIDs, not its dictionary list, so a listed staff member with no
     *  personIdentifier upstream is invisible to it. 0 here with a positive
     *  `staffCount` is a real state: the dictionary lists staff but the signal
     *  cannot fire. Written in lockstep with `staffCount`, so in practice the
     *  two are both NULL or both set. */
    staffTrackedCount: number | null;
  };
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
 *  and manual-claim-only row builders below. `abstract` and `meshTerms` are the
 *  two exceptions: the card stopped rendering both when the Details disclosure
 *  came out (see the field docs on `CoreQueueRow`). */
const CARD_PUBLICATION_SELECT = {
  title: true,
  journal: true,
  journalAbbrev: true,
  year: true,
  dateAddedToEntrez: true,
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
 * A `@db.Date` column as a bare `YYYY-MM-DD` calendar date. Prisma hands one
 * back as a JS Date pinned to midnight UTC, so slicing the ISO string is the
 * one reading that cannot drift — `getDate()` and friends would render the
 * PREVIOUS day for any viewer west of UTC. Same conversion
 * `lib/api/export-publications.ts` already uses on this column.
 */
function isoDate(d: Date | null): string | null {
  return d == null ? null : d.toISOString().slice(0, 10);
}

/**
 * `publication_core.method_evidence` reduced to what the card renders: the
 * `family`/`tool` of every well-formed entry, but the `sentence` of the
 * top-ranked one only (the column arrives pre-ranked strongest first, so that
 * is entry 0). See `CoreQueueRow.methodEvidence` for why the payload is bounded
 * this way rather than by cutting the sentence short.
 *
 * The column is `Json?` and absent on every row scored before the engine
 * emitted it, so this must degrade rather than throw: a null, a non-array, or
 * an entry missing either short label yields no method evidence at all.
 */
function methodEvidenceForCard(value: unknown): CoreQueueRow["methodEvidence"] {
  if (!Array.isArray(value)) return [];
  const out: CoreQueueRow["methodEvidence"] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.family !== "string" || typeof rec.tool !== "string") continue;
    out.push({
      family: rec.family,
      tool: rec.tool,
      // Empty `out` means this is the strongest entry that parsed — the one
      // whose sentence the evidence row quotes.
      sentence: out.length === 0 && typeof rec.sentence === "string" ? rec.sentence : null,
    });
  }
  return out;
}

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
    select: { id: true, name: true, staffCount: true, staffTrackedCount: true },
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
      // methodTier + method_evidence, which the card now renders. mesh_evidence
      // stays out: nothing renders it, and every selected column crosses the
      // server/client boundary for all 1,281 rows. See CoreQueueRow.methodTier.
      methodTier: true,
      methodEvidence: true,
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
  // Papers whose byline ran past WCM_AUTHORS_CAP — see `wcmAuthorsTruncated`.
  const truncatedPmids = new Set<string>();
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
      const cwidLc = a.cwid.toLowerCase();
      const scholar: QueueScholar = {
        cwid: a.cwid,
        name: a.scholar.preferredName,
        slug: a.scholar.slug,
        dept: a.scholar.primaryDepartment,
      };
      // byline authors also resolve core-staff co-author CWIDs (case-insensitively)
      putScholar(scholar);
      const list = wcmByPmid.get(a.pmid) ?? [];
      // A repeat of someone already listed is not truncation — they are on the
      // card either way — so the dedupe is tested BEFORE the cap. Compared
      // LOWERCASED, like every other CWID comparison in this loader: nothing
      // constrains `publication_author.cwid` to one casing per person, and a
      // casing variant slipping past here both double-lists them on the card and
      // (at the cap) flags a byline as truncated that lost nobody.
      if (list.some((w) => w.cwid.toLowerCase() === cwidLc)) continue;
      if (list.length >= WCM_AUTHORS_CAP) {
        truncatedPmids.add(a.pmid);
        continue;
      }
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
      journalAbbrev: r.publication.journalAbbrev,
      year: r.publication.year,
      dateAddedToEntrez: isoDate(r.publication.dateAddedToEntrez),
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
      // Written only when true — see the field's docblock: absent IS "not
      // truncated", and this row ships to a client component.
      ...(truncatedPmids.has(r.pmid) ? { wcmAuthorsTruncated: true } : {}),
      signalAck: r.signalAck,
      ackAlias: r.ackAlias,
      ackSnippet: r.ackSnippet,
      llmScore: r.llmScore,
      llmRationale: r.llmRationale,
      // authorAffinity is a nullable Decimal — Number(null) is 0, so guard the null.
      authorAffinity: r.authorAffinity == null ? null : Number(r.authorAffinity),
      // same nullable-Decimal guard as authorAffinity above.
      topicalPrior: r.topicalPrior == null ? null : Number(r.topicalPrior),
      methodTier: r.methodTier,
      methodEvidence: methodEvidenceForCard(r.methodEvidence),
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
    journalAbbrev: p.journalAbbrev,
    year: p.year,
    dateAddedToEntrez: isoDate(p.dateAddedToEntrez),
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
    // same "only when true" rule as the engine builder above.
    ...(truncatedPmids.has(p.pmid) ? { wcmAuthorsTruncated: true } : {}),
    signalAck: false,
    ackAlias: null,
    ackSnippet: null,
    llmScore: null,
    llmRationale: null,
    authorAffinity: null,
    topicalPrior: null,
    methodTier: null,
    methodEvidence: [],
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
  return {
    // Rebuilt rather than passed straight through so both staff counts are
    // always present and always `number | null` — an `undefined` reaching the
    // client would render as "not published yet" by accident rather than by
    // the column actually being NULL.
    core: {
      id: core.id,
      name: core.name,
      staffCount: core.staffCount ?? null,
      staffTrackedCount: core.staffTrackedCount ?? null,
    },
    candidates,
    confirmed,
    rejected,
  };
}
