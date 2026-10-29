/**
 * Which center publications count, and for which members and programs, over a
 * reporting period: the shared attribution behind the publication citation
 * report (18) and the collaborative publication matrix (19). DB-free; the
 * loader is `center-pub-attribution.server.ts`.
 *
 * PERIOD REPORTING (Jackie, 2026-10-29, Q2):
 *   - MEMBERS are the center's members of the chosen membership type whose
 *     membership is active ON THE REPORTING (as-of) DATE, default today
 *     (`isCenterMembershipActive`, so an invitee never counts).
 *   - PROGRAM is the member's `programCode` on that date, credited to every
 *     publication in the period. SPS keeps one stint per member and no
 *     program history, so this is the current program; a year-by-year
 *     historical view is not possible from what SPS holds.
 *   - A member's publication counts only if it was published while they were
 *     AT WCM. It may predate their center start date, but nothing from before
 *     they joined WCM or after they left.
 *   - The publication date is `Publication.dateAddedToEntrez`, else 1 January
 *     of `year` (as the other center reports date a publication).
 *
 * WCM TENURE SOURCE. SPS's `appointment` rows from the Enterprise Directory:
 * `ED` (the active faculty appointments) and `ED-HISTORICAL` (expired ones).
 * Tenure starts at the earliest start date among them; it is open while the
 * scholar holds any `ED` row (an active row's end date is a term end, not a
 * departure), otherwise it ends at the latest historical end date. Gaps
 * between stints are not modeled (ponytail: one window per scholar until a
 * leave-and-return case shows up). Probed on staging 2026-10-29 over the 342
 * research and clinical members: every member with a scholar row has an `ED`
 * row with a start date, and the earliest start agrees with reciterdb
 * `identity.startDateWCMFaculty` (a year) within a year for all but 4.
 * Rejected:
 *   - `ED-NYP` and `JENZABAR-GSFACULTY` rows: NYP is not WCM (Q1), and neither
 *     source carries a reliable start date.
 *   - reciterdb's per-article target-author affiliation match: 0 (no signal)
 *     on most accepted articles of these members, so it cannot say where an
 *     author was.
 * KNOWN GAP: a member who was a WCM postdoc, fellow or student before their
 * faculty appointment loses those years; no SPS source holds them.
 *
 * UNKNOWN TENURE (no `ED`/`ED-HISTORICAL` row with a start date): the member's
 * publications are INCLUDED, flagged `tenureUnknown`, and counted in the
 * result so a report can say how many it took on trust.
 */
import { isCenterMembershipActive } from "@/lib/api/center-member-count";
import { isReviewPublicationType, type PubRelevanceSource } from "@/lib/edit/pub-relevance-report";

/** The appointment sources that establish WCM tenure. */
export const WCM_TENURE_SOURCES = ["ED", "ED-HISTORICAL"] as const;

export type AttributionMembershipType = "research" | "clinical";

export type AttributionMembership = {
  cwid: string;
  programCode: string | null;
  membershipType: AttributionMembershipType | null;
  startDate: Date | null;
  endDate: Date | null;
  membershipRoleKey: string | null;
};

export type TenureAppointment = {
  cwid: string;
  source: string;
  startDate: Date | null;
  endDate: Date | null;
};

/** ISO dates; `end` null = still at WCM. */
export type WcmTenure = { start: string; end: string | null };

export type AttributionPublication = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  dateAddedToEntrez: Date | null;
  publicationType: string | null;
  /** Confirmed authors with a cwid. */
  authors: ReadonlyArray<{ cwid: string; name: string }>;
};

export type AttributedMember = {
  cwid: string;
  name: string;
  /** Program on the as-of date. */
  programCode: string | null;
  /** Counted without a known WCM tenure (see the module doc). */
  tenureUnknown: boolean;
};

export type AttributedPublication = {
  pmid: string;
  title: string;
  journal: string | null;
  /** The publication date the period is tested on, YYYY-MM-DD. */
  date: string;
  publicationType: string | null;
  isReview: boolean;
  /** Null = not decided yet (`etl/center-pub-relevance`). */
  relevant: boolean | null;
  relevanceSource: PubRelevanceSource | null;
  /** The credited members. Never empty. */
  members: AttributedMember[];
};

export type CenterPubAttribution = {
  asOf: string;
  from: string;
  to: string;
  publications: AttributedPublication[];
  /** Members active on the as-of date, of the chosen type. */
  memberCount: number;
  /** Of those, how many have no known WCM tenure. */
  unknownTenureMembers: number;
  /** Publications credited ONLY through members of unknown tenure. */
  unknownTenurePublications: number;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** One scholar's WCM tenure from their appointments, or null when unknown. */
export function wcmTenure(appointments: ReadonlyArray<TenureAppointment>): WcmTenure | null {
  const rows = appointments.filter((a) =>
    (WCM_TENURE_SOURCES as readonly string[]).includes(a.source),
  );
  const starts = rows.flatMap((a) => (a.startDate ? [iso(a.startDate)] : []));
  if (starts.length === 0) return null;
  const start = starts.reduce((a, b) => (b < a ? b : a));
  const open = rows.some((a) => a.source === "ED" || !a.endDate);
  const end = open
    ? null
    : rows.map((a) => iso(a.endDate as Date)).reduce((a, b) => (b > a ? b : a));
  return { start, end };
}

/** `dateAddedToEntrez`, else 1 January of `year`, else null. */
export function publicationDate(p: {
  dateAddedToEntrez: Date | null;
  year: number | null;
}): string | null {
  if (p.dateAddedToEntrez) return iso(p.dateAddedToEntrez);
  return p.year ? `${String(p.year).padStart(4, "0")}-01-01` : null;
}

export function withinTenure(date: string, t: WcmTenure): boolean {
  return date >= t.start && (t.end === null || date <= t.end);
}

/**
 * Attribute a center's publications over `[from, to]` (inclusive ISO dates)
 * to the members active on `asOf`, by the rules in the module doc.
 * `relevance` is the center's `center_publication_relevance` by pmid.
 */
export function attributeCenterPublications(input: {
  memberships: ReadonlyArray<AttributionMembership>;
  membershipType: AttributionMembershipType;
  asOf: string;
  from: string;
  to: string;
  appointments: ReadonlyArray<TenureAppointment>;
  publications: ReadonlyArray<AttributionPublication>;
  relevance: ReadonlyMap<string, { relevant: boolean; source: string }>;
}): CenterPubAttribution {
  const { asOf, from, to } = input;
  const members = new Map(
    input.memberships
      .filter((m) => m.membershipType === input.membershipType && isCenterMembershipActive(m, asOf))
      .map((m) => [m.cwid, m]),
  );
  const apptsByCwid = new Map<string, TenureAppointment[]>();
  for (const a of input.appointments)
    if (members.has(a.cwid)) apptsByCwid.set(a.cwid, [...(apptsByCwid.get(a.cwid) ?? []), a]);
  const tenure = new Map([...members.keys()].map((c) => [c, wcmTenure(apptsByCwid.get(c) ?? [])]));

  const publications: AttributedPublication[] = [];
  let unknownTenurePublications = 0;
  for (const p of input.publications) {
    const date = publicationDate(p);
    if (!date || date < from || date > to) continue;
    const credited: AttributedMember[] = [];
    for (const a of p.authors) {
      const m = members.get(a.cwid);
      if (!m || credited.some((c) => c.cwid === a.cwid)) continue;
      const t = tenure.get(a.cwid) ?? null;
      if (t && !withinTenure(date, t)) continue;
      credited.push({ cwid: a.cwid, name: a.name, programCode: m.programCode, tenureUnknown: !t });
    }
    if (credited.length === 0) continue;
    if (credited.every((c) => c.tenureUnknown)) unknownTenurePublications++;
    const r = input.relevance.get(p.pmid);
    publications.push({
      pmid: p.pmid,
      title: p.title,
      journal: p.journal,
      date,
      publicationType: p.publicationType,
      isReview: isReviewPublicationType(p.publicationType),
      relevant: r?.relevant ?? null,
      relevanceSource: (r?.source as PubRelevanceSource | undefined) ?? null,
      members: credited,
    });
  }
  return {
    asOf,
    from,
    to,
    publications,
    memberCount: members.size,
    unknownTenureMembers: [...tenure.values()].filter((t) => !t).length,
    unknownTenurePublications,
  };
}
