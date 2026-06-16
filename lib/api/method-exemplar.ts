/**
 * Loader for the method-badge hover exemplar (Variant 2 — `docs/search-snippet-
 * handoff.md` §7). Resolves the ONE representative paper for a scholar's matched
 * method FAMILY at request time, from Aurora only (no DynamoDB, no reindex):
 *
 *   1. Public-surface overlay gate — the SAME #800/#801 gate the search method
 *      badge applies (`loadFamilyOverlayGate({ forceSensitive: true })`), so a
 *      suppressed/#801-sensitive family yields null even if hit directly.
 *   2. `scholar_family.pmids` → the candidate PMID set (the distinct member pubs
 *      that put this scholar in this family; 100% populated, `len == pmid_count`).
 *   3. Publication metadata + this scholar's author position → ranked by the pure
 *      {@link rankMethodExemplar} key, top 1.
 *
 * Kept OUT of `searchPeople` (the cacheable results derive) on purpose: this is a
 * lazy, on-hover fetch (one route call per hovered row), so the up-to-N pub
 * lookups never run for the whole result set. Server-only.
 */
import "server-only";

import { prisma } from "@/lib/db";
import type { EvidencePub } from "@/lib/api/result-evidence";
import { isFamilyPubliclyVisible, loadFamilyOverlayGate } from "@/lib/api/methods-overlay";
import {
  isAuthorHidden,
  loadPublicationSuppressions,
  resolveDarkPmids,
} from "@/lib/api/manual-layer";
import { rankMethodExemplar, type ExemplarCandidate } from "@/lib/api/method-exemplar-rank";

/** Pure OVERFLOW guard on the candidate set — NOT a ranked top-N. It truncates
 *  the pmid set in raw `scholar_family.pmids` (export) order, so a family that
 *  ever exceeds this could drop the true best before ranking; set well above any
 *  real family size (staging max ≪ this) so it only ever caps a pathological row. */
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
 * The representative paper for `(cwid, familyLabel)`, or null when the family is
 * not publicly visible, has no candidate pmids, or nothing renderable survives.
 * `familyLabel` is the label the method badge shows (`scholar_family.familyLabel`).
 */
export async function loadMethodExemplar(
  cwid: string,
  familyLabel: string,
): Promise<EvidencePub | null> {
  const id = cwid.trim();
  const label = familyLabel.trim();
  if (!id || !label) return null;

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
    select: { supercategory: true, familyLabel: true, pmids: true },
    orderBy: { pmidCount: "desc" },
  });
  const visible = familyRows.filter((r) =>
    isFamilyPubliclyVisible(r.supercategory, r.familyLabel, gate),
  );
  if (visible.length === 0) return null;

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
  const pmids = Array.from(pmidSet);
  if (pmids.length === 0) return null;

  // (3) PUBLICATION gate — ADR-005 manual layer, the same gate every other
  // member-scoped pub surface applies (centers/divisions/dept-highlights and the
  // per-profile methods lens, lib/api/profile.ts). `scholar_family.pmids` is a
  // full-replacement ETL load independent of the suppression overlays, so a
  // sitewide-taken-down pmid, a derived-dark pmid, or one THIS scholar hid via
  // /edit can still sit in it — drop them before they can be the exemplar.
  const suppressions = await loadPublicationSuppressions(pmids, prisma);
  const dark = await resolveDarkPmids(pmids, suppressions, prisma);
  const safePmids = pmids.filter(
    (p) => !dark.has(p) && !isAuthorHidden(suppressions, p, id),
  );
  if (safePmids.length === 0) return null;

  // (4) Metadata + this scholar's authorship position (the first/senior signal is
  // NOT attributable per-candidate in the search index — handoff §7 G3 — so read
  // it from `publication_author`). `isConfirmed: true` so a rejected/unconfirmed
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
      where: { cwid: id, pmid: { in: safePmids }, isConfirmed: true },
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

  return rankMethodExemplar(candidates, new Date().getFullYear());
}
