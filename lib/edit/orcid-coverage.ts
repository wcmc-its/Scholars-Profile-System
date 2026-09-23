/**
 * `/edit/orcid-coverage` — ORCID iD and eRA-profile coverage by person type
 * and by department, over active scholars. Aggregates only; never a per-person
 * list (`SCHOLAR_EXPORT_CAP` in `lib/api/export-scholars.ts` is policy).
 *
 * Definitions, because the copy on the page repeats them:
 *  - "Asserted ORCID" = `scholar.orcid` is set (WCM Identity, #2675/#2676, or
 *    confirmed in `/edit`) OR an RPM administrator entered one
 *    (`orcid_candidate.source = rpm_admin`). Identity is never NULLed on
 *    absence — it may lag ED. "Confirmed" is the subset the person (or someone
 *    editing for them) confirmed in `/edit`: `scholar.orcid_confirmed_at` set;
 *    the rest of asserted is Identity / RPM-admin.
 *  - Dismissed (cwid, iD) pairs (`orcid_dismissal`: Remove in `/edit`) count
 *    nowhere — not as a candidate row (the mirrors re-create them nightly) and
 *    not as `scholar.orcid` (a contradiction `etl:orcid-push` also refuses).
 *  - "Inferred" = a candidate ORCID in `orcid_candidate` from either mirror:
 *    the ReCiter Publication Manager saw it on the person's PubMed author
 *    record across articles they accepted (`source = rpm_inferred`, nightly),
 *    or the public ORCID registry sweep matched a WCM-affiliated record to the
 *    person (`etl/orcid-registry`, weekly): by a public WCM email on the record
 *    (`orcid_email`), by name plus ≥3 works shared with the person's own
 *    publications and no other scholar sharing ≥3 (`orcid_works`,
 *    `articles_accepted` = the shared count), or by name alone with 0–2 shared
 *    works or an ambiguous overlap (`orcid_name`). `articles_rejected` is 0 on
 *    every registry row. STRONG = exactly one distinct strong-eligible ORCID
 *    across the person's rows, where strong-eligible is: any `orcid_email` row;
 *    an `orcid_works` row with ≥ STRONG_MIN_ACCEPTED shared works; the SOLE
 *    `rpm_inferred` row when it has ≥ STRONG_MIN_ACCEPTED accepted articles and
 *    no rejected one; or an ORCID that an `rpm_*` row with NO rejected article
 *    and an `orcid_*` row agree on (two independent sources, so the accepted
 *    counts no longer matter — but an RPM row with rejections saw the iD on
 *    articles the person REJECTED, a homonym's iD, and a registry name hit on
 *    that same iD is the same homonym, not a second witness). WEAK =
 *    no single strong candidate: a name-only registry match, thin support, a
 *    contradiction, or two or more strong candidate ORCIDs (a second candidate
 *    that is NOT strong-eligible — a homonym's name-only iD beside a
 *    well-supported RPM one — does not demote). Tiers are exclusive:
 *    asserted > strong > weak > none. Inferred ORCIDs never reach the public
 *    profile; the outreach ask is "is this yours? confirm it".
 *    `orcid_candidate`'s key is (cwid, orcid, source): the RPM and registry
 *    mirrors write disjoint rows, so one iD seen by both is two rows for the
 *    cwid — that is what the agreement rule reads.
 *  - "eRA account" = a preferred `person_nih_profile` row: the RePORTER
 *    `profile_id`. Inferred, and the inference is one-directional — nobody is
 *    listed as a PI in RePORTER without an eRA Commons account, but RePORTER
 *    lists PIs only, so a Co-I / key person on someone else's award has an
 *    account we can never see. That is why the gap column is "NIH PI, no eRA
 *    account" (a resolver miss, #2651 — actionable) rather than every
 *    NIH-funded person. The eRA Commons *username* has no source anywhere
 *    (Identity, InfoEd, RePORTER all probed 2026-09-18) and is not a column.
 *  - "NIH-funded" = any `grant` row for the cwid with `nih_ic` set (`nihIc` is
 *    populated only for NIH awards); "current" additionally needs an award
 *    whose `end_date` is today or later.
 *
 * Who is counted: the shared person filter (`lib/edit/person-filter.ts`) —
 * repeated `type` (raw roleCategory) and repeated `unit` (`dept:` / `div:` /
 * `center:` / `inst:` + CODE), the Profiles roster's vocabulary. `unit`
 * narrows BOTH tables and is resolved by `personFilterSql` (one extra cwid
 * read, only when set); `type` narrows the department table only — the
 * person-type table IS the type breakdown. The department table still groups
 * by `scholar.primary_department` (the NAME); only the filter changed.
 *
 * Five flat reads + one pure fold (`buildOrcidCoverage`), so the fold is
 * testable on a fixture with no DB. ~11k scholar rows; no cache.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { parsePersonFilter, personFilterCriteria, personFilterSql } from "@/lib/edit/person-filter";
import { PI_ROLES } from "@/lib/funding-roles";
import { formatRoleCategory } from "@/lib/role-display";

export const NIH_FILTERS = ["all", "ever", "current", "none"] as const;
export type NihFilter = (typeof NIH_FILTERS)[number];

export const NIH_FILTER_LABELS: Record<NihFilter, string> = {
  all: "Everyone",
  ever: "NIH-funded (any award on file)",
  current: "NIH-funded (award ending today or later)",
  none: "No NIH award on file",
};

/** The department table's default population on a bare visit — the outreach
 *  list NIH's ORCID-for-SciENcv rule is about. The person-type table ignores
 *  `type` (it IS the type breakdown). */
export const DEFAULT_ROLE = "full_time_faculty";

export type OrcidCoverageParams = {
  /** Raw roleCategory values (`type`); empty = every person type. */
  types: string[];
  /** Raw `unit` values (`dept:CODE` / `div:CODE` / `center:CODE` / `inst:CODE`);
   *  empty = everyone. Undecodable-only values match nothing (`personFilterSql`). */
  units: string[];
  nih: NihFilter;
};

/** `type` / `unit` via `parsePersonFilter`; an unknown `nih` falls back to `all`.
 *  A BARE visit (none of `type`, `unit`, `nih`, `role` in the URL) defaults the
 *  department table to full-time faculty; any form submit carries `nih`, so an
 *  empty type selection there means every type. Legacy links: a single
 *  `role=X` reads as `type=X` (`role=all` = every type) when no `type` is
 *  given; `dept=` (a department NAME) is ignored — use `unit=dept:CODE` — and
 *  `ignoredLegacyDept` says so, for the page's one-line notice. */
export function parseOrcidCoverageParams(
  raw: Record<string, string | string[] | undefined> | URLSearchParams,
): OrcidCoverageParams & { ignoredLegacyDept: boolean } {
  const has = (k: string) => (raw instanceof URLSearchParams ? raw.has(k) : raw[k] !== undefined);
  const first = (k: string) => {
    const v = raw instanceof URLSearchParams ? raw.get(k) : raw[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s?.trim() || undefined;
  };
  const person = parsePersonFilter(raw);
  const role = first("role");
  const nih = first("nih") ?? "all";
  const bare = !["type", "unit", "nih", "role"].some(has);
  return {
    types:
      person.types.length > 0
        ? person.types
        : role !== undefined
          ? role === "all"
            ? []
            : [role]
          : bare
            ? [DEFAULT_ROLE]
            : [],
    units: person.unitValues,
    nih: (NIH_FILTERS as readonly string[]).includes(nih) ? (nih as NihFilter) : "all",
    ignoredLegacyDept: first("dept") !== undefined,
  };
}

/** The phone sheet trigger's "Filters (n)": one per who-filter selection, plus
 *  one for a non-"all" NIH filter. */
export function orcidCoverageActiveFilters(params: OrcidCoverageParams): number {
  return params.types.length + params.units.length + (params.nih === "all" ? 0 : 1);
}

/** `?type=…&unit=…&nih=…` — the page and its CSV route share it. Always carries
 *  `nih`, so an empty type selection round-trips as "every type" rather than
 *  falling back to the bare-visit default. */
export function orcidCoverageQuery(params: OrcidCoverageParams): string {
  const q = new URLSearchParams();
  for (const t of params.types) q.append("type", t);
  for (const u of params.units) q.append("unit", u);
  q.set("nih", params.nih);
  return `?${q.toString()}`;
}

export type ScholarRow = {
  cwid: string;
  roleCategory: string | null;
  primaryDepartment: string | null;
  orcid: string | null;
  /** Set when the person confirmed `orcid` in `/edit`; null for an Identity value. */
  orcidConfirmedAt: Date | null;
};
export type CandidateRow = {
  cwid: string;
  /** The candidate iD itself — the fold counts DISTINCT iDs and cross-references
   *  the RPM and registry sources on it. `(cwid, orcid, source)` is the table's PK,
   *  so an `rpm_*` row and an `orcid_*` row can carry the same iD for one cwid. */
  orcid: string;
  source: string;
  /** RPM: accepted articles carrying the iD. Registry (`orcid_works` / `orcid_name`):
   *  works shared between the record and the person's publications. */
  articlesAccepted: number;
  articlesRejected: number;
};
/** One `orcid_dismissal` row: the person removed this iD, or said it is not theirs. */
export type DismissalRow = { cwid: string; orcid: string };

/** Drops every row whose (cwid, iD) pair the person dismissed. THE choke point for
 *  "a dismissed iD never comes back": the RPM mirror re-creates an `rpm_admin` row
 *  from `admin_orcid` every morning and the registry sweep re-finds its matches
 *  weekly, so every `orcid_candidate` reader (the `/edit` loader, this console)
 *  filters here rather than trusting the mirrors to forget. Pure; cwid compared
 *  lowercase like the ETLs. */
export function withoutDismissed<T extends { cwid: string; orcid: string }>(
  rows: readonly T[],
  dismissals: readonly DismissalRow[],
): T[] {
  if (dismissals.length === 0) return [...rows];
  const key = (cwid: string, orcid: string) => `${cwid.toLowerCase()}\u0000${orcid}`;
  const dismissed = new Set(dismissals.map((d) => key(d.cwid, d.orcid)));
  return rows.filter((r) => !dismissed.has(key(r.cwid, r.orcid)));
}
/** Support for an inference to count as strong: 3+ accepted articles carrying the
 *  ORCID (RPM), or 3+ shared works in the ORCID registry (`orcid_works`), or a
 *  public WCM email on the registry record (`orcid_email` — no count needed). */
export const STRONG_MIN_ACCEPTED = 3;
/** The self-edit home board's "Is this your ORCID iD?" row suggests at a lower bar
 *  than the console's strong tier: one accepted article carrying the iD at the
 *  scholar's own byline position (and none rejected, and no competing iD) is enough
 *  to ask, because the scholar is the one confirming. The console keeps 3. */
export const SUGGEST_MIN_ACCEPTED = 1;
export type OrcidTier = "asserted" | "strong" | "weak" | "none";

const isRpmSource = (source: string) => source.startsWith("rpm_");
const isRegistrySource = (source: string) => source.startsWith("orcid_");

/** What one scholar's candidate rows add up to. `orcid` is the iD to show: the
 *  RPM-admin iD when asserted, the sole strong-eligible iD when strong, else null.
 *  `accepted` is the RPM accepted-article count behind that iD (0 when the strength
 *  came from the registry alone), for the "seen on N of your accepted publications"
 *  line on the self-edit home board. `scholar.orcid` is folded in by the caller. */
export type OrcidVerdict = { tier: OrcidTier; orcid: string | null; accepted: number };

/** One tier per cwid from the candidate rows; `scholar.orcid` is folded in by the caller. */
export function orcidTiers(candidates: CandidateRow[]): Map<string, OrcidTier> {
  const byCwid = new Map<string, CandidateRow[]>();
  for (const c of candidates) {
    const b = byCwid.get(c.cwid);
    if (b) b.push(c);
    else byCwid.set(c.cwid, [c]);
  }
  const out = new Map<string, OrcidTier>();
  for (const [cwid, rows] of byCwid) out.set(cwid, orcidVerdict(rows).tier);
  return out;
}

/** The per-cwid fold behind `orcidTiers`, shared with the self-edit home board so
 *  the console and the "Is this your ORCID iD?" row can never disagree. `rows` are
 *  one scholar's candidate rows; empty → `none`. `minAccepted` is the support a
 *  sole RPM iD (or an `orcid_works` overlap) needs to be strong-eligible: the console
 *  passes the default (`STRONG_MIN_ACCEPTED`), the home row `SUGGEST_MIN_ACCEPTED`. */
export function orcidVerdict(
  rows: CandidateRow[],
  minAccepted: number = STRONG_MIN_ACCEPTED,
): OrcidVerdict {
  const rpmAccepted = (orcid: string) =>
    Math.max(0, ...rows.filter((r) => isRpmSource(r.source) && r.orcid === orcid).map((r) => r.articlesAccepted));
  if (rows.length === 0) return { tier: "none", orcid: null, accepted: 0 };
  const admin = rows.find((r) => r.source === "rpm_admin");
  if (admin) return { tier: "asserted", orcid: admin.orcid, accepted: rpmAccepted(admin.orcid) };
  // The RPM rule is unchanged: only a SOLE rpm_inferred row can be strong on
  // its own counts. The fold does not trust the ETL's thresholds either — an
  // orcid_works row under STRONG_MIN_ACCEPTED (which the sweep never writes)
  // still grades weak here.
  const inferred = rows.filter((r) => r.source === "rpm_inferred");
  const soleInferred = inferred.length === 1 ? inferred[0] : null;
  // Only rejection-free RPM rows take part in the agreement rule: an rpm_inferred
  // row with rejections means the iD also sat on articles the person REJECTED (a
  // homonym's iD), and a name-only registry hit on the same iD is that same
  // homonym, not independent evidence. rpm_admin rows carry 0 rejections anyway.
  const rpmOrcids = new Set(
    rows.filter((r) => isRpmSource(r.source) && r.articlesRejected === 0).map((r) => r.orcid),
  );
  const registryOrcids = new Set(
    rows.filter((r) => isRegistrySource(r.source)).map((r) => r.orcid),
  );
  const strongEligible = (r: CandidateRow) =>
    r.source === "orcid_email" ||
    (r.source === "orcid_works" && r.articlesAccepted >= minAccepted) ||
    (r === soleInferred && r.articlesRejected === 0 && r.articlesAccepted >= minAccepted) ||
    // Two independent sources agreeing on one iD outweighs either one's accepted counts.
    (rpmOrcids.has(r.orcid) && registryOrcids.has(r.orcid));
  const strongOrcids = new Set(rows.filter(strongEligible).map((r) => r.orcid));
  if (strongOrcids.size !== 1) return { tier: "weak", orcid: null, accepted: 0 };
  const [orcid] = strongOrcids;
  return { tier: "strong", orcid, accepted: rpmAccepted(orcid) };
}

/** One row per NIH-funded cwid; `latestEnd` = MAX(grant.end_date) among its NIH
 *  awards, `pi` = holds a `PI_ROLES` role on at least one of them. */
export type NihRow = { cwid: string; latestEnd: Date | null; pi: boolean };

export type CoverageCounts = {
  people: number;
  /** Asserted ORCID (confirmed in `/edit`, Identity, or RPM admin). */
  orcid: number;
  /** …of which confirmed in `/edit` (`orcid_confirmed_at`); `orcid - confirmed` is
   *  the Identity / RPM-admin remainder. */
  confirmed: number;
  /** Strong inference (RPM or ORCID registry), no asserted ORCID. */
  strong: number;
  /** Weak inference (RPM or ORCID registry), no asserted ORCID. */
  weak: number;
  /** Preferred eRA profile_id on file (= eRA Commons account, inferred). */
  era: number;
  both: number;
  nihPeople: number;
  nihOrcid: number;
  /** NIH-funded, no asserted ORCID, but a strong inference — the easy outreach. */
  nihStrong: number;
  /** NIH-funded as a PI (`PI_ROLES`) — the population RePORTER can resolve. */
  nihPi: number;
  /** …of whom with an eRA account. `nihPi - nihPiEra` is the resolver gap. */
  nihPiEra: number;
};
export type CoverageRow = CoverageCounts & { key: string | null; label: string };

export type OrcidCoverage = {
  params: OrcidCoverageParams;
  /** Always the unfiltered population — the three numbers anyone asks for. */
  tiles: { overall: CoverageCounts; fullTime: CoverageCounts; nihFullTime: CoverageCounts };
  /** Filtered by `unit` + `nih`; every person type; people desc. */
  byRole: CoverageRow[];
  /** Filtered by `type` + `unit` + `nih`; NIH-funded-without-ORCID desc (the action list). */
  byDept: CoverageRow[];
};

export const neither = (c: CoverageCounts) => c.people - c.orcid - c.era + c.both;
export const nihNoOrcid = (c: CoverageCounts) => c.nihPeople - c.nihOrcid;
export const piNoEra = (c: CoverageCounts) => c.nihPi - c.nihPiEra;
export const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);

const roleLabel = (key: string | null) => formatRoleCategory(key) ?? "Unclassified";

export function buildOrcidCoverage(
  scholars: ScholarRow[],
  nih: NihRow[],
  eraCwids: Iterable<string>,
  params: OrcidCoverageParams,
  today: Date,
  candidates: CandidateRow[] = [],
  dismissals: DismissalRow[] = [],
  /** cwids the `unit` selection matches (`personFilterSql`); null = no unit filter. */
  unitMatch: ReadonlySet<string> | null = null,
): OrcidCoverage {
  const tiers = orcidTiers(withoutDismissed(candidates, dismissals));
  // `scholar.orcid` counts unless the person dismissed that very iD.
  const heldOrcid = new Set(
    withoutDismissed(
      scholars.flatMap((s) => (s.orcid === null ? [] : [{ cwid: s.cwid, orcid: s.orcid }])),
      dismissals,
    ).map((s) => s.cwid),
  );
  const tierOf = (s: ScholarRow): OrcidTier =>
    heldOrcid.has(s.cwid) ? "asserted" : (tiers.get(s.cwid) ?? "none");
  const isConfirmed = (s: ScholarRow) => heldOrcid.has(s.cwid) && s.orcidConfirmedAt !== null;
  const nihEnd = new Map(nih.map((r) => [r.cwid, r.latestEnd]));
  const nihPi = new Set(nih.filter((r) => r.pi).map((r) => r.cwid));
  const era = new Set(eraCwids);
  const isNih = (s: ScholarRow) => nihEnd.has(s.cwid);
  const isCurrent = (s: ScholarRow) => {
    const end = nihEnd.get(s.cwid);
    return end != null && end.getTime() >= today.getTime();
  };
  const nihOk = (s: ScholarRow) =>
    params.nih === "all"
      ? true
      : params.nih === "ever"
        ? isNih(s)
        : params.nih === "current"
          ? isCurrent(s)
          : !isNih(s);

  const count = (rows: ScholarRow[]): CoverageCounts => {
    const c = {
      people: 0,
      orcid: 0,
      confirmed: 0,
      strong: 0,
      weak: 0,
      era: 0,
      both: 0,
      nihPeople: 0,
      nihOrcid: 0,
      nihStrong: 0,
      nihPi: 0,
      nihPiEra: 0,
    };
    for (const s of rows) {
      const t = tierOf(s);
      const o = t === "asserted";
      const e = era.has(s.cwid);
      c.people++;
      if (o) {
        c.orcid++;
        if (isConfirmed(s)) c.confirmed++;
      } else if (t === "strong") c.strong++;
      else if (t === "weak") c.weak++;
      if (e) c.era++;
      if (o && e) c.both++;
      if (isNih(s)) {
        c.nihPeople++;
        if (o) c.nihOrcid++;
        else if (t === "strong") c.nihStrong++;
        if (nihPi.has(s.cwid)) {
          c.nihPi++;
          if (e) c.nihPiEra++;
        }
      }
    }
    return c;
  };
  const group = (
    rows: ScholarRow[],
    key: (s: ScholarRow) => string | null,
    label: (k: string | null) => string,
  ) => {
    const buckets = new Map<string | null, ScholarRow[]>();
    for (const s of rows) {
      const k = key(s);
      const b = buckets.get(k);
      if (b) b.push(s);
      else buckets.set(k, [s]);
    }
    return [...buckets].map(([k, b]) => ({ key: k, label: label(k), ...count(b) }));
  };

  const fullTime = scholars.filter((s) => s.roleCategory === DEFAULT_ROLE);
  const nihFiltered = scholars.filter(
    (s) => nihOk(s) && (unitMatch === null || unitMatch.has(s.cwid)),
  );
  const types = new Set(params.types);

  const byRole = group(
    nihFiltered,
    (s) => s.roleCategory,
    roleLabel,
  ).sort((a, b) => b.people - a.people || a.label.localeCompare(b.label));
  const byDept = group(
    nihFiltered.filter((s) => types.size === 0 || (s.roleCategory !== null && types.has(s.roleCategory))),
    (s) => s.primaryDepartment,
    (k) => k ?? "No department",
  ).sort(
    (a, b) =>
      nihNoOrcid(b) - nihNoOrcid(a) || b.people - a.people || a.label.localeCompare(b.label),
  );

  return {
    params,
    tiles: {
      overall: count(scholars),
      fullTime: count(fullTime),
      nihFullTime: count(fullTime.filter(isNih)),
    },
    byRole,
    byDept,
  };
}

export type OrcidCoverageClient = Pick<
  PrismaClient,
  "scholar" | "grant" | "personNihProfile" | "orcidCandidate" | "orcidDismissal" | "$queryRaw"
>;

export async function loadOrcidCoverage(
  db: OrcidCoverageClient,
  params: OrcidCoverageParams,
): Promise<OrcidCoverage> {
  const [scholars, nih, era, candidates, dismissals, unitRows] = await Promise.all([
    // Same population the Identity ETL writes to (`etl/identity/index.ts`),
    // narrowed to status=active like every other console aggregate.
    db.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: {
        cwid: true,
        roleCategory: true,
        primaryDepartment: true,
        orcid: true,
        orcidConfirmedAt: true,
      },
    }),
    db.grant.groupBy({
      by: ["cwid", "role"],
      where: { nihIc: { not: null } },
      _max: { endDate: true },
    }),
    db.personNihProfile.findMany({ where: { isPreferred: true }, select: { cwid: true } }),
    db.orcidCandidate.findMany({
      select: {
        cwid: true,
        orcid: true,
        source: true,
        articlesAccepted: true,
        articlesRejected: true,
      },
    }),
    db.orcidDismissal.findMany({ select: { cwid: true, orcid: true } }),
    // The unit selection, resolved by the shared rule; the type filter is a
    // plain role_category IN, applied in the fold (the person-type table
    // must not see it).
    params.units.length > 0
      ? db.$queryRaw<{ cwid: string }[]>`
          SELECT s.cwid FROM scholar s
           WHERE s.deleted_at IS NULL AND s.status = 'active'
           ${personFilterSql({ types: [], unitValues: params.units }, { scholar: "s", centerMembership: "cm" })}`
      : Promise.resolve(null),
  ]);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  // (cwid, role) rows → one NihRow per cwid.
  const byCwid = new Map<string, NihRow>();
  for (const r of nih) {
    const cur = byCwid.get(r.cwid) ?? { cwid: r.cwid, latestEnd: null, pi: false };
    const end = r._max.endDate;
    if (end && (cur.latestEnd === null || end > cur.latestEnd)) cur.latestEnd = end;
    if ((PI_ROLES as readonly string[]).includes(r.role)) cur.pi = true;
    byCwid.set(r.cwid, cur);
  }
  return buildOrcidCoverage(
    scholars,
    [...byCwid.values()],
    era.map((r) => r.cwid),
    params,
    today,
    candidates,
    dismissals,
    unitRows === null ? null : new Set(unitRows.map((r) => r.cwid)),
  );
}

export const CSV_HEADERS = [
  "Department",
  "People",
  "Asserted ORCID",
  "Confirmed ORCID",
  "Asserted %",
  "Inferred ORCID (strong)",
  "Inferred ORCID (weak)",
  "eRA account (inferred)",
  "Both",
  "Neither",
  "NIH-funded",
  "NIH-funded with asserted ORCID",
  "NIH-funded without asserted ORCID",
  "NIH-funded without asserted but strong inference",
  "NIH PI",
  "NIH PI without eRA account",
] as const;

/** The department table as CSV — aggregates only, no per-person rows. "Confirmed
 *  ORCID" is the confirmed-in-`/edit` subset of "Asserted ORCID". */
export function orcidCoverageCsv(rows: CoverageRow[]): string {
  return toCsv(
    CSV_HEADERS,
    rows.map((r) => [
      r.label,
      r.people,
      r.orcid,
      r.confirmed,
      r.people === 0 ? "" : ((100 * r.orcid) / r.people).toFixed(1),
      r.strong,
      r.weak,
      r.era,
      r.both,
      neither(r),
      r.nihPeople,
      r.nihOrcid,
      nihNoOrcid(r),
      r.nihStrong,
      r.nihPi,
      piNoEra(r),
    ]),
  );
}

/** The export's criteria block: every filter the table reflects, "All" when
 *  unset (the shared who-filter rows, `personFilterCriteria`). `labels` names
 *  each `unit` value (`unitLabels`); an unknown one prints raw. */
export function orcidCoverageCriteria(
  params: OrcidCoverageParams,
  generatedAt: Date,
  labels: ReadonlyMap<string, string> = new Map(),
): [string, string][] {
  return [
    ["Report", "ORCID coverage by department"],
    ["Generated", generatedAt.toISOString()],
    ...personFilterCriteria({ types: params.types, unitValues: params.units }, labels, (t) => roleLabel(t)),
    ["NIH funding", NIH_FILTER_LABELS[params.nih]],
  ];
}

/** The download: a two-column `Filter,Value` criteria block, ONE blank line,
 *  then the department table exactly as `orcidCoverageCsv` writes it. */
export function orcidCoverageExportCsv(rows: CoverageRow[], criteria: [string, string][]): string {
  return `${toCsv(["Filter", "Value"], criteria)}\r\n${orcidCoverageCsv(rows)}`;
}

const FILENAME_SUMMARY_MAX = 60;

/** `orcid-coverage-by-department-<filter summary>-<YYYY-MM-DD>.csv`. The
 *  summary (person types, units, NIH filter; "all" when none) is reduced to
 *  `[a-z0-9-]` and capped at 60 chars — safe inside the quoted
 *  Content-Disposition filename. */
export function orcidCoverageFilename(
  params: OrcidCoverageParams,
  generatedAt: Date,
  labels: ReadonlyMap<string, string> = new Map(),
): string {
  const parts = [
    ...params.types.map((t) => roleLabel(t)),
    ...params.units.map((u) => labels.get(u) ?? u),
    ...(params.nih === "all" ? [] : [params.nih === "none" ? "no-nih" : `nih-${params.nih}`]),
  ];
  const summary =
    parts
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, FILENAME_SUMMARY_MAX)
      .replace(/^-+|-+$/g, "") || "all";
  return `orcid-coverage-by-department-${summary}-${generatedAt.toISOString().slice(0, 10)}.csv`;
}
