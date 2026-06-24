/**
 * Loaders for the search-result "representative paper" hover (Variant 2 —
 * `docs/search-snippet-handoff.md` §7, "one function, three callers"). Given a
 * scholar's matched evidence, resolve the ONE most-representative paper at
 * request time, from Aurora only (no DynamoDB, no reindex):
 *
 *   - {@link loadMethodExemplar} — for a `method` badge: candidate pmids are the
 *     matched method FAMILY's members (`scholar_family.pmids`), behind the
 *     #800/#801 overlay gate (identical to the badge).
 *   - {@link loadTopicExemplar} — for a `topic` badge: candidate pmids are the
 *     scholar's pubs in the matched parent topic (`publication_topic`).
 *
 * Both share {@link rankExemplarForPmids}: the SCHOLAR gate, the ADR-005
 * publication-suppression gate, the author-position read, and the pure
 * {@link rankMethodExemplar} key. Kept OUT of `searchPeople` (the cacheable
 * results derive) on purpose — this is a lazy, on-hover fetch (one route call per
 * hovered row), so the up-to-N pub lookups never run for the whole result set.
 * Server-only.
 */
import "server-only";

import { prisma } from "@/lib/db";
import type { EvidencePub } from "@/lib/api/result-evidence";
import { isFamilyPubliclyVisible, loadFamilyOverlayGate } from "@/lib/api/methods-overlay";
import { isMethodsLensToolContextOn } from "@/lib/profile/methods-lens-flags";
import {
  isAuthorHidden,
  loadPublicationSuppressions,
  resolveDarkPmids,
} from "@/lib/api/manual-layer";
import {
  filterRenderableExemplars,
  rankMethodExemplarList,
  type ExemplarCandidate,
} from "@/lib/api/method-exemplar-rank";

/** Up to N representative papers + the renderable-candidate total ("+N more").
 *  #1119 — `methodContext` carries the family's best per-paper tool-usage snippet
 *  ("how researchers use <tool>"), populated only for a method match when
 *  METHODS_LENS_TOOL_CONTEXT is on; null otherwise (and always for topic).
 *  #1158 — `sourcePmid` is the publication the snippet was extracted from (digit
 *  string), keyed off the SAME tool name; null when unknown / not yet populated. */
export type ExemplarResult = {
  pubs: EvidencePub[];
  total: number;
  methodContext: { tool: string; context: string; sourcePmid: string | null } | null;
};

/** The null-equivalent empty result (no candidate / nothing renderable). */
const EMPTY_EXEMPLAR: ExemplarResult = { pubs: [], total: 0, methodContext: null };

/** Top-N representative papers shown in the disclosure stack. */
const EXEMPLAR_LIMIT = 3;

/** Pure OVERFLOW guard on the candidate set — NOT a ranked top-N. Set well above
 *  any real family / per-topic pub count so it only ever caps a pathological row. */
const MAX_CANDIDATES = 2000;

/** `scholar_family.pmids` is a JSON array of pmid strings; coerce + keep only
 *  digit strings (the pmid shape), tolerant of numbers or stray values. */
function toPmidArray(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const out: string[] = [];
  for (const v of json) {
    const s = String(v).trim();
    if (/^\d+$/.test(s)) out.push(s);
  }
  return out;
}

/**
 * Shared tail of both loaders: from a candidate pmid set for `cwid`, drop
 * suppressed pubs (ADR-005), rank the rest by the §7 key, and return the winner.
 *
 * PUBLICATION gate — the same gate every other member-scoped pub surface applies
 * (centers/divisions/dept-highlights and the per-profile lens, lib/api/profile.ts):
 * the candidate pmids come from a full-replacement ETL load independent of the
 * suppression overlays, so a sitewide-taken-down pmid, a derived-dark pmid, or one
 * THIS scholar hid via /edit can still be present — drop them before ranking.
 */
async function rankExemplarForPmids(
  cwid: string,
  pmids: string[],
  query?: string,
): Promise<ExemplarResult> {
  if (pmids.length === 0) return EMPTY_EXEMPLAR;

  const suppressions = await loadPublicationSuppressions(pmids, prisma);
  const dark = await resolveDarkPmids(pmids, suppressions, prisma);
  const safePmids = pmids.filter(
    (p) => !dark.has(p) && !isAuthorHidden(suppressions, p, cwid),
  );
  if (safePmids.length === 0) return EMPTY_EXEMPLAR;

  // Metadata + this scholar's authorship position (the first/senior signal is NOT
  // attributable per-candidate in the search index — handoff §7 G3 — so read it
  // from `publication_author`). `isConfirmed: true` so a rejected/unconfirmed
  // attribution can't grant a false ownership boost (matches publication-detail).
  const [pubs, authorRows] = await Promise.all([
    prisma.publication.findMany({
      where: { pmid: { in: safePmids } },
      select: {
        pmid: true,
        title: true,
        year: true,
        publicationType: true,
        impactScore: true,
        citationCount: true,
      },
    }),
    prisma.publicationAuthor.findMany({
      where: { cwid, pmid: { in: safePmids }, isConfirmed: true },
      select: { pmid: true, isFirst: true, isLast: true, totalAuthors: true },
    }),
  ]);

  // Ownership = first OR senior (last), with sole-authorship counting as both —
  // mirrors the index's `wcmAuthorPositions` derivation (lib/search-index-docs).
  const ownership = new Set<string>();
  for (const a of authorRows) {
    if (a.isFirst || a.isLast || a.totalAuthors === 1) ownership.add(a.pmid);
  }

  const candidates: ExemplarCandidate[] = pubs.map((p) => ({
    pmid: p.pmid,
    title: p.title,
    year: p.year ?? null,
    publicationType: p.publicationType ?? null,
    impactScore: p.impactScore != null ? Number(p.impactScore) : null,
    citationCount: p.citationCount ?? 0,
    isFirstOrSenior: ownership.has(p.pmid),
  }));

  // `total` = the RENDERABLE candidate count (drops corrections / untitled stubs,
  // matching what the profile would list), so "+N more" never over-promises;
  // `pubs` = the top-N for the disclosure stack.
  const renderable = filterRenderableExemplars(candidates);
  // `query` (the active search term) surfaces + highlights title-matching papers
  // first; absent ⇒ pure impact ranking (the pre-query-threading behaviour).
  const pubsRanked = rankMethodExemplarList(
    renderable,
    new Date().getFullYear(),
    EXEMPLAR_LIMIT,
    query,
  );
  // methodContext is a family-level concern resolved by the method loader; the
  // shared tail (also used by the topic loader) leaves it null.
  return { pubs: pubsRanked, total: renderable.length, methodContext: null };
}

/** #1119/#1158 — pick the family's representative tool-usage snippet: the
 *  top-pubCount visible row's FIRST exemplar tool (by the order-preserving
 *  `exemplar_tools` ARRAY — salience-ranked) that has a snippet. The
 *  `exemplar_contexts` OBJECT key order is unreliable (Aurora MySQL re-sorts JSON
 *  keys on storage, #1119 review), so order off the array, not the object — and the
 *  parallel `exemplar_context_pmids` source lookup MUST use the SAME `tool` key
 *  (object index), never positional, to stay 1:1 with the chosen snippet.
 *  `sourcePmid` is returned only when the value is a non-empty digit string, else
 *  null. null result when the flag is off or no row has a snippet. */
function pickMethodContext(
  rows: { exemplarTools: unknown; exemplarContexts: unknown; exemplarContextPmids: unknown }[],
): { tool: string; context: string; sourcePmid: string | null } | null {
  if (!isMethodsLensToolContextOn()) return null;
  for (const r of rows) {
    const raw = r.exemplarContexts;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const ctx = raw as Record<string, unknown>;
    const tools = Array.isArray(r.exemplarTools) ? (r.exemplarTools as unknown[]).map(String) : [];
    for (const tool of tools) {
      const context = ctx[tool];
      if (typeof context === "string" && context.length > 0) {
        // Parallel pmid map, keyed by the SAME tool display name (NOT positional).
        const pmidRaw = r.exemplarContextPmids;
        let sourcePmid: string | null = null;
        if (pmidRaw && typeof pmidRaw === "object" && !Array.isArray(pmidRaw)) {
          const v = (pmidRaw as Record<string, unknown>)[tool];
          if (typeof v === "string" && /^\d+$/.test(v)) sourcePmid = v;
        }
        return { tool, context, sourcePmid };
      }
    }
  }
  return null;
}

/**
 * Up to {@link EXEMPLAR_LIMIT} representative papers for `(cwid, familyLabel)`
 * plus the candidate total ("+N more"), or `{pubs:[],total:0}` when the family is
 * not publicly visible, has no candidate pmids, or nothing renderable survives.
 * `familyLabel` is the label the method badge shows (`scholar_family.familyLabel`).
 */
export async function loadMethodExemplar(
  cwid: string,
  familyLabel: string,
  query?: string,
): Promise<ExemplarResult> {
  const id = cwid.trim();
  const label = familyLabel.trim();
  if (!id || !label) return EMPTY_EXEMPLAR;

  // (1a) SCHOLAR gate — the scholar predicate the search badge + profile use
  // (`deletedAt: null, status: "active"`). scholar_family rows SURVIVE a soft
  // delete (the cascade only fires on a hard delete), so without this a
  // soft-deleted alumni / `status: "suppressed"` scholar — notFound on every
  // public surface — would still leak a representative paper + family membership
  // via a direct GET. Pushed into the WHERE so a hidden scholar yields no rows.
  //
  // (1b) FAMILY gate — forceSensitive matches the badge exactly so the hover can
  // never reveal a paper from a #800-suppressed / #801-sensitive family.
  const gate = await loadFamilyOverlayGate({ forceSensitive: true });
  const familyRows = await prisma.scholarFamily.findMany({
    where: {
      cwid: id,
      familyLabel: label,
      scholar: { deletedAt: null, status: "active" },
    },
    select: {
      supercategory: true,
      familyLabel: true,
      pmids: true,
      exemplarTools: true,
      exemplarContexts: true,
      exemplarContextPmids: true,
    },
    orderBy: { pmidCount: "desc" },
  });
  const visible = familyRows.filter((r) =>
    isFamilyPubliclyVisible(r.supercategory, r.familyLabel, gate),
  );
  if (visible.length === 0) return EMPTY_EXEMPLAR;

  // #1119 — the family's representative tool-usage snippet (flag-gated inside).
  const methodContext = pickMethodContext(visible);

  // (2) Candidate pmids — union across the matching public rows (a label can in
  // principle recur under two supercategories; both public here), bounded.
  const pmidSet = new Set<string>();
  for (const r of visible) {
    for (const p of toPmidArray(r.pmids)) {
      pmidSet.add(p);
      if (pmidSet.size >= MAX_CANDIDATES) break;
    }
    if (pmidSet.size >= MAX_CANDIDATES) break;
  }

  const result = await rankExemplarForPmids(id, Array.from(pmidSet), query);
  return { ...result, methodContext };
}

/**
 * Up to {@link EXEMPLAR_LIMIT} representative papers for `(cwid, parentTopicId)`
 * plus the candidate total ("+N more"), or `{pubs:[],total:0}` when the scholar
 * is not publicly visible, has no pubs in the topic, or nothing renderable
 * survives. `parentTopicId` is the topic SLUG the topic badge carries (`Topic.id`
 * = `PublicationTopic.parentTopicId`). Topics carry no #800/#801 overlay (those
 * gate method families only); the SCHOLAR gate + the publication-suppression gate
 * inside {@link rankExemplarForPmids} still apply.
 */
export async function loadTopicExemplar(
  cwid: string,
  parentTopicId: string,
  query?: string,
): Promise<ExemplarResult> {
  const id = cwid.trim();
  const topicId = parentTopicId.trim();
  if (!id || !topicId) return EMPTY_EXEMPLAR;

  // Candidate pmids = the scholar's pubs in this parent topic (ReciterAI-
  // attributed; `publication_topic` has no confirm/reject flag), behind the same
  // active/non-deleted SCHOLAR gate. Ordered by the ReciterAI parent-topic score
  // so that, if a prolific scholar exceeds the cap, the most topic-relevant pubs
  // are the ones ranked (not an arbitrary truncation).
  const rows = await prisma.publicationTopic.findMany({
    where: {
      cwid: id,
      parentTopicId: topicId,
      scholar: { deletedAt: null, status: "active" },
    },
    select: { pmid: true },
    orderBy: { score: "desc" },
    take: MAX_CANDIDATES,
  });

  return rankExemplarForPmids(id, rows.map((r) => r.pmid), query);
}
