/**
 * `/edit/reports/5` — "Clinical Trials" query.
 *
 * Lists every current Cancer Center member's clinical-trial links (Principal
 * Investigator or Investigator), sourced from `PersonClinicalTrial` joined to
 * `ClinicalTrial` — the same tables `getScholarFullProfileBySlug` reads for
 * the public profile's Clinical trials section (`lib/api/profile.ts`).
 *
 * Membership resolution mirrors the `/edit` roster convention — active
 * membership (`isCenterMembershipActive`) + non-deleted/`status: "active"`
 * Scholar, with NO `publicRoleWhere()` carve — the same "uncarved" posture
 * `countActiveCenterMembersByCode` documents for `/edit/units`: a center
 * curator needs to see and manage every member they administer, not just the
 * publicly-displayed subset. This is deliberately NOT the public
 * `buildCenterCollaboration` gate (`lib/api/center-collaboration.ts`), which
 * feeds an unauthenticated public route and carves #536-hidden roles.
 *
 * Two more differences from the public profile section, both deliberate for
 * an internal admin report:
 *   - No `CLINICAL_TRIALS_SECTION` gate. That flag dark-launches the PUBLIC
 *     profile section only (and is already "on" in every env —
 *     `cdk/lib/app-stack.ts`); the underlying ETL table is fair game for an
 *     authenticated admin report regardless of the public flag's state.
 *   - Withdrawn trials are NOT dropped (the public profile drops them via
 *     `isWithdrawnTrialStatus`). An admin report is a work tool — showing the
 *     full set of links beats a curated subset.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { isCenterMembershipActive, todayIso } from "@/lib/api/center-member-count";
import { isActiveTrialStatus } from "@/lib/api/profile";
import { extractLastNameSort } from "@/lib/name-sort";

/** The Prisma surface this query needs — a client or tx satisfies it. */
export type ClinicalTrialsReportClient = Pick<
  PrismaClient,
  "centerMembership" | "scholar" | "personClinicalTrial"
>;

/** One person↔trial link, ready to render as a report row. */
export type ClinicalTrialsReportRow = {
  cwid: string;
  personName: string;
  /** 'Principal Investigator' | 'Investigator' — raw `PersonClinicalTrial.role`. */
  role: string;
  protocolNumber: string;
  /** ClinicalTrials.gov NCT id; null when the trial has no NCT registration. */
  nctNumber: string | null;
  title: string;
  phase: string | null;
  principalSponsor: string | null;
  status: string | null;
  /** Coarse active/completed split, via the same `isActiveTrialStatus` the
   *  public profile section uses — drives the active-first sort. */
  isActive: boolean;
};

/**
 * Build the Clinical Trials report rows for a center: one row per
 * (member, trial) link, active-first then by the person's surname then by
 * trial title — the cleanest deterministic order given the fields (no date
 * on the join row itself to sort by; `ClinicalTrial.statusDate` is a trial
 * property, not a per-person one, so it is not a great tiebreaker here).
 *
 * Returns `[]` when the center has no active members, or none of them have a
 * trial link — the caller renders that as "no results", not a blank page.
 */
export async function loadClinicalTrialsReport(
  client: ClinicalTrialsReportClient,
  centerCode: string,
): Promise<ClinicalTrialsReportRow[]> {
  const today = todayIso();
  const memberships = await client.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true, startDate: true, endDate: true },
  });
  const activeCwids = [
    ...new Set(
      memberships
        .filter((m) => isCenterMembershipActive(m.startDate, m.endDate, today))
        .map((m) => m.cwid),
    ),
  ];
  if (activeCwids.length === 0) return [];

  const scholars = await client.scholar.findMany({
    where: { cwid: { in: activeCwids }, deletedAt: null, status: "active" },
    select: { cwid: true, preferredName: true },
  });
  if (scholars.length === 0) return [];
  const nameByCwid = new Map(scholars.map((s) => [s.cwid, s.preferredName]));

  const links = await client.personClinicalTrial.findMany({
    where: { cwid: { in: [...nameByCwid.keys()] } },
    include: { trial: true },
  });

  const rows: ClinicalTrialsReportRow[] = links.map((link) => ({
    cwid: link.cwid,
    personName: nameByCwid.get(link.cwid) ?? link.cwid,
    role: link.role,
    protocolNumber: link.protocolNumber,
    nctNumber: link.trial.nctNumber,
    title: link.trial.title,
    phase: link.trial.phase,
    principalSponsor: link.trial.principalSponsor,
    status: link.trial.status,
    isActive: isActiveTrialStatus(link.trial.status),
  }));

  rows.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const bySurname = extractLastNameSort(a.personName).localeCompare(
      extractLastNameSort(b.personName),
    );
    if (bySurname !== 0) return bySurname;
    return a.title.localeCompare(b.title);
  });

  return rows;
}
