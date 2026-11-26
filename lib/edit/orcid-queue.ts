/**
 * ORCID librarian queue (`/edit/orcid-queue`, docs/orcid-librarian-queue-spec.md):
 * the flag, the viewer predicate, the band vocabulary, the row types, and the
 * pure rules (v3: score, gap, competitor rules, search, sort) the page and the
 * routes share.
 *
 * 🔴 CLIENT-BUNDLED. `components/edit/orcid-queue.tsx` imports this module at
 * runtime, so it must never import `@/lib/db` or anything that builds a Prisma
 * client at module scope. The loaders and writers live in
 * `orcid-queue.server.ts` and take the client as a parameter.
 *
 * WHO. Librarians are superusers; there is no new role. The page, every route
 * and the subnav tab read `isSuperuser` — never a comms_steward, observer or
 * content editor, and never an impersonated decision (the routes refuse View
 * as, so `orcid_confirmed_by` is always the real librarian).
 */

import { PUBLICATION_MANAGER_URL } from "@/lib/edit/request-a-change";

/** `ORCID_LIBRARIAN_QUEUE`: exactly "on" shows the page, the tab and the routes. */
export function isOrcidLibrarianQueueEnabled(): boolean {
  return process.env.ORCID_LIBRARIAN_QUEUE === "on";
}

/** The tab predicate AND the page gate: the same function (I2 parity). */
export function isOrcidQueueTabVisible(session: { isSuperuser: boolean }): boolean {
  return isOrcidLibrarianQueueEnabled() && session.isSuperuser;
}

/** etl/orcid-evidence's bands, strongest first. */
export const ORCID_QUEUE_BANDS = [
  "email_verified",
  "strong",
  "shared_only",
  "moderate",
  "weak",
] as const;
export type OrcidQueueBand = (typeof ORCID_QUEUE_BANDS)[number];

export const ORCID_QUEUE_BAND_LABEL: Record<OrcidQueueBand, string> = {
  email_verified: "Email verified",
  strong: "Strong",
  shared_only: "Shared papers",
  moderate: "Moderate",
  weak: "Weak",
};

export function isOrcidQueueBand(v: unknown): v is OrcidQueueBand {
  return typeof v === "string" && (ORCID_QUEUE_BANDS as readonly string[]).includes(v);
}

/** v3: a band as a step on the 5-step "Match evidence" meter (Weak = 1). */
export function bandLevel(band: OrcidQueueBand): number {
  return ORCID_QUEUE_BANDS.length - bandRank(band);
}

/** v3: a competitor keeps an iD out of Strong and above, so meter steps 3–5
 *  are the ones it blocks. */
export const COMPETITOR_CAP_LEVEL = 2;

/** Where a candidate pair stands against what is on file. "On file" is
 *  `scholar.orcid` only: Scholars is the ORCID authority for its scholars, and
 *  every other system's iD (Publication Manager's admin field, WCM Identity) is a
 *  candidate. Pure. */
/** `orcid_dismissal.reason`: why an iD was ruled out for a scholar. */
export const ORCID_DISMISS_REASONS = [
  "not_this_person",
  "none_of_these",
  "other_confirmed",
  "removed",
  "duplicate_retired",
  "belongs_to_other",
] as const;
export type OrcidDismissReason = (typeof ORCID_DISMISS_REASONS)[number];
export const ORCID_DISMISS_REASON_LABEL: Record<OrcidDismissReason, string> = {
  not_this_person: "Not this person",
  none_of_these: "None of these",
  other_confirmed: "Another iD confirmed",
  removed: "Removed",
  duplicate_retired: "Retired: duplicate record of this scholar",
  belongs_to_other: "Belongs to another scholar",
};

export type PairState = "queue" | "on_file" | "dismissed" | "conflict";
export function pairState(orcid: string, held: string | null, dismissed: boolean): PairState {
  if (held === orcid) return "on_file";
  if (dismissed) return "dismissed";
  if (held !== null) return "conflict";
  return "queue";
}

/** v2.1: where a record's work stands in ReCiter for the scholar.
 *  `accepted` works are the scholar's and never reach the new-works preview
 *  (they count as shared); `pending` / `rejected` = ReCiter holds it for the
 *  scholar with that assertion; `not_retrieved` = a PMID ReCiter never
 *  retrieved for them; `not_in_pubmed` = a DOI that did not resolve to a PMID;
 *  `no_ids` = neither id (and no title match). */
export const RECITER_WORK_STATUSES = [
  "accepted",
  "pending",
  "rejected",
  "not_retrieved",
  "not_in_pubmed",
  "no_ids",
] as const;
export type ReciterWorkStatus = (typeof RECITER_WORK_STATUSES)[number];

export const RECITER_WORK_STATUS_LABEL: Record<ReciterWorkStatus, string> = {
  accepted: "Accepted in ReCiter",
  pending: "Pending in ReCiter",
  rejected: "Rejected in ReCiter",
  not_retrieved: "Not retrieved by ReCiter",
  not_in_pubmed: "Not in PubMed",
  no_ids: "No identifiers",
};

export function isReciterWorkStatus(v: unknown): v is ReciterWorkStatus {
  return typeof v === "string" && (RECITER_WORK_STATUSES as readonly string[]).includes(v);
}

export type OrcidQueueWork = {
  title: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  source: string | null;
  /** The ORCID work's own link (v2; absent on rows a v1 run wrote). */
  url?: string | null;
  /** v2.1: the work's ReCiter status; null when ReCiter could not be read
   *  this run, absent on rows an earlier run wrote. */
  status?: ReciterWorkStatus | null;
};

/** `orcid_candidate.source` values, in the order the filter lists them. */
export const ORCID_CANDIDATE_SOURCES = [
  "rpm_inferred",
  "rpm_admin",
  "identity",
  "orcid_email",
  "orcid_works",
  "orcid_crossref",
  "orcid_name",
  "infoed_biosketch",
  "infoed_biosketch_name",
  "cornell_affiliation_manager",
  "web_page_seed",
] as const;
export type OrcidCandidateSource = (typeof ORCID_CANDIDATE_SOURCES)[number];

export const ORCID_SOURCE_LABEL: Record<OrcidCandidateSource, string> = {
  rpm_inferred: "Publication Manager inference",
  rpm_admin: "Entered in Publication Manager",
  identity: "WCM Identity",
  orcid_email: "ORCID email",
  orcid_works: "ORCID shared works",
  orcid_crossref: "Crossref deposit",
  orcid_name: "ORCID name only",
  infoed_biosketch: "NIH biosketch",
  infoed_biosketch_name: "NIH biosketch (name match)",
  cornell_affiliation_manager: "Cornell Affiliation Manager",
  web_page_seed: "Faculty web page publications",
};

/** `scholar.campus`: WCM, or Cornell Ithaca (Ithaca ORCID plan). */
export const ORCID_QUEUE_CAMPUSES = ["wcm", "ithaca"] as const;
export type OrcidQueueCampus = (typeof ORCID_QUEUE_CAMPUSES)[number];
export const ORCID_QUEUE_CAMPUS_LABEL: Record<OrcidQueueCampus, string> = {
  wcm: "Weill Cornell Medicine",
  ithaca: "Cornell Ithaca",
};

export function isOrcidCandidateSource(v: unknown): v is OrcidCandidateSource {
  return typeof v === "string" && (ORCID_CANDIDATE_SOURCES as readonly string[]).includes(v);
}

/** Which surname rule made the names agree (etl/orcid-evidence `surnameRule`):
 *  the same surname; the same once accents are folded; a shared token of a
 *  compound surname; the same once spaces and hyphens are removed. */
export type OrcidSurnameRule = "same" | "folded" | "compound_token" | "joined";

export const ORCID_SURNAME_RULE_LABEL: Record<OrcidSurnameRule, string> = {
  same: "same surname",
  folded: "same surname once accents are folded",
  compound_token: "a compound surname shares a part",
  joined: "same surname once spaces and hyphens are removed",
};

/** One institution fact: an ORCID affiliation and what it matched on our side
 *  (`wcm` = the inst_match rule; the rest are the scholar's own history). */
export type OrcidInstitutionPair = {
  orcid: {
    name: string;
    kind: "employment" | "education";
    start: number | null;
    end: number | null;
  };
  ours: { name: string; source: "wcm" | "education" | "appointment" | "identity" };
};

export type OrcidSharedPaper = {
  pmid: string;
  doi: string | null;
  title: string | null;
  year: number | null;
  journal: string | null;
};

export type OrcidBylineSource = "pubmed" | "crossref";

/** What on the bylines points the other way. */
export type OrcidBylineContests = {
  /** Papers ReCiter rejected for the scholar that print it there. */
  rejected: number;
  /** Other people (CWID or NetID) whose accepted papers print it on their byline, or
   *  who have it on file. */
  otherHolders: string[];
  /** Other iDs on this scholar's accepted bylines. */
  otherIds: string[];
};

/** The accepted papers that print the iD next to the scholar's own name, and what
 *  on the bylines points the other way (etl/orcid-evidence/byline.ts). Everything
 *  but `papers` and the `uncounted` fields is what the band reads: PubMed alone while
 *  `ORCID_BYLINE_CROSSREF` is off, PubMed and Crossref when it is on. */
export type OrcidBylineDetail = OrcidBylineContests & {
  /** Newest first, capped; `total` + `uncounted` is the full count. `sources`: who
   *  prints the iD there; absent on an earlier run's row (PubMed). */
  papers: Array<OrcidSharedPaper & { sources?: OrcidBylineSource[] }>;
  total: number;
  /** Papers only Crossref prints the iD on, listed while `ORCID_BYLINE_CROSSREF` is
   *  off: not in `total`. Absent = 0. */
  uncounted?: number;
  /** What contests the iD only in Crossref, while `ORCID_BYLINE_CROSSREF` is off: shown,
   *  not read by the band. Absent = nothing. */
  uncountedContests?: OrcidBylineContests;
};

/** The accepted byline papers that may count toward the band: all of them, or none
 *  when anything on the bylines points the other way. Pure. */
export function bylineBandPapers(
  b: Omit<OrcidBylineDetail, "papers"> | null | undefined,
): number {
  return !b || b.rejected > 0 || b.otherHolders.length > 0 || b.otherIds.length > 0 ? 0 : b.total;
}

/** The byline papers Bulk review's byline route counts: `bylineBandPapers`, and
 *  none when Crossref alone contests the iD (`uncountedContests`, written while
 *  `ORCID_BYLINE_CROSSREF` is off). The band does not read that; an unreviewed
 *  bulk write does. Pure. */
export function bulkBylinePapers(
  b: Omit<OrcidBylineDetail, "papers"> | null | undefined,
): number {
  const u = b?.uncountedContests;
  return u && (u.rejected > 0 || u.otherHolders.length > 0 || u.otherIds.length > 0)
    ? 0
    : bylineBandPapers(b);
}

/** `orcid_candidate_evidence.evidence_detail`: the facts behind each chip,
 *  written by etl/orcid-evidence so the page never re-fetches ORCID. */
export type OrcidEvidenceDetail = {
  names: {
    orcid: { credit: string | null; given: string | null; family: string | null; other: string[] };
    givenAgrees: boolean;
    surnameRule: OrcidSurnameRule | null;
  };
  /** inst_match (`wcm`) and history_match pairs. */
  institutions: OrcidInstitutionPair[];
  /** A cornell.edu address on the record (an inst_match fact on its own). */
  institutionEmail: string | null;
  /** The scholar's email the record lists as verified. */
  email: string | null;
  /** The shared papers (capped; `shared` is the full count). */
  shared: OrcidSharedPaper[];
  /** Absent on rows an earlier run wrote, or when reciterdb could not be read. */
  byline?: OrcidBylineDetail;
  competitors: {
    cwids: Array<{ cwid: string; shared: number; reason: "same_surname" | "same_id" }>;
    orcids: Array<{ orcid: string; shared: number | null }>;
  };
  /** `orcid_candidate.source` values for the pair at scoring time. */
  sources: string[];
  /** Works the non-publication filter dropped or collapsed. */
  worksDropped: number;
  /** v2.1: the new works by ReCiter status, and how the PMIDs were found.
   *  Absent on rows an earlier run wrote. */
  workStatus?: OrcidWorkStatusDetail;
};

export type OrcidWorkStatusDetail = {
  /** New works (not in the scholar's publications) per status; `accepted`
   *  is never here (accepted works are shared, see `acceptedInReciter`). */
  counts: Partial<Record<ReciterWorkStatus, number>>;
  /** New works whose status is unknown: a PMID when ReCiter was not read, or a
   *  DOI the PubMed lookup never answered (`pubmedUnknown`). */
  unknown: number;
  /** False when the run could not read ReCiter's assertions. */
  reciterRead: boolean;
  /** Record works ReCiter accepted for the scholar that our publications lack:
   *  counted as shared, not as new. */
  acceptedInReciter: number;
  /** Record works whose PMID came from the DOI lookup, or from a title match. */
  resolvedByDoi: number;
  resolvedByTitle: number;
  /** Record works with a DOI and no PMID the PubMed lookup never answered (an
   *  NCBI outage): neither resolved nor shown as not in PubMed. Absent on rows
   *  written before it existed. */
  pubmedUnknown?: number;
};

/** A work's link: PubMed when it has a PMID, else doi.org, else its own URL
 *  (https only: it comes from someone else's ORCID record). Null when it has
 *  none. Pure. */
export function workHref(w: {
  pmid?: string | null;
  doi?: string | null;
  url?: string | null;
}): string | null {
  if (w.pmid && /^\d+$/.test(w.pmid.trim()))
    return `https://pubmed.ncbi.nlm.nih.gov/${w.pmid.trim()}/`;
  // Each path segment encoded (old SICI DOIs carry `<`, `>`, `;`, `#`), the `/` kept.
  if (w.doi?.trim())
    return `https://doi.org/${w.doi.trim().split("/").map(encodeURIComponent).join("/")}`;
  const url = w.url?.trim();
  if (url && /^https:\/\//i.test(url)) {
    try {
      if (new URL(url).protocol === "https:") return url;
    } catch {
      // Not a URL: no link.
    }
  }
  return null;
}

/** An https origin (+ optional path) with no trailing slash, or null. Pure. */
function httpsBase(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** v2.1: Publication Manager's base URL for the queue's links, from
 *  `PUBLICATION_MANAGER_URL` (wired per env in cdk/lib/app-stack.ts), else the
 *  front door the rest of SPS links to (`request-a-change.ts`). https only:
 *  anything else falls back to the default. Server-side (reads env). */
export function publicationManagerBaseUrl(): string {
  return httpsBase(process.env.PUBLICATION_MANAGER_URL) ?? httpsBase(PUBLICATION_MANAGER_URL)!;
}

/** A scholar's Publication Manager curate page, or with `doi` its Add tab
 *  with that DOI filled in (`/curate/<uid>?add=external&doi=<doi>`, PM #1047),
 *  or with `pmid` its PubMed Add tab with that PMID searched
 *  (`/curate/<uid>?add=pubmed&pmid=<pmid>`, PM #1059).
 *  Null unless `base` is https. The uid and the DOI are URL-encoded. Pure. */
export function pmCurateHref(
  base: string | null | undefined,
  cwid: string,
  opts: { doi?: string | null; pmid?: string | null } = {},
): string | null {
  const b = httpsBase(base);
  const uid = cwid.trim();
  if (!b || !uid) return null;
  const href = `${b}/curate/${encodeURIComponent(uid)}`;
  const doi = opts.doi?.trim();
  if (doi) return `${href}?add=external&doi=${encodeURIComponent(doi)}`;
  const pmid = opts.pmid?.trim();
  return pmid && /^\d+$/.test(pmid) ? `${href}?add=pubmed&pmid=${pmid}` : href;
}

/** The queue's filter (v2 item 6/7): person type (`role_category`), unit
 *  (`dept:` / `div:` / `inst:` values, the `lib/edit/person-filter.ts`
 *  vocabulary) and candidate source. Empty = no filter on that facet. Applied
 *  on the server (it reads the person tables); v3's search, confidence,
 *  decision and possible-errors facets run in the browser over the summaries. */
export type OrcidQueueFilter = {
  types: string[];
  units: string[];
  sources: OrcidCandidateSource[];
  campuses: OrcidQueueCampus[];
};

export const EMPTY_ORCID_QUEUE_FILTER: OrcidQueueFilter = {
  types: [],
  units: [],
  sources: [],
  campuses: [],
};

/** Unit kinds the queue offers (no centers). */
const QUEUE_UNIT = /^(dept|div|inst):[^\s]{1,64}$/;
const MAX_FILTER_VALUES = 50;

/** `type=…&unit=…&source=…`, sorted: "" for no filter. Pure. */
export function orcidQueueFilterKey(f: OrcidQueueFilter): string {
  const q = new URLSearchParams();
  for (const t of [...f.types].sort()) q.append("type", t);
  for (const u of [...f.units].sort()) q.append("unit", u);
  for (const s of [...f.sources].sort()) q.append("source", s);
  for (const c of [...f.campuses].sort()) q.append("campus", c);
  return q.toString();
}

export function isEmptyOrcidQueueFilter(f: OrcidQueueFilter): boolean {
  return (
    f.types.length === 0 && f.units.length === 0 && f.sources.length === 0 && f.campuses.length === 0
  );
}

/** `?type=…&unit=…&source=…` for the page's links. Pure. */
export function orcidQueueHref(basePath: string, f: OrcidQueueFilter): string {
  const key = orcidQueueFilterKey(f);
  return key ? `${basePath}?${key}` : basePath;
}

/** One candidate iD on a scholar's card. */
export type OrcidQueueRow = {
  cwid: string;
  orcid: string;
  band: OrcidQueueBand;
  /** queue = nothing on file; conflict = a DIFFERENT iD is on file (Replace);
   *  auto_confirmed = the iD the ETL email-confirmed (Undo). */
  state: "queue" | "conflict" | "auto_confirmed";
  instMatch: boolean;
  historyMatch: boolean;
  emailVerified: boolean;
  nameAgrees: boolean;
  shared: number;
  competitor: boolean;
  competitors: Array<{ cwid: string; name: string; shared: number | null; reason: string | null }>;
  competitorOrcids: Array<{ orcid: string; shared: number | null }>;
  worksTotal: number;
  newWorks: number;
  newWorksSample: OrcidQueueWork[];
  /** `orcid_candidate.source` values for the pair, read live. */
  sources: OrcidCandidateSource[];
  /** The ETL's facts behind the evidence; null on a row a v1 run wrote. */
  detail: OrcidEvidenceDetail | null;
  /** Conflicts / email verified: the iD on file. */
  onFileOrcid: string | null;
  /** Already confirmed by the ETL from a verified email (shows Undo). */
  autoConfirmed: boolean;
};

/** How the iD on file got there: `scholar.orcid_confirm_method`, or `identity`
 *  (NULL method: an unconfirmed value WCM Identity's import wrote before Scholars
 *  became the authority). */
export type OrcidOnFileHow =
  "self" | "proxy" | "librarian" | "email_verified" | "authenticated" | "identity";

export type OrcidOnFile = {
  orcid: string;
  how: OrcidOnFileHow;
  /** ISO time, when known (`orcid_confirmed_at`). */
  at: string | null;
  /** Who confirmed it: a cwid, or "ETL". */
  by: string | null;
  byName: string | null;
  /** The public name on the iD's ORCID record, read live; null when it is
   *  private or ORCID didn't answer. */
  name: string | null;
};

/** One `orcid_dismissal` row as the card shows it. `reason`/`by` are null on
 *  rows from before v3 B1 the backfill could not match. */
export type OrcidRuledOut = {
  orcid: string;
  reason: OrcidDismissReason | null;
  keptOrcid: string | null;
  /** belongs_to_other: the scholar it was confirmed for, and their name. */
  otherCwid: string | null;
  otherName: string | null;
  by: string | null;
  byName: string | null;
  /** ISO. */
  at: string;
};

/** One scholar and every candidate iD for them, best first (v2 item 5). */
export type OrcidQueueCard = {
  cwid: string;
  slug: string | null;
  name: string;
  /** The names the ETL compared (fullName, preferredName), distinct. */
  scholarNames: string[];
  title: string | null;
  department: string | null;
  /** v3: the iD on file and where it came from; null when none. */
  onFile: OrcidOnFile | null;
  /** v3: the scholar's confirmed publications (ReCiter's, as Scholars holds them). */
  reciterTotal: number;
  candidates: OrcidQueueRow[];
  /** v3 B1: iDs already ruled out for this scholar, newest first. */
  ruledOut: OrcidRuledOut[];
};

/** v3: one candidate in the scholar list, enough to score, sort and search. */
export type OrcidQueueSummaryCandidate = {
  orcid: string;
  band: OrcidQueueBand;
  shared: number;
  worksTotal: number;
  /** Works on the record not in the scholar's publications ("only on
   *  ORCID"); absent on summaries built before it was carried. */
  newWorks?: number;
  nameAgrees: boolean;
  competitor: boolean;
  /** `orcid_candidate.source` values for the pair (the How discovered counts). */
  sources: OrcidCandidateSource[];
  /** The record carries a Cornell or WCM affiliation or email (`inst_match`).
   *  Absent on summaries built before it was carried: read as true (the server
   *  floor decides). */
  instMatch?: boolean;
  /** Accepted papers that print the iD on the scholar's byline with nothing
   *  contesting it (`bulkBylinePapers`); carried for Strong pairs. Absent = 0. */
  bylinePapers?: number;
};

/** v3: one row of the scholar list. `candidates` best first; email
 *  auto-confirmed iDs are in it, flagged by `autoConfirmed`. */
export type OrcidQueueSummary = {
  cwid: string;
  /** `scholar.campus` (absent on summaries built before the Ithaca ORCID step). */
  campus?: OrcidQueueCampus;
  name: string;
  /** For Name A–Z: the last word of the scholar's full name. */
  surname: string;
  department: string | null;
  candidates: OrcidQueueSummaryCandidate[];
  /** A different iD is on file: a possible error. */
  conflict: boolean;
  /** The ETL confirmed one of the scholar's iDs from a verified email. */
  autoConfirmed: boolean;
  /** ISO times the scholar's earliest and latest pair entered the queue
   *  (`orcid_pair_seen`); null when none is recorded (email-confirmed only). */
  firstQueuedAt: string | null;
  lastQueuedAt: string | null;
  /** v3 B2: decisions on file for the scholar (null = none): an iD ruled out
   *  by the scholar themselves or by staff (a librarian or proxy), an iD a
   *  librarian confirmed, and the latest decision's ISO time. A scholar with
   *  no candidates left is listed for these alone. */
  decisions: { byScholar: boolean; byStaff: boolean; librarian: boolean; at: string | null } | null;
};

/** What the page hands the client: every scholar in the queue under the
 *  server-side filter. The selected scholar's card is fetched on demand
 *  (`GET /api/edit/orcid-queue/scholar`). */
export type OrcidQueueData = {
  summaries: OrcidQueueSummary[];
  filter: OrcidQueueFilter;
};

/** Band strength: 0 = strongest. Pure. */
export function bandRank(band: string): number {
  const i = (ORCID_QUEUE_BANDS as readonly string[]).indexOf(band);
  return i < 0 ? ORCID_QUEUE_BANDS.length : i;
}

/** Best candidate first: band, then shared papers, then name agreement. Pure. */
export function compareCandidates(
  a: Pick<OrcidQueueRow, "band" | "shared" | "nameAgrees" | "orcid">,
  b: Pick<OrcidQueueRow, "band" | "shared" | "nameAgrees" | "orcid">,
): number {
  return (
    bandRank(a.band) - bandRank(b.band) ||
    b.shared - a.shared ||
    Number(b.nameAgrees) - Number(a.nameAgrees) ||
    a.orcid.localeCompare(b.orcid)
  );
}

/** v3: a candidate's score: its meter step, plus the share of the record's
 *  works the scholar also holds (0–1) as a tie-break inside the step. Pure. */
export function candidateScore(
  c: Pick<OrcidQueueSummaryCandidate, "band" | "shared" | "worksTotal">,
): number {
  return bandLevel(c.band) + (c.worksTotal > 0 ? Math.min(1, c.shared / c.worksTotal) : 0);
}

/** v3 "Clearest winner": the best iD's lead over the next best. A scholar with
 *  one candidate leads by more than any pair can (+5). Pure. */
export function scholarGap(s: Pick<OrcidQueueSummary, "candidates">): number {
  const [a, b] = s.candidates;
  if (!a) return 0;
  return b ? candidateScore(a) - candidateScore(b) : candidateScore(a) + 5;
}

/** v3: which competitor rules fired on a row. 1: a same-surname scholar holds
 *  3+ of the record's papers; 2: the scholar has another plausible iD; 3: the
 *  iD is a candidate for another scholar too. Pure. */
export function competitorRules(
  r: Pick<OrcidQueueRow, "competitor" | "competitors" | "competitorOrcids">,
): Array<1 | 2 | 3> {
  if (!r.competitor) return [];
  const out: Array<1 | 2 | 3> = [];
  if (r.competitors.some((c) => c.reason !== "same_id")) out.push(1);
  if (r.competitorOrcids.length > 0) out.push(2);
  if (r.competitors.some((c) => c.reason === "same_id")) out.push(3);
  return out;
}

/** v3 search: name, CWID, or ORCID iD with or without dashes. Pure. */
export function matchesQueueSearch(
  s: Pick<OrcidQueueSummary, "name" | "cwid" | "candidates">,
  raw: string,
): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return true;
  if (s.name.toLowerCase().includes(q) || s.cwid.toLowerCase().includes(q)) return true;
  const bare = q.replace(/[-\s]/g, "");
  return (
    bare.length > 0 &&
    s.candidates.some((c) => c.orcid.replace(/-/g, "").toLowerCase().includes(bare))
  );
}

export const ORCID_QUEUE_SORTS = [
  "strong",
  "gap",
  "oldest",
  "newest",
  "decided",
  "dept",
  "name",
  "cwid",
] as const;
export type OrcidQueueSort = (typeof ORCID_QUEUE_SORTS)[number];

export const ORCID_QUEUE_SORT_LABEL: Record<OrcidQueueSort, { label: string; hint: string }> = {
  strong: { label: "Strongest match", hint: "Easy confirmations first" },
  gap: { label: "Clearest winner", hint: "Biggest gap between the best and next-best iD" },
  oldest: { label: "Oldest in queue", hint: "Longest waiting first" },
  newest: { label: "Newest found", hint: "Most recently found iD first" },
  decided: { label: "Recently decided", hint: "Latest decision first" },
  dept: { label: "Department, then name", hint: "Work one department at a time" },
  name: { label: "Name A–Z", hint: "By surname" },
  cwid: { label: "CWID A–Z", hint: "Match against a list of CWIDs" },
};

/** v3: the scholar list's comparator for a sort. Ties fall back to the
 *  strongest match, then the cwid, so the order is stable. Pure. */
const byTime = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export function compareSummaries(sort: OrcidQueueSort) {
  const best = (s: OrcidQueueSummary) => (s.candidates[0] ? candidateScore(s.candidates[0]) : 0);
  const strong = (a: OrcidQueueSummary, b: OrcidQueueSummary) =>
    best(b) - best(a) || a.cwid.localeCompare(b.cwid);
  const byName = (a: OrcidQueueSummary, b: OrcidQueueSummary) =>
    a.surname.localeCompare(b.surname) || a.name.localeCompare(b.name) || strong(a, b);
  return (a: OrcidQueueSummary, b: OrcidQueueSummary): number => {
    if (sort === "gap") return scholarGap(b) - scholarGap(a) || strong(a, b);
    // ISO strings sort as times; a missing date sorts last either way.
    if (sort === "oldest")
      return byTime(a.firstQueuedAt ?? "~", b.firstQueuedAt ?? "~") || strong(a, b);
    if (sort === "newest")
      return byTime(b.lastQueuedAt ?? "", a.lastQueuedAt ?? "") || strong(a, b);
    if (sort === "decided")
      return byTime(b.decisions?.at ?? "", a.decisions?.at ?? "") || strong(a, b);
    if (sort === "dept")
      return (a.department ?? "￿").localeCompare(b.department ?? "￿") || byName(a, b);
    if (sort === "name") return byName(a, b);
    if (sort === "cwid") return a.cwid.localeCompare(b.cwid);
    return strong(a, b);
  };
}

/** The filter from page search params, lenient: unknown values are dropped,
 *  not refused (a mangled link narrows less, never errors). Pure. */
export function parseOrcidQueueFilter(
  raw: Record<string, string | string[] | undefined>,
): OrcidQueueFilter {
  const list = (k: string) => {
    const v = raw[k];
    return (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => x.trim()).filter(Boolean);
  };
  const uniq = <T extends string>(xs: T[]) => [...new Set(xs)].sort() as T[];
  return {
    types: uniq(list("type").filter((t) => t.length <= 72)).slice(0, MAX_FILTER_VALUES),
    units: uniq(list("unit").filter((u) => QUEUE_UNIT.test(u))).slice(0, MAX_FILTER_VALUES),
    sources: uniq(list("source").filter(isOrcidCandidateSource)),
    campuses: uniq(
      list("campus").filter((c): c is OrcidQueueCampus =>
        (ORCID_QUEUE_CAMPUSES as readonly string[]).includes(c),
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Review throughput (bulk confirm, undo, Weak split)
// ---------------------------------------------------------------------------

/** How long a librarian can undo their own decision from the queue. After
 *  this, a confirmed iD comes off through the scholar's editor (Remove). */
export const ORCID_UNDO_WINDOW_MS = 15 * 60 * 1000;

/** Most pairs one bulk-confirm or undo request takes. */
export const ORCID_BULK_MAX = 100;
/** Cornell Ithaca iDs confirmed per Bulk review batch (Paul, 2026-11-19). */
export const ORCID_BULK_ITHACA_MAX = 100;

/** A Weak iD is one of two very different things: too little evidence to
 *  call (thin) or evidence that points away (conflicting: a competitor or a
 *  name that differs). Null for any other band. Pure. */
export function weakKind(c: {
  band: string;
  competitor: boolean;
  nameAgrees: boolean;
}): "thin" | "conflicting" | null {
  if (c.band !== "weak") return null;
  return c.competitor || !c.nameAgrees ? "conflicting" : "thin";
}

/** The tier as shown: the band label, with Weak split by `weakKind`. Pure. */
export function tierLabel(c: { band: OrcidQueueBand; competitor: boolean; nameAgrees: boolean }) {
  const k = weakKind(c);
  return k === "thin" ? "Thin evidence" : k === "conflicting" ? "Conflicting" : ORCID_QUEUE_BAND_LABEL[c.band];
}

/** The two routes through the WCM floor: the ORCID record (shared works and an
 *  institution match) or the bylines (the iD printed on the scholar's papers). */
export const ORCID_BULK_ROUTES = ["either", "record", "byline"] as const;
export type OrcidBulkRoute = (typeof ORCID_BULK_ROUTES)[number];
export const ORCID_BULK_ROUTE_LABEL: Record<OrcidBulkRoute, string> = {
  either: "Either",
  record: "ORCID record",
  byline: "Bylines",
};

/** The record route's shared works, and the byline route's accepted papers
 *  (etl/orcid-evidence's MIN_BYLINE_STRONG). */
export const ORCID_BULK_MIN_SHARED = 3;
export const ORCID_BULK_MIN_BYLINE = 2;

/** Which routes a WCM pair passes the floor by. Shared by the browser rule and
 *  the server floor. Pure. */
export function bulkRoutes(c: { shared: number; instMatch?: boolean; bylinePapers?: number }): {
  record: boolean;
  byline: boolean;
} {
  return {
    record: c.shared >= ORCID_BULK_MIN_SHARED && c.instMatch !== false,
    byline: (c.bylinePapers ?? 0) >= ORCID_BULK_MIN_BYLINE,
  };
}

/** The adjustable part of the bulk-confirm rule. The fixed part: Strong, no
 *  competitor, nothing on file, not already decided, and one of the two routes
 *  (`bulkRoutes`). */
export type OrcidBulkRule = {
  /** ORCID record route: at least this many ORCID works also in ReCiter. */
  minShared: number;
  /** At most this many works only on ORCID (not in ReCiter). */
  maxOnlyOrcid: number;
  /** WCM: also take a scholar with more than one candidate iD, for their best
   *  one. Absent = one candidate iD only. */
  allowMultiple?: boolean;
  /** WCM: the route a pair must pass by. Absent = either. */
  passesBy?: OrcidBulkRoute;
};

export const ORCID_BULK_RULE_DEFAULT: OrcidBulkRule = {
  minShared: 5,
  maxOnlyOrcid: 1,
};

/** Cornell Ithaca sources a Strong pair can be bulk-confirmed from: Affiliation
 *  Manager, and the web-page inference (Paul, 2026-11-24). Shared by the browser
 *  rule and the server floor. */
export function isIthacaBulkSource(source: string): boolean {
  return source === "cornell_affiliation_manager" || source === "web_page_seed";
}

/** Why a scholar can't be bulk-confirmed. The browser rule (`bulkBlocker`) gives
 *  all but the last three, the server floor (`bulkConfirmableMany`) those too.
 *  `shared` and `institution` name the record-route check that failed for a pair
 *  that also fails the byline route. */
export const ORCID_BULK_BLOCKER_LABEL = {
  multiple: "More than one candidate iD",
  on_file: "An iD is already on file",
  decided: "Already has a decision",
  competitor: "Another scholar or iD competes for the same papers",
  name: "The name on ORCID differs",
  ithaca_source: "Cornell Ithaca, not from Affiliation Manager or a faculty web page",
  threshold: "Doesn't meet the Passes by, shared works or only on ORCID settings",
  shared: "Fewer than 3 shared works and fewer than 2 uncontested byline papers",
  institution:
    "No Cornell or WCM affiliation or email on the ORCID record, and fewer than 2 uncontested byline papers",
  reciter_unread: "Not yet checked against ReCiter",
  reciter_rejected: "ReCiter has a rejected paper from this ORCID record",
  other_scholar: "The iD is on file or suggested for another scholar",
} as const;
export type OrcidBulkBlocker = "band" | keyof typeof ORCID_BULK_BLOCKER_LABEL;

export function isOrcidBulkBlocker(v: unknown): v is keyof typeof ORCID_BULK_BLOCKER_LABEL {
  return typeof v === "string" && Object.hasOwn(ORCID_BULK_BLOCKER_LABEL, v);
}

/** The scholar's best iD is in a band Bulk review takes: Strong, or (Cornell
 *  Ithaca, never auto-confirmed) Email verified. Pure. */
export function inBulkBand(s: OrcidQueueSummary): boolean {
  const band = s.candidates[0]?.band;
  return band === "strong" || (band === "email_verified" && s.campus === "ithaca");
}

/** The first reason the scholar doesn't qualify for bulk confirm under `rule`,
 *  or null. Pure over the summary; the server re-checks the fixed part
 *  (`assertBulkConfirmable`). */
export function bulkBlocker(s: OrcidQueueSummary, rule: OrcidBulkRule): OrcidBulkBlocker | null {
  const c = s.candidates[0];
  if (!c) return "decided";
  if (!inBulkBand(s)) return "band";
  if (s.conflict || s.autoConfirmed) return "on_file";
  const wcm = s.campus !== "ithaca";
  if (s.candidates.length !== 1 && !(wcm && rule.allowMultiple)) return "multiple";
  if (s.decisions) return "decided";
  if (c.competitor) return "competitor";
  if (!c.nameAgrees) return "name";
  // Cornell Ithaca: no SPS publications, so the work/source thresholds can't
  // apply. An email-verified pair qualifies (Ithaca is never auto-confirmed), and
  // a Strong one from an `isIthacaBulkSource`. The server floor does the rest; at
  // most ORCID_BULK_ITHACA_MAX per batch.
  if (!wcm)
    return c.band === "email_verified" || c.sources.some(isIthacaBulkSource)
      ? null
      : "ithaca_source";
  const routes = bulkRoutes(c);
  if (!routes.record && !routes.byline)
    return c.shared < ORCID_BULK_MIN_SHARED ? "shared" : "institution";
  // `minShared` narrows the record route only: byline papers stand on their own.
  const by = rule.passesBy ?? "either";
  const record = routes.record && by !== "byline" && c.shared >= rule.minShared;
  const byline = routes.byline && by !== "record";
  return (record || byline) && onlyOnOrcid(c) <= rule.maxOnlyOrcid ? null : "threshold";
}

/** The scholar qualifies for bulk confirm under `rule`. Pure. */
export function bulkEligible(s: OrcidQueueSummary, rule: OrcidBulkRule): boolean {
  return bulkBlocker(s, rule) === null;
}

/** Works on the ORCID record that are not in ReCiter. Pure. */
export function onlyOnOrcid(c: { newWorks?: number; worksTotal: number; shared: number }): number {
  return c.newWorks ?? Math.max(0, c.worksTotal - c.shared);
}
