/**
 * `/edit/orcid-coverage` — ORCID iD and eRA-profile coverage by person type
 * and by department, over active scholars. Aggregates only; never a per-person
 * list (`SCHOLAR_EXPORT_CAP` in `lib/api/export-scholars.ts` is policy).
 *
 * Definitions, because the copy on the page repeats them:
 *  - "Asserted ORCID" = `scholar.orcid` is set (confirmed in Scholars, or an
 *    unconfirmed value WCM Identity's import wrote before Scholars became the
 *    authority). An iD a Publication Manager administrator typed in
 *    (`orcid_candidate.source = rpm_admin`) is a candidate, not asserted.
 *    "Confirmed" is the subset confirmed in Scholars: `scholar.orcid_confirmed_at`
 *    set; the rest of asserted is the legacy Identity import.
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
 *    works or an ambiguous overlap (`orcid_name`); or, for people the
 *    WCM-affiliated pool missed, by the iD publishers deposited in Crossref on
 *    ≥3 of the person's papers (`orcid_crossref`, `articles_accepted` = papers).
 *    `articles_rejected` is 0 on
 *    every registry row. STRONG = exactly one distinct strong-eligible ORCID
 *    across the person's rows, where strong-eligible is: any `orcid_email` row;
 *    any `infoed_biosketch` row (the iD on the person's NIH biosketch in InfoEd);
 *    an `infoed_biosketch_name` row (the same, but the biosketch was matched to the
 *    person by name) only when another non-name-only source names the same iD;
 *    an `orcid_works` or `orcid_crossref` row with ≥ STRONG_MIN_ACCEPTED papers; the SOLE
 *    `rpm_inferred` row when it has ≥ STRONG_MIN_ACCEPTED accepted articles and
 *    no rejected one; any `rpm_admin` or `identity` row (an iD already on file in
 *    Publication Manager or WCM Identity, so the scholar is asked to confirm it);
 *    or an ORCID that an `rpm_*` row with NO rejected article
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
 * Campus (`?campus=`): absent = WCM, and a WCM parse, fold, page and CSV are
 * exactly what they were before the campus steps. `ithaca` = Cornell Ithaca rows
 * only (`scholar.campus = 'ithaca'`, `status = 'external'`, the six
 * `ITHACA_ROLES`; etl/ithaca-roster writes the Cornell department NAME to
 * `primary_department`, so the department table groups on it unchanged). `all`
 * = both, side by side: every row carries its `campus`, `campuses` holds each
 * campus's tiles and person-type subtotal. Anything else falls back to WCM.
 * The NIH filter, the `unit` filter, the eRA and the NIH counts are WCM
 * concepts (no Cornell award, eRA or org-unit data is loaded): they never
 * narrow or count Cornell Ithaca rows. On `ithaca` the parser drops `nih` /
 * `unit`; on `all` they narrow the WCM half only. `type` is literal on every
 * campus (a WCM-only selection leaves no Ithaca department).
 *
 * "Open authorship rows waiting" (`waitingRows`): reciterdb's `authorship_review`
 * holds candidate authorships from Scopus and OpenAlex awaiting a curator, and a
 * row can carry the ORCID iD the source attaches to that byline author.
 * `etl/orcid-authorship-impact` copies, nightly, how many OPEN rows carry each
 * iD (`orcid_open_authorship`: iD and count, no person). For each counted person
 * the fold sums those counts over the person's iDs that are NOT yet confirmed
 * in Scholars: their non-dismissed `orcid_candidate` iDs, plus `scholar.orcid`
 * when it is set but unconfirmed. Each (person, iD) counts once, however many
 * candidate sources name the iD. A person whose iD is already confirmed
 * contributes 0: nothing is waiting on a confirmation. An iD that is a candidate
 * for two people counts for both. `waitingPeople` = people with at least one
 * such row. The tile is the person-type table's total (campus + `unit` + `nih`,
 * every person type). When the table is empty or its `refreshed_at` is older
 * than `OPEN_AUTHORSHIP_MAX_AGE_HOURS`, the fold is given no impact data and the
 * tile, the columns and the CSV column are all absent (never a zero that looks
 * like data): the page and CSV are then exactly what they were without it.
 *
 * Six flat reads + one pure fold (`buildOrcidCoverage`), so the fold is
 * testable on a fixture with no DB. ~11k scholar rows; no cache.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { parsePersonFilter, personFilterCriteria, personFilterSql } from "@/lib/edit/person-filter";
import { ITHACA_ROLES } from "@/lib/eligibility";
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

/** A scholar row's campus. */
export type Campus = "wcm" | "ithaca";
/** The `?campus=` views: one campus, or `all` = both side by side. */
export type CampusView = Campus | "all";

export const CAMPUS_LABELS: Record<Campus, string> = {
  wcm: "Weill Cornell Medicine",
  ithaca: "Cornell Ithaca",
};

/** The Ithaca headline tile's population, as `DEFAULT_ROLE` is WCM's. */
export const ITHACA_HEADLINE_ROLE = "ithaca_faculty";

export type OrcidCoverageParams = {
  /** Raw roleCategory values (`type`); empty = every person type. */
  types: string[];
  /** Raw `unit` values (`dept:CODE` / `div:CODE` / `center:CODE` / `inst:CODE`);
   *  empty = everyone. Undecodable-only values match nothing (`personFilterSql`). */
  units: string[];
  nih: NihFilter;
  /** `scholar.campus`: WCM (absent = WCM), Cornell Ithaca, or `all` = both. */
  campus?: CampusView;
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
  const bare = !["type", "unit", "nih", "role", "campus"].some(has);
  // Absent or unknown = WCM, so a WCM parse is exactly what it was before the Ithaca step.
  const rawCampus = first("campus");
  const campus = rawCampus === "ithaca" || rawCampus === "all" ? rawCampus : undefined;
  // `nih` and `unit` are WCM concepts: an Ithaca-only view drops them.
  const wcmFilters = campus !== "ithaca";
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
    units: wcmFilters ? person.unitValues : [],
    nih:
      wcmFilters && (NIH_FILTERS as readonly string[]).includes(nih) ? (nih as NihFilter) : "all",
    ...(campus ? { campus } : {}),
    ignoredLegacyDept: first("dept") !== undefined,
  };
}

/** The phone sheet trigger's "Filters (n)": one per who-filter selection, plus
 *  one for a non-"all" NIH filter. */
export function orcidCoverageActiveFilters(params: OrcidCoverageParams): number {
  return (
    params.types.length +
    params.units.length +
    (params.nih === "all" ? 0 : 1) +
    (params.campus === "ithaca" || params.campus === "all" ? 1 : 0)
  );
}

/** `?type=…&unit=…&nih=…` — the page and its CSV route share it. Always carries
 *  `nih`, so an empty type selection round-trips as "every type" rather than
 *  falling back to the bare-visit default. */
export function orcidCoverageQuery(params: OrcidCoverageParams): string {
  const q = new URLSearchParams();
  for (const t of params.types) q.append("type", t);
  for (const u of params.units) q.append("unit", u);
  q.set("nih", params.nih);
  if (params.campus === "ithaca" || params.campus === "all") q.set("campus", params.campus);
  return `?${q.toString()}`;
}

export type ScholarRow = {
  cwid: string;
  roleCategory: string | null;
  primaryDepartment: string | null;
  orcid: string | null;
  /** Set when the person confirmed `orcid` in `/edit`; null for an Identity value. */
  orcidConfirmedAt: Date | null;
  /** `scholar.campus`. Read only for `campus=all`, where the fold splits on it
   *  (`ithaca` vs everything else); a one-campus fold takes it from the params. */
  campus?: string;
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
/** The self-edit home board's "Confirm your ORCID iD" row suggests at a lower bar
 *  than the console's strong tier: one accepted article carrying the iD at the
 *  scholar's own byline position (and none rejected, and no competing iD) is enough
 *  to ask, because the scholar is the one confirming. The console keeps 3. */
export const SUGGEST_MIN_ACCEPTED = 1;
export type OrcidTier = "asserted" | "strong" | "weak" | "none";

const isRpmSource = (source: string) => source.startsWith("rpm_");
const isRegistrySource = (source: string) => source.startsWith("orcid_");

/** What one scholar's candidate rows add up to. `orcid` is the iD to show: the
 *  sole strong-eligible iD when strong, else null. Never `asserted`: only
 *  `scholar.orcid` is, and the caller folds it in.
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
 *  the console and the "Confirm your ORCID iD" row can never disagree. `rows` are
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
    // Typed in by a Publication Manager administrator, or held in WCM Identity: an iD
    // a person or system already put on file elsewhere, so the scholar is asked to
    // confirm it. Neither is on file in Scholars by itself.
    r.source === "rpm_admin" ||
    r.source === "identity" ||
    // The iD on the person's own NIH biosketch (SciENcv fills it from their linked
    // ORCID account), tied to them by the SF424 profile email — etl/infoed-biosketch
    // writes only email-attributed rows.
    r.source === "infoed_biosketch" ||
    // Cornell's library mapped the NetID to the iD (Affiliation Manager): an
    // institutional assertion, so the Ithaca person is asked to confirm it.
    r.source === "cornell_affiliation_manager" ||
    // Matched to the person by name only, so a namesake's biosketch is possible: strong
    // only when another source names the same iD — not another name-only match, and not
    // an RPM row that also sat on articles the person rejected.
    (r.source === "infoed_biosketch_name" &&
      rows.some(
        (o) =>
          o.orcid === r.orcid &&
          o.source !== "infoed_biosketch_name" &&
          o.source !== "orcid_name" &&
          !(isRpmSource(o.source) && o.articlesRejected > 0),
      )) ||
    ((r.source === "orcid_works" || r.source === "orcid_crossref") && r.articlesAccepted >= minAccepted) ||
    (r === soleInferred && r.articlesRejected === 0 && r.articlesAccepted >= minAccepted) ||
    // Two independent sources agreeing on one iD outweighs either one's accepted counts.
    (rpmOrcids.has(r.orcid) && registryOrcids.has(r.orcid));
  const strongOrcids = new Set(rows.filter(strongEligible).map((r) => r.orcid));
  if (strongOrcids.size !== 1) return { tier: "weak", orcid: null, accepted: 0 };
  const [orcid] = strongOrcids;
  return { tier: "strong", orcid, accepted: rpmAccepted(orcid) };
}

/** One `orcid_open_authorship` row: how many open authorship rows carry this iD. */
export type OpenAuthorshipRow = { orcid: string; openRows: number; refreshedAt: Date };
/** Open rows per iD (bare, upper-case), and when the copy was taken. */
export type OpenAuthorshipImpact = { byOrcid: ReadonlyMap<string, number>; refreshedAt: Date };

/** Older than this, the open-row counts are not shown at all. */
export const OPEN_AUTHORSHIP_MAX_AGE_HOURS = 48;

/** Bare, upper-case iD: `https://orcid.org/0000-…-000x` → `0000-…-000X`. */
const bareOrcid = (orcid: string) =>
  orcid
    .trim()
    .replace(/^https?:\/\/orcid\.org\//i, "")
    .toUpperCase();

/** The open-row counts the fold may use, or null when there is nothing to show:
 *  the table is empty, or its newest `refreshedAt` is more than
 *  `OPEN_AUTHORSHIP_MAX_AGE_HOURS` before `now`. Pure. */
export function openAuthorshipImpact(
  rows: readonly OpenAuthorshipRow[],
  now: Date,
): OpenAuthorshipImpact | null {
  if (rows.length === 0) return null;
  const refreshedAt = new Date(Math.max(...rows.map((r) => r.refreshedAt.getTime())));
  if (now.getTime() - refreshedAt.getTime() > OPEN_AUTHORSHIP_MAX_AGE_HOURS * 3_600_000)
    return null;
  const byOrcid = new Map<string, number>();
  for (const r of rows) {
    const k = bareOrcid(r.orcid);
    byOrcid.set(k, (byOrcid.get(k) ?? 0) + r.openRows);
  }
  return { byOrcid, refreshedAt };
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
/** Set on table rows and totals only when the fold was given open-row counts. */
export type WaitingCounts = {
  /** Open authorship rows carrying an iD these people have not yet confirmed. */
  waitingRows?: number;
  /** …and how many of these people have at least one such row. */
  waitingPeople?: number;
};
export type CoverageRow = CoverageCounts &
  WaitingCounts & {
    key: string | null;
    label: string;
    /** Set on every row of a `campus=all` fold, and only there. */
    campus?: Campus;
  };
export type CoverageTiles = {
  overall: CoverageCounts;
  /** The headline population: WCM full-time faculty (`DEFAULT_ROLE`), or Cornell
   *  Ithaca faculty (`ITHACA_HEADLINE_ROLE`); on `campus=all`, both. */
  fullTime: CoverageCounts;
  /** WCM only — all zero for Cornell Ithaca (no award data), which shows no such tile. */
  nihFullTime: CoverageCounts;
};
/** One campus of a `campus=all` fold. */
export type CampusCoverage = {
  campus: Campus;
  label: string;
  /** Unfiltered, like the top-level tiles. */
  tiles: CoverageTiles;
  /** The campus's person-type rows summed: the subtotal row. */
  total: CoverageCounts & WaitingCounts;
};

export type OrcidCoverage = {
  params: OrcidCoverageParams;
  /** Always the unfiltered population — the three numbers anyone asks for. */
  tiles: CoverageTiles;
  /** Filtered by `unit` + `nih`; every person type; people desc. Cornell Ithaca:
   *  `ITHACA_ROLES` order. `campus=all`: WCM's rows, then Cornell Ithaca's. */
  byRole: CoverageRow[];
  /** Filtered by `type` + `unit` + `nih`; NIH-funded-without-ORCID desc (the action list).
   *  `campus=all`: both campuses' departments, people desc. */
  byDept: CoverageRow[];
  /** `campus=all` only: WCM then Cornell Ithaca. */
  campuses?: CampusCoverage[];
  /** Present only when open-row counts are fresh enough to show: the person-type
   *  table's total (campus + `unit` + `nih`, every person type). */
  impact?: { refreshedAt: Date; rows: number; people: number };
  /** People (active, unfiltered) behind each inference rule, for the "Where
   *  inferences come from" panel. Counts overlap — one person can match several
   *  rules — and are NOT tiers: the fold still gives each person one tier. */
  sources: InferenceSourceCounts;
};

/** Distinct people with a (non-dismissed) candidate row matching each rule. */
export type InferenceSourceCounts = {
  /** `rpm_inferred` with `STRONG_MIN_ACCEPTED`+ accepted articles and none rejected. */
  rpmStrong: number;
  /** `rpm_inferred`, but no row meeting the strong rule. */
  rpmWeak: number;
  /** `orcid_email`: a public email on the registry record belongs to the person. */
  registryEmail: number;
  /** `orcid_works` with `STRONG_MIN_ACCEPTED`+ shared works. */
  registryWorks: number;
  /** `orcid_crossref` with `STRONG_MIN_ACCEPTED`+ papers carrying the iD in Crossref. */
  registryCrossref: number;
  /** `orcid_name`, or an `orcid_works` row under the strong bar, and no strong registry row. */
  registryWeak: number;
};

/** Pure: the per-rule people counts behind {@link OrcidCoverage.sources}. */
export function inferenceSourceCounts(
  candidates: readonly CandidateRow[],
  population: ReadonlySet<string>,
): InferenceSourceCounts {
  const sets = {
    rpmStrong: new Set<string>(),
    rpmAny: new Set<string>(),
    registryEmail: new Set<string>(),
    registryWorks: new Set<string>(),
    registryCrossref: new Set<string>(),
    registryAny: new Set<string>(),
  };
  for (const c of candidates) {
    if (!population.has(c.cwid)) continue;
    if (c.source === "rpm_inferred") {
      sets.rpmAny.add(c.cwid);
      if (c.articlesAccepted >= STRONG_MIN_ACCEPTED && c.articlesRejected === 0)
        sets.rpmStrong.add(c.cwid);
    } else if (isRegistrySource(c.source)) {
      sets.registryAny.add(c.cwid);
      if (c.source === "orcid_email") sets.registryEmail.add(c.cwid);
      else if (c.source === "orcid_works" && c.articlesAccepted >= STRONG_MIN_ACCEPTED)
        sets.registryWorks.add(c.cwid);
      else if (c.source === "orcid_crossref" && c.articlesAccepted >= STRONG_MIN_ACCEPTED)
        sets.registryCrossref.add(c.cwid);
    }
  }
  const registryStrong = new Set([...sets.registryEmail, ...sets.registryWorks, ...sets.registryCrossref]);
  return {
    rpmStrong: sets.rpmStrong.size,
    rpmWeak: [...sets.rpmAny].filter((c) => !sets.rpmStrong.has(c)).length,
    registryEmail: sets.registryEmail.size,
    registryWorks: sets.registryWorks.size,
    registryCrossref: sets.registryCrossref.size,
    registryWeak: [...sets.registryAny].filter((c) => !registryStrong.has(c)).length,
  };
}

export const neither = (c: CoverageCounts) => c.people - c.orcid - c.era + c.both;
export const nihNoOrcid = (c: CoverageCounts) => c.nihPeople - c.nihOrcid;
export const piNoEra = (c: CoverageCounts) => c.nihPi - c.nihPiEra;
export const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);

const roleLabel = (key: string | null) => formatRoleCategory(key) ?? "Unclassified";

const addCounts = (
  a: CoverageCounts & WaitingCounts,
  b: CoverageCounts & WaitingCounts,
): CoverageCounts & WaitingCounts => ({
  people: a.people + b.people,
  orcid: a.orcid + b.orcid,
  confirmed: a.confirmed + b.confirmed,
  strong: a.strong + b.strong,
  weak: a.weak + b.weak,
  era: a.era + b.era,
  both: a.both + b.both,
  nihPeople: a.nihPeople + b.nihPeople,
  nihOrcid: a.nihOrcid + b.nihOrcid,
  nihStrong: a.nihStrong + b.nihStrong,
  nihPi: a.nihPi + b.nihPi,
  nihPiEra: a.nihPiEra + b.nihPiEra,
  ...(a.waitingRows !== undefined || b.waitingRows !== undefined
    ? {
        waitingRows: (a.waitingRows ?? 0) + (b.waitingRows ?? 0),
        waitingPeople: (a.waitingPeople ?? 0) + (b.waitingPeople ?? 0),
      }
    : {}),
});

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
  /** Open authorship rows per iD (`openAuthorshipImpact`); null = show nothing. */
  impact: OpenAuthorshipImpact | null = null,
): OrcidCoverage {
  const liveCandidates = withoutDismissed(candidates, dismissals);
  const tiers = orcidTiers(liveCandidates);
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
  // Open rows waiting on a confirmation, per person: the person's unconfirmed iDs
  // (a Set, so an iD several sources name counts once) summed over `impact`.
  const waitingByCwid = new Map<string, number>();
  if (impact !== null) {
    const ids = new Map<string, Set<string>>();
    const add = (cwid: string, orcid: string) => {
      const k = cwid.toLowerCase();
      const set = ids.get(k);
      if (set) set.add(bareOrcid(orcid));
      else ids.set(k, new Set([bareOrcid(orcid)]));
    };
    for (const c of liveCandidates) add(c.cwid, c.orcid);
    for (const s of scholars)
      if (s.orcid !== null && heldOrcid.has(s.cwid) && s.orcidConfirmedAt === null)
        add(s.cwid, s.orcid);
    for (const [cwid, set] of ids) {
      let n = 0;
      for (const orcid of set) n += impact.byOrcid.get(orcid) ?? 0;
      if (n > 0) waitingByCwid.set(cwid, n);
    }
  }
  // A confirmed iD means nothing is waiting on this person, whatever else is on file.
  const waitingOf = (s: ScholarRow) =>
    isConfirmed(s) ? 0 : (waitingByCwid.get(s.cwid.toLowerCase()) ?? 0);
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

  // `wcmFacts` = count the eRA and NIH columns; false for Cornell Ithaca rows, where
  // nothing feeds them (a cwid string shared with an old WCM grant must not either).
  const count = (rows: ScholarRow[], wcmFacts = true): CoverageCounts & WaitingCounts => {
    let waitingRows = 0;
    let waitingPeople = 0;
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
      const e = wcmFacts && era.has(s.cwid);
      const w = waitingOf(s);
      waitingRows += w;
      if (w > 0) waitingPeople++;
      c.people++;
      if (o) {
        c.orcid++;
        if (isConfirmed(s)) c.confirmed++;
      } else if (t === "strong") c.strong++;
      else if (t === "weak") c.weak++;
      if (e) c.era++;
      if (o && e) c.both++;
      if (wcmFacts && isNih(s)) {
        c.nihPeople++;
        if (o) c.nihOrcid++;
        else if (t === "strong") c.nihStrong++;
        if (nihPi.has(s.cwid)) {
          c.nihPi++;
          if (e) c.nihPiEra++;
        }
      }
    }
    return impact === null ? c : { ...c, waitingRows, waitingPeople };
  };
  const types = new Set(params.types);
  const ithacaRank = (key: string | null) => {
    const i = (ITHACA_ROLES as readonly string[]).indexOf(key ?? "");
    return i === -1 ? ITHACA_ROLES.length : i;
  };

  /** One campus's tiles and tables. `tag` stamps `campus` on every row (`campus=all`). */
  const foldCampus = (campus: Campus, pop: ScholarRow[], tag: boolean) => {
    const wcm = campus === "wcm";
    const group = (
      rows: ScholarRow[],
      key: (s: ScholarRow) => string | null,
      label: (k: string | null) => string,
    ): CoverageRow[] => {
      const buckets = new Map<string | null, ScholarRow[]>();
      for (const s of rows) {
        const k = key(s);
        const b = buckets.get(k);
        if (b) b.push(s);
        else buckets.set(k, [s]);
      }
      return [...buckets].map(([k, b]) => ({
        key: k,
        label: label(k),
        ...count(b, wcm),
        ...(tag ? { campus } : {}),
      }));
    };
    const headline = pop.filter(
      (s) => s.roleCategory === (wcm ? DEFAULT_ROLE : ITHACA_HEADLINE_ROLE),
    );
    // The NIH and unit filters are WCM concepts: they never narrow Cornell Ithaca.
    const filtered = wcm
      ? pop.filter((s) => nihOk(s) && (unitMatch === null || unitMatch.has(s.cwid)))
      : pop;
    const byRole = group(filtered, (s) => s.roleCategory, roleLabel).sort(
      (a, b) =>
        (wcm ? 0 : ithacaRank(a.key) - ithacaRank(b.key)) ||
        b.people - a.people ||
        a.label.localeCompare(b.label),
    );
    const byDept = group(
      filtered.filter(
        (s) => types.size === 0 || (s.roleCategory !== null && types.has(s.roleCategory)),
      ),
      (s) => s.primaryDepartment,
      (k) => k ?? "No department",
    ).sort(
      (a, b) =>
        nihNoOrcid(b) - nihNoOrcid(a) || b.people - a.people || a.label.localeCompare(b.label),
    );
    return {
      tiles: {
        overall: count(pop, wcm),
        fullTime: count(headline, wcm),
        nihFullTime: count(wcm ? headline.filter(isNih) : [], wcm),
      },
      total: count(filtered, wcm),
      byRole,
      byDept,
    };
  };
  const sources = inferenceSourceCounts(liveCandidates, new Set(scholars.map((s) => s.cwid)));
  const shown = (total: CoverageCounts & WaitingCounts) =>
    impact === null
      ? {}
      : {
          impact: {
            refreshedAt: impact.refreshedAt,
            rows: total.waitingRows ?? 0,
            people: total.waitingPeople ?? 0,
          },
        };

  if (params.campus === "all") {
    const isIthaca = (s: ScholarRow) => s.campus === "ithaca";
    const parts = (["wcm", "ithaca"] as const).map((campus) => ({
      campus,
      label: CAMPUS_LABELS[campus],
      ...foldCampus(
        campus,
        scholars.filter((s) => isIthaca(s) === (campus === "ithaca")),
        true,
      ),
    }));
    const [w, i] = parts;
    return {
      params,
      tiles: {
        overall: addCounts(w.tiles.overall, i.tiles.overall),
        fullTime: addCounts(w.tiles.fullTime, i.tiles.fullTime),
        nihFullTime: addCounts(w.tiles.nihFullTime, i.tiles.nihFullTime),
      },
      byRole: parts.flatMap((p) => p.byRole),
      // One list across campuses: the outreach column is WCM-only, so people desc.
      byDept: parts
        .flatMap((p) => p.byDept)
        .sort(
          (a, b) =>
            b.people - a.people ||
            a.label.localeCompare(b.label) ||
            Number(a.campus === "ithaca") - Number(b.campus === "ithaca"),
        ),
      campuses: parts.map(({ campus, label, tiles, total }) => ({ campus, label, tiles, total })),
      sources,
      ...shown(addCounts(w.total, i.total)),
    };
  }

  const one = foldCampus(params.campus === "ithaca" ? "ithaca" : "wcm", scholars, false);
  return {
    params,
    tiles: one.tiles,
    byRole: one.byRole,
    byDept: one.byDept,
    sources,
    ...shown(one.total),
  };
}

export type OrcidCoverageClient = Pick<
  PrismaClient,
  | "scholar"
  | "grant"
  | "personNihProfile"
  | "orcidCandidate"
  | "orcidDismissal"
  | "orcidOpenAuthorship"
  | "$queryRaw"
>;

/** The open-row counts. Garnish on this page: a failed read (the table not yet
 *  migrated, say) hides the tile and columns, it does not blank the coverage. */
async function readOpenAuthorship(db: OrcidCoverageClient): Promise<OpenAuthorshipRow[]> {
  try {
    return await db.orcidOpenAuthorship.findMany({
      select: { orcid: true, openRows: true, refreshedAt: true },
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "orcid_coverage_open_authorship_read_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }
}

export async function loadOrcidCoverage(
  db: OrcidCoverageClient,
  params: OrcidCoverageParams,
): Promise<OrcidCoverage> {
  const [scholars, nih, era, candidates, dismissals, unitRows, openAuthorship] = await Promise.all([
    // Same population the Identity ETL writes to (`etl/identity/index.ts`),
    // narrowed to status=active like every other console aggregate.
    db.scholar.findMany({
      where:
        params.campus === "ithaca"
          ? { deletedAt: null, campus: "ithaca", status: "external" }
          : params.campus === "all"
            ? {
                deletedAt: null,
                OR: [{ status: "active" }, { campus: "ithaca", status: "external" }],
              }
            : { deletedAt: null, status: "active" },
      select: {
        cwid: true,
        roleCategory: true,
        primaryDepartment: true,
        orcid: true,
        orcidConfirmedAt: true,
        // Only the two-campus fold splits on it; the one-campus reads are unchanged.
        ...(params.campus === "all" ? { campus: true } : {}),
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
    readOpenAuthorship(db),
  ]);
  const now = new Date();
  const today = new Date(now);
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
    openAuthorshipImpact(openAuthorship, now),
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

/** The last CSV column, present only when open-row counts are shown on the page. */
export const CSV_WAITING_HEADER = "Open authorship rows waiting on ORCID confirmation";

/** The department table as CSV — aggregates only, no per-person rows. "Confirmed
 *  ORCID" is the confirmed-in-`/edit` subset of "Asserted ORCID". `campusColumn`
 *  (`campus=all`) leads with a Campus column, and leaves a Cornell Ithaca row's
 *  eRA and NIH cells blank: not tracked there, which is not the same as zero.
 *  `waitingColumn` (the page shows open-row counts) appends `CSV_WAITING_HEADER`;
 *  without it the CSV is exactly what it was before that column existed. */
export function orcidCoverageCsv(
  rows: CoverageRow[],
  campusColumn = false,
  waitingColumn = false,
): string {
  const cells = (r: CoverageRow) => {
    const wcmOnly = (n: number) => (campusColumn && r.campus === "ithaca" ? "" : n);
    return [
      r.label,
      r.people,
      r.orcid,
      r.confirmed,
      r.people === 0 ? "" : ((100 * r.orcid) / r.people).toFixed(1),
      r.strong,
      r.weak,
      wcmOnly(r.era),
      wcmOnly(r.both),
      wcmOnly(neither(r)),
      wcmOnly(r.nihPeople),
      wcmOnly(r.nihOrcid),
      wcmOnly(nihNoOrcid(r)),
      wcmOnly(r.nihStrong),
      wcmOnly(r.nihPi),
      wcmOnly(piNoEra(r)),
      ...(waitingColumn ? [r.waitingRows ?? 0] : []),
    ];
  };
  const headers = waitingColumn ? [...CSV_HEADERS, CSV_WAITING_HEADER] : CSV_HEADERS;
  return campusColumn
    ? toCsv(
        ["Campus", ...headers],
        rows.map((r) => [CAMPUS_LABELS[r.campus ?? "wcm"], ...cells(r)]),
      )
    : toCsv(headers, rows.map(cells));
}

/** The export's criteria block: every filter the table reflects, "All" when
 *  unset (the shared who-filter rows, `personFilterCriteria`). `labels` names
 *  each `unit` value (`unitLabels`); an unknown one prints raw. */
export function orcidCoverageCriteria(
  params: OrcidCoverageParams,
  generatedAt: Date,
  labels: ReadonlyMap<string, string> = new Map(),
  /** `OrcidCoverage.impact`: adds the open-row counts' date. Absent = no such row. */
  impact?: { refreshedAt: Date },
): [string, string][] {
  return [
    ["Report", "ORCID coverage by department"],
    ["Generated", generatedAt.toISOString()],
    ...personFilterCriteria({ types: params.types, unitValues: params.units }, labels, (t) => roleLabel(t)),
    ["NIH funding", NIH_FILTER_LABELS[params.nih]],
    ...(params.campus === "ithaca" ? [["Campus", "Cornell Ithaca"] as [string, string]] : []),
    ...(params.campus === "all"
      ? ([
          ["Campus", `Both: ${CAMPUS_LABELS.wcm} and ${CAMPUS_LABELS.ithaca}`],
          [
            "Campus note",
            "Unit and NIH funding filters narrow Weill Cornell Medicine only; eRA and NIH columns are blank for Cornell Ithaca (not tracked)",
          ],
        ] as [string, string][])
      : []),
    ...(impact
      ? [["Open authorship rows as of", impact.refreshedAt.toISOString()] as [string, string]]
      : []),
  ];
}

/** The download: a two-column `Filter,Value` criteria block, ONE blank line,
 *  then the department table exactly as `orcidCoverageCsv` writes it. */
export function orcidCoverageExportCsv(
  rows: CoverageRow[],
  criteria: [string, string][],
  campusColumn = false,
  waitingColumn = false,
): string {
  return `${toCsv(["Filter", "Value"], criteria)}\r\n${orcidCoverageCsv(rows, campusColumn, waitingColumn)}`;
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
    ...(params.campus === "ithaca" ? ["cornell-ithaca"] : []),
    ...(params.campus === "all" ? ["both-campuses"] : []),
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
