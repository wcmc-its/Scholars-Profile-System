/**
 * `/edit/reports/6` ("NIH-funded pubs") data layer — org-unit publications
 * reports plan (2026-08-16). `GrantPublication` IS the NIH-funding link: it's
 * materialized specifically from NIH RePORTER's `/publications/search`
 * (`etl/reporter/index.ts`), not a generic funder-agnostic join. So "pubs that
 * are the product of NIH funding" is exactly the unit's member pubs that have
 * a `GrantPublication` row — no new data or funder filter needed.
 *
 * Unit-agnostic by construction, same membership resolver as report 3
 * (`loadUnitPublicationsReport`'s `loadUnitMemberCwids`, re-derived here to
 * avoid a cross-report import): `center` → `loadActiveCenterMemberCwids`,
 * `division` → `loadDivisionMemberCwids`, `department` →
 * `Scholar.deptCode`-filtered.
 *
 * Row grain is one row per (publication, grant) LINK, matching
 * `GrantPublication`'s own grain — a pub co-funded by two grants gets two
 * rows, since the "Lower confidence" trigger below is evaluated PER LINK
 * (`sourceReporter`/`sourceReciterdb`/`reciterdbFirstSeen` are columns on
 * `GrantPublication`, not on `Publication`), so a blended one-row-per-pub view
 * could only ever show one of two differing confidence states.
 *
 * The grant's OWNER (`Grant.cwid`) need not be a unit member — the gate here
 * is the PUBLICATION's confirmed unit-member authorship, same as report 3,
 * not the grant's PI.
 */
import { db } from "@/lib/db";
import type { UnitEntityType } from "@/lib/api/manual-layer";
import { loadActiveCenterMemberCwids } from "@/lib/api/centers";
import { loadDivisionMemberCwids } from "@/lib/api/divisions";

export type NihFundedPublicationRow = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  grantId: string;
  grantTitle: string;
  awardNumber: string | null;
  /** "Lower confidence" badge trigger (`components/funding/expanded-grant.tsx`'s
   *  `LowerConfidenceBadge`) — reciterdb has carried this (grant, pmid) link
   *  for 12+ months but RePORTER still hasn't confirmed it. Identical formula
   *  to `lib/api/profile.ts`'s grant-publication mapping (issues #85/#86); see
   *  the `GrantPublication` schema doc comment for the confidence tiers. */
  isLowerConfidence: boolean;
};

export type NihFundedPublicationsReport = {
  /** Distinct publications with ≥1 GrantPublication link — NOT rows.length,
   *  which counts (publication, grant) pairs (a pub linked to 2 grants counts
   *  once here, twice in `rows`). */
  totalPublications: number;
  rows: ReadonlyArray<NihFundedPublicationRow>;
};

const EMPTY_REPORT: NihFundedPublicationsReport = { totalPublications: 0, rows: [] };

/** Active member CWIDs for `kind` — see the module doc comment for why this
 *  is re-derived rather than imported from the report-3 module. */
async function loadUnitMemberCwids(kind: UnitEntityType, code: string): Promise<string[]> {
  if (kind === "center") return loadActiveCenterMemberCwids(code);
  if (kind === "division") return loadDivisionMemberCwids(code);
  const rows = await db.read.scholar.findMany({
    where: { deptCode: code, deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  return rows.map((r) => r.cwid);
}

/** "Lower confidence" trigger — see `NihFundedPublicationRow.isLowerConfidence`. */
function isLowerConfidenceLink(gp: {
  sourceReporter: boolean;
  sourceReciterdb: boolean;
  reciterdbFirstSeen: Date | null;
}): boolean {
  if (!gp.sourceReciterdb || gp.sourceReporter || gp.reciterdbFirstSeen === null) return false;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  return gp.reciterdbFirstSeen < cutoff;
}

/**
 * Build the NIH-funded-pubs report for one unit: resolve active members,
 * pull their confirmed-authorship publications that carry ≥1
 * `GrantPublication` row, and flatten to one row per (publication, grant)
 * link, newest-publication-year first.
 */
export async function loadNihFundedPublicationsReport(
  kind: UnitEntityType,
  code: string,
): Promise<NihFundedPublicationsReport> {
  const memberCwids = await loadUnitMemberCwids(kind, code);
  if (memberCwids.length === 0) return EMPTY_REPORT;

  const pubs = await db.read.publication.findMany({
    where: {
      authors: { some: { isConfirmed: true, cwid: { in: memberCwids } } },
      grants: { some: {} },
    },
    select: {
      pmid: true,
      title: true,
      journal: true,
      year: true,
      grants: {
        select: {
          grantId: true,
          sourceReporter: true,
          sourceReciterdb: true,
          reciterdbFirstSeen: true,
          grant: { select: { title: true, awardNumber: true } },
        },
      },
    },
  });
  if (pubs.length === 0) return EMPTY_REPORT;

  const rows: NihFundedPublicationRow[] = [];
  for (const p of pubs) {
    for (const gp of p.grants) {
      rows.push({
        pmid: p.pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        grantId: gp.grantId,
        grantTitle: gp.grant.title,
        awardNumber: gp.grant.awardNumber ?? null,
        isLowerConfidence: isLowerConfidenceLink(gp),
      });
    }
  }
  rows.sort((a, b) => {
    if ((b.year ?? 0) !== (a.year ?? 0)) return (b.year ?? 0) - (a.year ?? 0);
    if (a.pmid !== b.pmid) return a.pmid.localeCompare(b.pmid);
    return a.grantId.localeCompare(b.grantId);
  });

  return { totalPublications: pubs.length, rows };
}
