/**
 * `/edit/reports/6` ("NIH-funded pubs") data layer — org-unit publications
 * reports plan (2026-08-16). `GrantPublication` IS the NIH-funding link: it's
 * materialized specifically from NIH RePORTER's `/publications/search`
 * (`etl/reporter/index.ts`), not a generic funder-agnostic join. So "pubs that
 * are the product of NIH funding" is exactly the unit's member pubs that have
 * a `GrantPublication` row — no new data or funder filter needed.
 *
 * Unit-agnostic by construction, same publication-set resolution as report 3
 * (`loadUnitPublicationsReport`'s `resolvePublicationScope`, re-derived here to
 * avoid a cross-report import — the long-standing convention in this pair):
 * `center` → `loadActiveCenterMemberCwids`, `division` →
 * `loadDivisionMemberCwids`, `department` → `Scholar.deptCode`-filtered, and
 * `core` → its CONFIRMED `publication_core` usages via
 * `loadConfirmedCorePmidsByCore`, since a core has no membership table at all
 * (core-reports widening, 2026-09-06). The status semantics behind
 * "confirmed" are owned by `lib/api/core-merge.ts` and never restated here.
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
import { loadActiveCenterMemberCwids } from "@/lib/api/centers";
import { loadConfirmedCorePmidsByCore } from "@/lib/api/cores";
import { loadDivisionMemberCwids } from "@/lib/api/divisions";
import { loadProjectSiblingRows, type ProjectKeyRow } from "@/lib/api/project-siblings";
import type { ReportableUnitKind } from "@/lib/edit/cancer-center-reports";
import { groupGrantsByProject, sortPeople } from "@/lib/funding-projection";

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
  /** Every investigator on this row's Grant's funding project: this row's own
   *  `Grant.cwid` plus any sibling `Grant` rows sharing the same award/project
   *  (a WCM Grant is one row PER investigator per InfoEd account, so a real
   *  multi-investigator award is several sibling Grant rows) — lead-PI-first,
   *  deduped by cwid. Falls back to this Grant's own `{cwid}` alone when its
   *  `externalId` doesn't parse (should be rare/never — `Grant.externalId` is
   *  a required unique column — but handled defensively). */
  investigators: ReadonlyArray<{ cwid: string; name: string }>;
};

export type NihFundedPublicationsReport = {
  /** Distinct publications with ≥1 GrantPublication link — NOT rows.length,
   *  which counts (publication, grant) pairs (a pub linked to 2 grants counts
   *  once here, twice in `rows`). */
  totalPublications: number;
  rows: ReadonlyArray<NihFundedPublicationRow>;
};

const EMPTY_REPORT: NihFundedPublicationsReport = { totalPublications: 0, rows: [] };

/** Active member CWIDs for a MEMBERSHIP-based `kind` — see the module doc
 *  comment for why this is re-derived rather than imported from the report-3
 *  module. Never called for a core, which has no membership table. */
async function loadUnitMemberCwids(
  kind: Exclude<ReportableUnitKind, "core">,
  code: string,
): Promise<string[]> {
  if (kind === "center") return loadActiveCenterMemberCwids(code);
  if (kind === "division") return loadDivisionMemberCwids(code);
  const rows = await db.read.scholar.findMany({
    where: { deptCode: code, deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  return rows.map((r) => r.cwid);
}

/**
 * The `where` fragment selecting this unit's publication set, or `null` when
 * the unit resolves to none before any `publication` query runs.
 *
 * Membership-based for the three classic org units; for a core, its CONFIRMED
 * `publication_core` usages — a core has no roster, so the member path would
 * resolve zero CWIDs and hand every core owner a permanently empty report.
 * Mirrors `resolvePublicationScope` in
 * `lib/edit/cancer-center-publications-report.ts`, minus the author-facet half
 * (this report has no Person-type rail).
 */
async function resolveUnitPublicationWhere(
  kind: ReportableUnitKind,
  code: string,
): Promise<{ pmid: { in: string[] } } | { authors: { some: { isConfirmed: true; cwid: { in: string[] } } } } | null> {
  if (kind === "core") {
    const pmids = (await loadConfirmedCorePmidsByCore([code], db.read)).get(code) ?? [];
    return pmids.length === 0 ? null : { pmid: { in: pmids } };
  }
  const memberCwids = await loadUnitMemberCwids(kind, code);
  return memberCwids.length === 0
    ? null
    : { authors: { some: { isConfirmed: true, cwid: { in: memberCwids } } } };
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
 * Build the NIH-funded-pubs report for one unit: resolve its publication set
 * (active members for a center/department/division, confirmed core usages for
 * a core — see `resolveUnitPublicationWhere`), keep the ones carrying ≥1
 * `GrantPublication` row, and flatten to one row per (publication, grant)
 * link, newest-publication-year first. Everything after the scope resolution
 * is kind-agnostic and runs unchanged.
 */
export async function loadNihFundedPublicationsReport(
  kind: ReportableUnitKind,
  code: string,
): Promise<NihFundedPublicationsReport> {
  const unitWhere = await resolveUnitPublicationWhere(kind, code);
  if (unitWhere === null) return EMPTY_REPORT;

  const pubs = await db.read.publication.findMany({
    where: {
      ...unitWhere,
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
          grant: {
            select: { title: true, awardNumber: true, externalId: true, role: true, cwid: true },
          },
        },
      },
    },
  });
  if (pubs.length === 0) return EMPTY_REPORT;

  // One flat row per (publication, grant) link, plus one base row per DISTINCT
  // grant (dedup by grantId — several pub rows can reference the same grant) to
  // drive the investigator lookup below.
  type FlatRow = Omit<NihFundedPublicationRow, "investigators">;
  const flatRows: FlatRow[] = [];
  const distinctGrantBaseRows = new Map<string, DistinctGrantBaseRow>();
  for (const p of pubs) {
    for (const gp of p.grants) {
      flatRows.push({
        pmid: p.pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        grantId: gp.grantId,
        grantTitle: gp.grant.title,
        awardNumber: gp.grant.awardNumber ?? null,
        isLowerConfidence: isLowerConfidenceLink(gp),
      });
      if (!distinctGrantBaseRows.has(gp.grantId)) {
        distinctGrantBaseRows.set(gp.grantId, {
          grantId: gp.grantId,
          cwid: gp.grant.cwid,
          role: gp.grant.role,
          externalId: gp.grant.externalId,
          awardNumber: gp.grant.awardNumber,
        });
      }
    }
  }

  const investigatorsByGrantId = await resolveInvestigatorsByGrantId(
    Array.from(distinctGrantBaseRows.values()),
  );

  const rows: NihFundedPublicationRow[] = flatRows.map((r) => ({
    ...r,
    investigators: investigatorsByGrantId.get(r.grantId) ?? [],
  }));
  rows.sort((a, b) => {
    if ((b.year ?? 0) !== (a.year ?? 0)) return (b.year ?? 0) - (a.year ?? 0);
    if (a.pmid !== b.pmid) return a.pmid.localeCompare(b.pmid);
    return a.grantId.localeCompare(b.grantId);
  });

  return { totalPublications: pubs.length, rows };
}

/** The columns of a distinct Grant row referenced by this report, keyed by the
 *  Grant's own id (`GrantPublication.grantId`) so the investigator lookup can
 *  be attached back to every flat pub/grant row that shares it. */
type DistinctGrantBaseRow = {
  grantId: string;
  cwid: string;
  role: string;
  externalId: string | null;
  awardNumber: string | null;
};

/**
 * Resolve the co-investigator list for every distinct grant referenced by
 * this report — one bulk sibling-grant query and one bulk scholar-name
 * query, never per-row/per-grant.
 *
 * A WCM `Grant` is one row PER investigator per InfoEd account; a real
 * multi-investigator award is several sibling `Grant` rows sharing the same
 * award/project (`lib/api/project-siblings.ts`'s "family"). This groups
 * `baseRows` together with every sibling row `loadProjectSiblingRows` finds
 * using the SAME project-key formula the funding index uses
 * (`groupGrantsByProject`), with no suppression filtering — this is an
 * internal admin report, not the public search index.
 */
async function resolveInvestigatorsByGrantId(
  baseRows: readonly DistinctGrantBaseRow[],
): Promise<Map<string, ReadonlyArray<{ cwid: string; name: string }>>> {
  const result = new Map<string, ReadonlyArray<{ cwid: string; name: string }>>();
  if (baseRows.length === 0) return result;

  const siblingRows = await loadProjectSiblingRows(baseRows);
  const grouped = groupGrantsByProject<DistinctGrantBaseRow | ProjectKeyRow>(
    [...baseRows, ...siblingRows],
    new Set(),
  );

  const cwidsByGrantId = new Map<string, string[]>();
  for (const group of grouped.values()) {
    const seen = new Set<string>();
    const dedupedCwids: string[] = [];
    for (const r of sortPeople(group)) {
      if (seen.has(r.cwid)) continue;
      seen.add(r.cwid);
      dedupedCwids.push(r.cwid);
    }
    for (const r of group) {
      if ("grantId" in r) cwidsByGrantId.set(r.grantId, dedupedCwids);
    }
  }
  // A grant whose externalId doesn't parse is dropped by groupGrantsByProject
  // (no project key) — fall back to that grant's own cwid alone rather than
  // dropping the row or throwing.
  for (const base of baseRows) {
    if (!cwidsByGrantId.has(base.grantId)) cwidsByGrantId.set(base.grantId, [base.cwid]);
  }

  const allCwids = new Set<string>();
  for (const cwids of cwidsByGrantId.values()) for (const c of cwids) allCwids.add(c);
  const scholars =
    allCwids.size === 0
      ? []
      : await db.read.scholar.findMany({
          where: { cwid: { in: Array.from(allCwids) } },
          select: { cwid: true, preferredName: true },
        });
  const nameByCwid = new Map(scholars.map((s) => [s.cwid, s.preferredName]));

  for (const [grantId, cwids] of cwidsByGrantId) {
    result.set(
      grantId,
      cwids.map((cwid) => ({ cwid, name: nameByCwid.get(cwid) ?? cwid })),
    );
  }
  return result;
}
