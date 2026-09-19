/**
 * `/edit/reports/7` ("Mentored publications") data layer — for every MD-program
 * learner (`aoc_mentee`), every publication co-authored with one of their AOC
 * mentors, with Journal Impact Factor and citations, plus a per-learner count.
 *
 * The Medical Education office asks for this spreadsheet every year and has
 * built it by hand. Every input already lives in this env's Aurora because of
 * the mentoring co-pub bridge (#443 / #928):
 *   - `aoc_mentee` — the raw `reporting_students_mentors` mirror: one row per
 *     (mentor, learner, program), with the learner's name, graduation year,
 *     program type and (once the bridge carries it) entry year;
 *   - `mentee_copublication_pub` — one row per (mentor, mentee, pmid), the pub
 *     itself stored as `CoPublicationFull` JSON (title / journal / year /
 *     full author list with CWIDs);
 *   - `publication` — the local corpus row for the pmid, for `dateAddedToEntrez`,
 *     `journalAbbrev` (the JIF join key) and the NIH iCite `citedByCount`;
 *   - `journal_impact_factor` — joined by normalized `journalAbbrev` exactly as
 *     `loadUnitPublicationsReport` (`cancer-center-publications-report.ts`)
 *     does; an unmatched journal reads a null JIF, never a zero.
 *
 *   - `aoc_mentee_publication` — the learner's FULL ReCiter-attributed
 *     publication list (same `CoPublicationFull` JSON, same export code), read
 *     only in `pubs: "all"` mode; the mentored set is a strict subset by pmid.
 *
 * Three more pair sources (round 4), merged into the same learner map and
 * NOT scope-gated — every `report_access` holder sees them:
 *   - `phd_mentor_relationship` — Jenzabar thesis advisors; grad year =
 *     `conferralYear`, no entry year (Jenzabar carries no start);
 *   - `postdoc_mentor_relationship` — ED postdoc appointments; entry =
 *     `startDate` year, grad = `endDate` year, or ONGOING when there is no
 *     end date (the window then has no upper bound);
 *   - `mentee_suggestion` (presumptive / ambiguous, not dismissed) —
 *     co-authorship-inferred pairs (#2634), no years. Their pubs are NOT in
 *     the bridge: they come from the suggestion's own `evidence` JSON
 *     (`[{ id, year, menteeRank, mentorRank, total }]`, the builder's window:
 *     last 8 years, capped at 50 per pair), each resolved from the local
 *     `publication` row with the byline parsed into `CoPublicationFull`
 *     authors. An evidence id with no local row is skipped and counted in
 *     `droppedUnresolved`. A pair the roster / Jenzabar / ED already
 *     confirm keeps that type and reads from the bridge instead.
 *   The Jenzabar and ED pairs' co-pubs are already in the bridge (the export
 *   unions all three). In `"all"` mode `aoc_mentee_publication` is a
 *   roster-only product, so a learner known ONLY through these sources has
 *   no all-pubs list: their mentored set stands in (ponytail: doctoral
 *   students are Scholar rows, so `publication_author` could serve them).
 *
 * Program window: `entryYear <= pubYear <= gradYear + tail`. A pub outside the
 * window is still LISTED (the office wants the all-time list too) but flagged
 * `inWindow: false`, and the summary carries both counts. A pub shared with two
 * of a learner's mentors is one detail row per mentor but counts ONCE in that
 * learner's summary (distinct pmids).
 *
 * Two publication sets (`pubs`): `"mentored"` (default) is every co-pub with
 * one of the learner's AOC mentors; `"all"` is every publication of the
 * learner from the `aoc_mentee_publication` bridge, each marked `withMentor`
 * when it also appears in `mentee_copublication_pub` for one of the learner's
 * mentors. In `"all"` mode the detail rows are per (learner, pub) — the
 * mentor columns are null and `paperMentors` lists the mentors on the byline.
 * `allPubsLoaded` reports whether that bridge has ever been loaded (the table
 * is non-empty); the page shows a notice rather than zeros when it hasn't.
 *
 * Three shapes come back: `summary` (one row per learner), `detail` (the Raw
 * Data sheet's rows) and `publications` (one row per DISTINCT pmid across
 * every learner and mentor in scope, most recently added to PubMed first,
 * with the learners and mentors on it — the page's Publications view; not in
 * the workbook). Every (learner, mentor) pair carries its `MentorshipType`
 * (`lib/edit/mentorship-type.ts`); AOC rows are `{ bucket, roster, confirmed }`.
 *
 * PubMed only: ReciterDB gives Scopus-only articles a synthetic negative id,
 * and both bridge importers (`etl/mentoring/import-copub-list.ts`,
 * `import-learner-pubs.ts`) drop those before insert, so every bridge row
 * here is a real pmid. The report cannot say how many were excluded — the
 * importer's `droppedPubs` log line is the only tally (round 5 widens the key).
 * Suggestion evidence DOES carry them (as source-prefixed `SCOPUS:` keys);
 * those are dropped and counted in `droppedNonPubmed`.
 *
 * Mentor display name: the mentor's Scholar row (`preferredName`, canonical)
 * when there is one, else the roster's own `mentorFirstName mentorLastName`
 * from the bridge, else the bare CWID. The CWID is always carried alongside.
 *
 * Citations are the NIH iCite count (`Publication.citedByCount`), NOT the
 * Scopus count the bridge JSON carries (`CoPublicationFull.citationCount` is
 * `citationCountScopus` at the source) — the office's stated source is iCite,
 * and mixing the two per row would be worse than a null. Null when the pmid
 * has no local `publication` row or no `analysis_nih` row yet.
 *
 * Scope: the caller passes the scope set `getReportScopes` resolved
 * (`lib/edit/report-access.ts`); rows whose program bucket
 * (`bucketProgramType`, the SAME mapping the Publications-browse mentoring
 * facet uses) isn't admitted are dropped before any pub is read.
 *
 * Server-only (reads `@/lib/db`); imported by the page and the download
 * route, never from a `"use client"` component.
 */
import type { CoPublicationAuthor, CoPublicationFull } from "@/lib/api/mentoring";
import { bucketProgramType, type MentoringProgramKey } from "@/lib/api/mentoring-pmids";
import { stripWcmMarkers } from "@/lib/author-byline";
import { db } from "@/lib/db";
import { HIGH_IMPACT_THRESHOLD } from "@/lib/edit/cancer-center-publications-report";
import { mentoredPubCitation } from "@/lib/edit/mentored-publications-citation";
import {
  mentorshipKey,
  mentorshipLabel,
  PROGRAM_LABEL,
  type MentorshipTier,
  type MentorshipType,
} from "@/lib/edit/mentorship-type";
import { scopeAdmits } from "@/lib/edit/report-access";
import { normalizeJournalAbbrev } from "@/lib/journal-abbrev";
import { KIND_LABEL, type MenteeKind } from "@/lib/mentee-suggestions/kind";

export { HIGH_IMPACT_THRESHOLD, PROGRAM_LABEL };

/** Which publication set the report describes — see the module doc. */
export type MentoredPubsSet = "mentored" | "all";

/** Years past graduation a publication may still count as "in program". */
export const DEFAULT_TAIL = 1;
export const MAX_TAIL = 3;

const PAIR_BATCH = 500;
const PMID_BATCH = 1000;

export type MentoredPublicationsFilters = {
  /** The scope keys the caller may see (`"*"` = every bucket). */
  scopes: ReadonlyArray<string>;
  /** Graduation years kept (`null` in the list = learners with no graduation
   *  year); `null` = every year. */
  gradYears: ReadonlyArray<number | null> | null;
  tail: number;
  pubs: MentoredPubsSet;
};

/** A mentor as the report shows them: resolved display name + CWID. */
export type MentorRef = { cwid: string; name: string };
/** A learner's mentor with the (learner, mentor) pair's provenance. */
export type MentorPair = MentorRef & { mentorship: MentorshipType };

export type MentoredPubsSummaryRow = {
  gradYear: number | null;
  /** The effective program-entry year: the bridge's `entryYear`, or the
   *  `gradYear - 4` fallback (see `entryYearSource`). Null only when both
   *  are unknown. */
  entryYear: number | null;
  entryYearSource: "bridge" | "fallback" | null;
  cwid: string;
  firstName: string | null;
  lastName: string | null;
  /** "MD", "MD-PhD", "ECR" — joined with " / " when the learner's rows span
   *  more than one bucket. */
  program: string;
  /** The learner's mentors (every `aoc_mentee` row), sorted by display name. */
  mentors: MentorPair[];
  /** Distinct pmids inside the program window (of the selected set). The
   *  four in-window counts are `null` (never 0) when the learner's window is
   *  unknowable — no effective entry year or no graduation year. */
  pubsInWindow: number | null;
  /** Distinct in-window pmids with one of the learner's mentors on the
   *  byline. Equals `pubsInWindow` in `"mentored"` mode. */
  withMentorInWindow: number | null;
  /** Distinct pmids across every year. */
  pubsAllTime: number;
  /** Distinct in-window pmids in a journal with JIF >= HIGH_IMPACT_THRESHOLD. */
  highImpactInWindow: number | null;
  /** Distinct in-window pmids where the learner is author #1 (from the
   *  bridge's per-author CWIDs). */
  firstAuthorInWindow: number | null;
};

export type MentoredPubsDetailRow = {
  gradYear: number | null;
  entryYear: number | null;
  program: string;
  learnerCwid: string;
  learnerFirstName: string | null;
  learnerLastName: string | null;
  /** `"mentored"` mode: the (learner, mentor) pair's mentor — one row per
   *  pair per pub. `"all"` mode: null — rows are per (learner, pub). */
  mentorCwid: string | null;
  mentorName: string | null;
  /** `mentorshipLabel` of the (learner, mentor) pair; null in `"all"` mode. */
  mentorship: string | null;
  /** Every one of the learner's mentors who is a WCM-identified co-author on
   *  this paper (via the co-pub bridge). Empty only in `"all"` mode. */
  paperMentors: MentorRef[];
  withMentor: boolean;
  pmid: number;
  title: string;
  journal: string | null;
  /** Current-year Journal Impact Factor, null when the journal did not match. */
  jif: number | null;
  year: number | null;
  /** `Publication.dateAddedToEntrez`, null when the pmid has no local row. */
  dateAdded: Date | null;
  /** NIH iCite citation count (`Publication.citedByCount`), null when unknown. */
  citations: number | null;
  /** The learner's 1-based byline position, null when the bridge's author
   *  list does not carry their CWID. */
  learnerAuthorPosition: number | null;
  authorCount: number;
  /** `null` = the learner's window is unknowable (see `inProgramWindow`). */
  inWindow: boolean | null;
};

/** A learner's presence on one publication (the Publications view). */
export type MentoredPubsLearnerOnPub = {
  cwid: string;
  firstName: string | null;
  lastName: string | null;
  firstAuthor: boolean;
  /** 1-based byline rank, null when the byline does not carry their CWID. */
  authorPosition: number | null;
  inWindow: boolean | null;
};

/** One row per DISTINCT pmid across every learner in scope — the page's
 *  Publications view. A pub co-authored by two learners appears once,
 *  listing both. Not part of the workbook. */
export type MentoredPubsPublicationRow = {
  pmid: number;
  title: string;
  journal: string | null;
  year: number | null;
  /** `mentoredPubCitation` of the bridge JSON (authors, title, journal,
   *  year;vol(issue):pages) — the identifier is rendered by the caller. */
  citation: string;
  jif: number | null;
  citations: number | null;
  dateAdded: Date | null;
  authorCount: number;
  /** Learners on this paper, in summary order. */
  learners: MentoredPubsLearnerOnPub[];
  /** Mentors (of those learners) on this paper, sorted by display name, each
   *  with the type of every (learner, mentor) pair it stands in on this
   *  paper (two learners of different types → two, deduped by key). */
  mentors: Array<MentorRef & { mentorships: MentorshipType[] }>;
  withMentor: boolean;
};

export type MentoredPublicationsReport = {
  summary: MentoredPubsSummaryRow[];
  detail: MentoredPubsDetailRow[];
  publications: MentoredPubsPublicationRow[];
  generatedAt: Date;
  filters: MentoredPublicationsFilters;
  /** `"all"` mode: whether `aoc_mentee_publication` has ever been loaded
   *  (any row at all). `false` = the bridge has not run in this env, so every
   *  count is a vacuous zero — the page says so. `null` in `"mentored"` mode. */
  allPubsLoaded: boolean | null;
  /** Distinct suggestion-evidence ids that are not PubMed pmids (ReciterDB's
   *  source-prefixed `SCOPUS:` keys) — PubMed only, so not shown. */
  droppedNonPubmed: number;
  /** Distinct suggestion-evidence pmids with no local `publication` row yet. */
  droppedUnresolved: number;
};

/** Whether `year` falls in the learner's program window. Unknown grad year
 *  or entry year → null (the window itself is unknowable); unknown pub year
 *  → false (never a guess). `ongoing` (an ED postdoc with no end date) drops
 *  the upper bound: in window iff `year >= entryYear`. */
export function inProgramWindow(
  year: number | null,
  entryYear: number | null,
  gradYear: number | null,
  tail: number,
  ongoing = false,
): boolean | null {
  if (ongoing && entryYear !== null) return year !== null && year >= entryYear;
  if (entryYear === null || gradYear === null) return null;
  if (year === null) return false;
  return entryYear <= year && year <= gradYear + tail;
}

/** The effective entry year: the bridge value when present, else
 *  `gradYear - 4` — for roster MD-family learners only (`fallback`). */
export function effectiveEntryYear(
  entryYear: number | null,
  gradYear: number | null,
  fallback = true,
): { entryYear: number | null; source: "bridge" | "fallback" | null } {
  if (entryYear !== null) return { entryYear, source: "bridge" };
  // ponytail: 4-year MD track fallback until the bridge carries entry year for every row.
  // ponytail: PhD/postdoc windows need real start dates — a conferral year or a postdoc end year gets no guess.
  if (fallback && gradYear !== null) return { entryYear: gradYear - 4, source: "fallback" };
  return { entryYear: null, source: null };
}

function chunks<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function compareDescNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function compareDateDescNullsLast(a: Date | null, b: Date | null): number {
  return compareDescNullsLast(a?.getTime() ?? null, b?.getTime() ?? null);
}

function compareName(a: string | null, b: string | null): number {
  return (a ?? "").localeCompare(b ?? "", "en", { sensitivity: "base" });
}

type AocRow = {
  mentorCwid: string;
  menteeCwid: string;
  firstName: string | null;
  lastName: string | null;
  graduationYear: number | null;
  entryYear: number | null;
  programType: string | null;
  mentorFirstName: string | null;
  mentorLastName: string | null;
};

/** One learner, collapsed across their pair rows (a learner repeats per
 *  mentor, per program and across sources). */
type Learner = {
  cwid: string;
  firstName: string | null;
  lastName: string | null;
  gradYear: number | null;
  entryYear: number | null;
  /** Any `aoc_mentee` row — the only source with an all-pubs list. */
  roster: boolean;
  /** The roster's own grad year — the only one that earns the `gradYear - 4`
   *  entry fallback (a Jenzabar conferral year merged into `gradYear` must not). */
  rosterGradYear: number | null;
  /** An ED postdoc appointment with no end date — no window upper bound. */
  ongoing: boolean;
  /** Program keys, or co-author kinds for suggestion-only learners. */
  buckets: Set<string>;
  /** mentor cwid → the pair's type (the first seen wins). */
  mentors: Map<string, MentorshipType>;
};

type PairRow = {
  mentorCwid: string;
  menteeCwid: string;
  firstName: string | null;
  lastName: string | null;
  gradYear: number | null;
  entryYear: number | null;
  type: MentorshipType;
  ongoing?: boolean;
};

/** Fold one (mentor, learner) pair into the map. Sources are merged in
 *  confidence order (roster, Jenzabar, ED, co-author) so a pair two sources
 *  claim keeps the surer type. */
function mergePair(learners: Map<string, Learner>, r: PairRow): void {
  let l = learners.get(r.menteeCwid);
  if (!l) {
    l = {
      cwid: r.menteeCwid,
      firstName: null,
      lastName: null,
      gradYear: null,
      entryYear: null,
      roster: false,
      rosterGradYear: null,
      ongoing: false,
      buckets: new Set(),
      mentors: new Map(),
    };
    learners.set(r.menteeCwid, l);
  }
  l.firstName ??= r.firstName;
  l.lastName ??= r.lastName;
  // A learner repeating across programs can carry two graduation years; the
  // latest is the one the office reports under.
  if (r.gradYear !== null && (l.gradYear === null || r.gradYear > l.gradYear)) {
    l.gradYear = r.gradYear;
  }
  // Earliest known entry year — the start of the window.
  if (r.entryYear !== null && (l.entryYear === null || r.entryYear < l.entryYear)) {
    l.entryYear = r.entryYear;
  }
  // ponytail: the window is per learner, not per pair — a PhD-then-postdoc gets one merged window.
  if (r.type.source === "roster") {
    l.roster = true;
    if (r.gradYear !== null && (l.rosterGradYear === null || r.gradYear > l.rosterGradYear)) {
      l.rosterGradYear = r.gradYear;
    }
  }
  if (r.ongoing) l.ongoing = true;
  l.buckets.add(r.type.program);
  if (!l.mentors.has(r.mentorCwid)) l.mentors.set(r.mentorCwid, r.type);
}

/** Keep the rows whose program bucket the scope set admits; a row with an
 *  unbucketable `programType` is never admitted (not even by `"*"`, since it
 *  belongs to no program the report describes). */
function admittedRows(
  rows: readonly AocRow[],
  scopes: ReadonlyArray<string>,
): Array<AocRow & { bucket: MentoringProgramKey }> {
  const scopeSet = new Set(scopes);
  const out: Array<AocRow & { bucket: MentoringProgramKey }> = [];
  for (const r of rows) {
    const bucket = bucketProgramType(r.programType);
    if (!bucket) continue;
    if (!scopeAdmits(scopeSet, bucket)) continue;
    out.push({ ...r, bucket });
  }
  return out;
}

function collapseLearners(rows: ReadonlyArray<AocRow & { bucket: MentoringProgramKey }>): Map<string, Learner> {
  const learners = new Map<string, Learner>();
  for (const r of rows) {
    mergePair(learners, {
      mentorCwid: r.mentorCwid,
      menteeCwid: r.menteeCwid,
      firstName: r.firstName,
      lastName: r.lastName,
      gradYear: r.graduationYear,
      entryYear: r.entryYear,
      type: { program: r.bucket, source: "roster", tier: "confirmed" },
    });
  }
  return learners;
}

/** The roster's (or Jenzabar's) own mentor name per mentor CWID — the first
 *  row that carries one wins (a mentor repeats per learner and per program). */
function bridgeMentorNames(
  rows: ReadonlyArray<Pick<AocRow, "mentorCwid" | "mentorFirstName" | "mentorLastName">>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (out.has(r.mentorCwid)) continue;
    const name = [r.mentorFirstName, r.mentorLastName]
      .map((v) => (v ?? "").trim())
      .filter((v) => v.length > 0)
      .join(" ");
    if (name) out.set(r.mentorCwid, name);
  }
  return out;
}

function compareMentor(a: MentorRef, b: MentorRef): number {
  return compareName(a.name, b.name) || a.cwid.localeCompare(b.cwid);
}

function programLabel(buckets: ReadonlySet<string>): string {
  return [...buckets]
    .map((b) => PROGRAM_LABEL[b] ?? KIND_LABEL[b as MenteeKind] ?? b)
    .sort()
    .join(" / ");
}

/** Distinct graduation years present in `aoc_mentee` within `scopes`, newest
 *  first, then a trailing `null` when any admitted row has no graduation
 *  year — the page's year-picker choices. ponytail: roster years only; a
 *  Jenzabar conferral year or postdoc end year outside them is reachable
 *  through "All years". */
export async function loadMentoredGradYears(scopes: ReadonlyArray<string>): Promise<Array<number | null>> {
  const rows = await db.read.aocMentee.findMany({
    select: { graduationYear: true, programType: true },
  });
  const scopeSet = new Set(scopes);
  const years = new Set<number>();
  let unknown = false;
  for (const r of rows) {
    const bucket = bucketProgramType(r.programType);
    if (!bucket || !scopeAdmits(scopeSet, bucket)) continue;
    if (r.graduationYear === null) unknown = true;
    else years.add(r.graduationYear);
  }
  const out: Array<number | null> = [...years].sort((a, b) => b - a);
  if (unknown) out.push(null);
  return out;
}

/** The page's / route's default selection: the two most recent known
 *  years, plus "unknown" when the scope has learners with no
 *  graduation year (else they would silently vanish — MD-PhD's roster
 *  carries no years at all). */
export function defaultMentoredPubsYears(choices: ReadonlyArray<number | null>): Array<number | null> {
  const out: Array<number | null> = choices.filter((y) => y !== null).slice(0, 2);
  if (choices.includes(null)) out.push(null);
  return out;
}

/** 1-based byline rank of the author whose `personIdentifier` is `cwid`, or
 *  null. The bridge stores `analysis_summary_author_list` rows verbatim, so a
 *  WCM author carries their CWID; an unlinked byline position reads null. */
function authorPosition(pub: CoPublicationFull, cwid: string): number | null {
  const target = cwid.toLowerCase();
  const hit = (pub.authors ?? []).find((a) => a.personIdentifier?.toLowerCase() === target);
  return hit ? hit.rank : null;
}

/**
 * Build the report. `scopes` is the caller's resolved scope set (never
 * empty — the page/route refuse before calling this); `gradYears` narrows
 * learners by graduation year (null = all); `tail` widens the window past
 * graduation; `pubs` picks the publication set (see the module doc). Batched
 * reads after the `aoc_mentee` / Jenzabar / postdoc / suggestion scans:
 * co-pubs per (mentor, learner) pair, `publication` per suggestion-evidence
 * pmid, `aoc_mentee_publication` per learner (`"all"` only), `publication`
 * per pmid, `journal_impact_factor` per abbreviation, `scholar` per mentor
 * cwid.
 */
export async function loadMentoredPublicationsReport({
  scopes,
  gradYears = null,
  tail = DEFAULT_TAIL,
  pubs = "mentored",
}: {
  scopes: ReadonlyArray<string>;
  gradYears?: ReadonlyArray<number | null> | null;
  tail?: number;
  pubs?: MentoredPubsSet;
}): Promise<MentoredPublicationsReport> {
  const generatedAt = new Date();
  const filters: MentoredPublicationsFilters = { scopes: [...scopes], gradYears, tail, pubs };
  const allMode = pubs === "all";
  const empty = (allPubsLoaded: boolean | null): MentoredPublicationsReport => ({
    summary: [],
    detail: [],
    publications: [],
    generatedAt,
    filters,
    allPubsLoaded,
    droppedNonPubmed: 0,
    droppedUnresolved: 0,
  });

  // A `null` in `gradYears` admits the rows with no graduation year.
  const knownYears = gradYears?.filter((y): y is number => y !== null) ?? [];
  const aocRows = (await db.read.aocMentee.findMany({
    where: !gradYears
      ? undefined
      : gradYears.includes(null)
        ? { OR: [{ graduationYear: { in: knownYears } }, { graduationYear: null }] }
        : { graduationYear: { in: knownYears } },
    select: {
      mentorCwid: true,
      menteeCwid: true,
      firstName: true,
      lastName: true,
      graduationYear: true,
      entryYear: true,
      programType: true,
      mentorFirstName: true,
      mentorLastName: true,
    },
  })) as AocRow[];
  const rows = admittedRows(aocRows, scopes);
  const learners = collapseLearners(rows);

  // The three other pair sources (module doc): not scope-gated, year-filtered
  // in memory by the source's own year (small tables), merged in confidence
  // order so a pair two sources claim keeps the surer type.
  const yearAdmitted = (y: number | null) =>
    !gradYears || (y === null ? gradYears.includes(null) : knownYears.includes(y));
  const phdRows = await db.read.phdMentorRelationship.findMany({
    select: {
      mentorCwid: true,
      menteeCwid: true,
      menteeFirstName: true,
      menteeLastName: true,
      conferralYear: true,
      programType: true,
      mentorFirstName: true,
      mentorLastName: true,
    },
  });
  for (const r of phdRows) {
    if (!yearAdmitted(r.conferralYear)) continue;
    mergePair(learners, {
      mentorCwid: r.mentorCwid,
      menteeCwid: r.menteeCwid,
      firstName: r.menteeFirstName,
      lastName: r.menteeLastName,
      gradYear: r.conferralYear,
      // ponytail: Jenzabar carries no start; upgrade path = ED student SOR start dates.
      entryYear: null,
      type: { program: r.programType === "MD-PhD" ? "mdphd" : "phd", source: "jenzabar", tier: "confirmed" },
    });
  }
  const postdocRows = await db.read.postdocMentorRelationship.findMany({
    select: {
      mentorCwid: true,
      menteeCwid: true,
      menteeFirstName: true,
      menteeLastName: true,
      startDate: true,
      endDate: true,
    },
  });
  for (const r of postdocRows) {
    const endYear = r.endDate?.getUTCFullYear() ?? null;
    if (!yearAdmitted(endYear)) continue;
    mergePair(learners, {
      mentorCwid: r.mentorCwid,
      menteeCwid: r.menteeCwid,
      firstName: r.menteeFirstName,
      lastName: r.menteeLastName,
      gradYear: endYear,
      entryYear: r.startDate?.getUTCFullYear() ?? null,
      type: { program: "postdoc", source: "ed", tier: "confirmed" },
      ongoing: r.endDate === null,
    });
  }
  // Co-author suggestions carry no year: admitted only with "unknown" selected.
  const suggestions = yearAdmitted(null)
    ? await db.read.menteeSuggestion.findMany({
        where: { dismissedAt: null, tier: { in: ["presumptive", "ambiguous"] } },
        select: { mentorCwid: true, menteeCwid: true, menteeName: true, kind: true, tier: true, evidence: true },
      })
    : [];
  for (const s of suggestions) {
    const cut = s.menteeName.lastIndexOf(" ");
    mergePair(learners, {
      mentorCwid: s.mentorCwid,
      menteeCwid: s.menteeCwid,
      firstName: cut < 0 ? null : s.menteeName.slice(0, cut),
      lastName: cut < 0 ? s.menteeName : s.menteeName.slice(cut + 1),
      gradYear: null,
      entryYear: null,
      type: { program: s.kind, source: "coauthor", tier: s.tier as MentorshipTier },
    });
  }

  // "All" mode: has the learner-pubs bridge EVER been loaded here? An empty
  // table means every count below would be a vacuous zero.
  const allPubsLoaded = allMode
    ? (await db.read.aocMenteePublication.findFirst({ select: { pmid: true } })) !== null
    : null;
  if (learners.size === 0) return empty(allPubsLoaded);

  // Every admitted (mentor, learner) pair — the co-pub bridge's key.
  const pairs: Array<{ mentorCwid: string; menteeCwid: string }> = [];
  const pairKeys = new Set<string>();
  for (const l of learners.values()) {
    for (const mentorCwid of l.mentors.keys()) {
      const key = `${mentorCwid}::${l.cwid}`;
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      pairs.push({ mentorCwid, menteeCwid: l.cwid });
    }
  }

  type CopubRow = { mentorCwid: string; menteeCwid: string; pmid: number; pub: unknown };
  const copubs: CopubRow[] = [];
  for (const batch of chunks(pairs, PAIR_BATCH)) {
    const found = await db.read.menteeCopublicationPub.findMany({
      where: { OR: batch },
      select: { mentorCwid: true, menteeCwid: true, pmid: true, pub: true },
    });
    copubs.push(...found);
  }
  // learner → pmid → the mentors on that paper (the co-pub bridge's fact).
  const mentorsOnPaper = new Map<string, Map<number, Set<string>>>();
  const addMentorOnPaper = (menteeCwid: string, pmid: number, mentorCwid: string) => {
    let byPmid = mentorsOnPaper.get(menteeCwid);
    if (!byPmid) {
      byPmid = new Map();
      mentorsOnPaper.set(menteeCwid, byPmid);
    }
    let set = byPmid.get(pmid);
    if (!set) {
      set = new Set();
      byPmid.set(pmid, set);
    }
    set.add(mentorCwid);
  };
  for (const c of copubs) addMentorOnPaper(c.menteeCwid, c.pmid, c.mentorCwid);

  // Suggestion pairs are not in the bridge: their pubs are the suggestion's
  // evidence (ponytail: the builder's last-8-years window, 50 per pair),
  // resolved from the local `publication` row. PubMed only — a
  // source-prefixed id (`SCOPUS:…`) is counted and dropped.
  const droppedNonPubmed = new Set<string>();
  const droppedUnresolved = new Set<number>();
  type Evidence = { id: string; menteeRank: number };
  const evidence: Array<{ mentorCwid: string; menteeCwid: string; pmid: number; menteeRank: number }> = [];
  for (const s of suggestions) {
    // A pair a surer source also claims reads from the bridge instead.
    if (learners.get(s.menteeCwid)?.mentors.get(s.mentorCwid)?.source !== "coauthor") continue;
    for (const e of (s.evidence ?? []) as Evidence[]) {
      if (!/^[1-9]\d*$/.test(e.id)) {
        droppedNonPubmed.add(e.id);
        continue;
      }
      evidence.push({ mentorCwid: s.mentorCwid, menteeCwid: s.menteeCwid, pmid: Number(e.id), menteeRank: e.menteeRank });
    }
  }
  type LocalPub = {
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    volume: string | null;
    issue: string | null;
    pages: string | null;
    authorsString: string | null;
    fullAuthorsString: string | null;
  };
  const localPub = new Map<string, LocalPub>();
  for (const batch of chunks([...new Set(evidence.map((e) => String(e.pmid)))], PMID_BATCH)) {
    const found = (await db.read.publication.findMany({
      where: { pmid: { in: batch } },
      select: {
        pmid: true,
        title: true,
        journal: true,
        year: true,
        volume: true,
        issue: true,
        pages: true,
        authorsString: true,
        fullAuthorsString: true,
      },
    })) as LocalPub[];
    for (const p of found) localPub.set(p.pmid, p);
  }
  // "Last FM" byline tokens → authors; the initials are spaced ("F M") so
  // `vancouverAuthorToken` re-joins them to the same "Last FM" text. The
  // learner's CWID goes on their `menteeRank` so `authorPosition` finds it.
  const evidencePub = (p: LocalPub, e: { pmid: number; menteeCwid: string; menteeRank: number }): CoPublicationFull => {
    const authors: CoPublicationAuthor[] = stripWcmMarkers(p.fullAuthorsString ?? p.authorsString ?? "")
      .split(", ")
      .filter((t) => t.length > 0)
      .map((t, i) => {
        const cut = t.lastIndexOf(" ");
        return {
          rank: i + 1,
          lastName: cut < 0 ? t : t.slice(0, cut),
          firstName: cut < 0 ? null : t.slice(cut + 1).split("").join(" "),
          personIdentifier: null,
        };
      });
    const me = authors[e.menteeRank - 1];
    if (me) me.personIdentifier = e.menteeCwid;
    return {
      pmid: e.pmid,
      title: p.title,
      journal: p.journal,
      year: p.year,
      doi: null,
      pmcid: null,
      volume: p.volume,
      issue: p.issue,
      pages: p.pages,
      citationCount: 0,
      abstract: null,
      authors,
    };
  };

  // The publication set per learner: the co-pub rows' distinct pmids plus
  // the suggestion evidence, or in "all" mode every `aoc_mentee_publication`
  // row for the learner.
  const mentoredByLearner = new Map<string, Map<number, CoPublicationFull>>();
  const addPub = (into: Map<string, Map<number, CoPublicationFull>>, cwid: string, pmid: number, pub: unknown) => {
    let m = into.get(cwid);
    if (!m) {
      m = new Map();
      into.set(cwid, m);
    }
    if (!m.has(pmid)) m.set(pmid, pub as CoPublicationFull);
  };
  for (const c of copubs) addPub(mentoredByLearner, c.menteeCwid, c.pmid, c.pub);
  for (const e of evidence) {
    const p = localPub.get(String(e.pmid));
    if (!p) {
      droppedUnresolved.add(e.pmid);
      continue;
    }
    addMentorOnPaper(e.menteeCwid, e.pmid, e.mentorCwid);
    addPub(mentoredByLearner, e.menteeCwid, e.pmid, evidencePub(p, e));
  }
  let pubsByLearner = mentoredByLearner;
  if (allMode) {
    pubsByLearner = new Map();
    const learnerCwids = [...learners.keys()];
    for (const batch of chunks(learnerCwids, PAIR_BATCH)) {
      const found = await db.read.aocMenteePublication.findMany({
        where: { menteeCwid: { in: batch } },
        select: { menteeCwid: true, pmid: true, pub: true },
      });
      for (const r of found) addPub(pubsByLearner, r.menteeCwid, r.pmid, r.pub);
    }
    // No all-pubs list for a learner the roster never had: the mentored set stands in.
    for (const l of learners.values()) {
      const mentored = mentoredByLearner.get(l.cwid);
      if (!l.roster && mentored && !pubsByLearner.has(l.cwid)) pubsByLearner.set(l.cwid, mentored);
    }
  }

  // Enrich from the local corpus (date added, JIF join key, iCite citations).
  const pmidSet = new Set<number>();
  for (const m of pubsByLearner.values()) for (const pmid of m.keys()) pmidSet.add(pmid);
  const pmids = [...pmidSet].map(String);
  type PubRow = {
    pmid: string;
    journalAbbrev: string | null;
    dateAddedToEntrez: Date | null;
    citedByCount: number | null;
  };
  const pubByPmid = new Map<string, PubRow>();
  for (const batch of chunks(pmids, PMID_BATCH)) {
    const found = (await db.read.publication.findMany({
      where: { pmid: { in: batch } },
      select: { pmid: true, journalAbbrev: true, dateAddedToEntrez: true, citedByCount: true },
    })) as PubRow[];
    for (const p of found) pubByPmid.set(p.pmid, p);
  }

  const neededAbbrevs = [
    ...new Set(
      [...pubByPmid.values()]
        .map((p) => (p.journalAbbrev ? normalizeJournalAbbrev(p.journalAbbrev) : ""))
        .filter((a) => a.length > 0),
    ),
  ];
  const jifByAbbrev = new Map<string, number | null>();
  for (const batch of chunks(neededAbbrevs, PMID_BATCH)) {
    const found = await db.read.journalImpactFactor.findMany({
      where: { journalAbbrev: { in: batch } },
      select: { journalAbbrev: true, impactScore1: true },
    });
    for (const j of found) {
      jifByAbbrev.set(j.journalAbbrev, j.impactScore1 === null ? null : Number(j.impactScore1));
    }
  }

  // Mentor display names: Scholar.preferredName → roster name → cwid.
  const mentorCwids = [...new Set(pairs.map((p) => p.mentorCwid))];
  const scholarName = new Map<string, string>();
  for (const batch of chunks(mentorCwids, PMID_BATCH)) {
    const found = await db.read.scholar.findMany({
      where: { cwid: { in: batch } },
      select: { cwid: true, preferredName: true },
    });
    for (const s of found) scholarName.set(s.cwid, s.preferredName);
  }
  const rosterName = bridgeMentorNames([...rows, ...phdRows]);
  const mentorRef = (cwid: string): MentorRef => ({
    cwid,
    name: scholarName.get(cwid) ?? rosterName.get(cwid) ?? cwid,
  });
  const paperMentorsFor = (learnerCwid: string, pmid: number): MentorRef[] =>
    [...(mentorsOnPaper.get(learnerCwid)?.get(pmid) ?? [])].map(mentorRef).sort(compareMentor);

  const enrich = (pmid: number) => {
    const local = pubByPmid.get(String(pmid));
    const abbrev = local?.journalAbbrev ? normalizeJournalAbbrev(local.journalAbbrev) : null;
    const jif = abbrev ? (jifByAbbrev.get(abbrev) ?? null) : null;
    return {
      jif,
      dateAdded: local?.dateAddedToEntrez ?? null,
      citations: local?.citedByCount ?? null,
    };
  };

  // Per-learner distinct-pmid accumulators (a pub shared with two mentors
  // counts once), the detail rows, and the per-pmid publication rows.
  type Acc = {
    all: Set<number>;
    inWindow: Set<number>;
    withMentorInWindow: Set<number>;
    highImpact: Set<number>;
    firstAuthor: Set<number>;
  };
  const acc = new Map<string, Acc>();
  const detail: MentoredPubsDetailRow[] = [];
  type PubAgg = {
    pub: CoPublicationFull;
    learners: Map<string, MentoredPubsLearnerOnPub>;
    mentors: Map<string, MentorRef & { mentorships: MentorshipType[] }>;
  };
  const pubAgg = new Map<number, PubAgg>();

  for (const l of learners.values()) {
    const learnerPubs = pubsByLearner.get(l.cwid);
    if (!learnerPubs) continue;
    const { entryYear } = effectiveEntryYear(l.entryYear, l.rosterGradYear);
    const program = programLabel(l.buckets);
    const a: Acc = {
      all: new Set(),
      inWindow: new Set(),
      withMentorInWindow: new Set(),
      highImpact: new Set(),
      firstAuthor: new Set(),
    };
    acc.set(l.cwid, a);

    for (const [pmid, pub] of learnerPubs) {
      const year = pub.year ?? null;
      const { jif, dateAdded, citations } = enrich(pmid);
      const position = authorPosition(pub, l.cwid);
      const inWindow = inProgramWindow(year, entryYear, l.gradYear, tail, l.ongoing);
      const paperMentors = paperMentorsFor(l.cwid, pmid);
      const withMentor = paperMentors.length > 0;

      a.all.add(pmid);
      if (inWindow) {
        a.inWindow.add(pmid);
        if (withMentor) a.withMentorInWindow.add(pmid);
        if (jif !== null && jif >= HIGH_IMPACT_THRESHOLD) a.highImpact.add(pmid);
        if (position === 1) a.firstAuthor.add(pmid);
      }

      const base = {
        gradYear: l.gradYear,
        entryYear,
        program,
        learnerCwid: l.cwid,
        learnerFirstName: l.firstName,
        learnerLastName: l.lastName,
        paperMentors,
        withMentor,
        pmid,
        title: pub.title ?? "",
        journal: pub.journal ?? null,
        jif,
        year,
        dateAdded,
        citations,
        learnerAuthorPosition: position,
        authorCount: pub.authors?.length ?? 0,
        inWindow,
      };
      if (allMode) {
        detail.push({ ...base, mentorCwid: null, mentorName: null, mentorship: null });
      } else {
        // One row per (learner, mentor, pub) — the pair is the bridge's key.
        for (const m of paperMentors) {
          const t = l.mentors.get(m.cwid);
          detail.push({
            ...base,
            mentorCwid: m.cwid,
            mentorName: m.name,
            mentorship: t ? mentorshipLabel(t) : null,
          });
        }
      }

      let agg = pubAgg.get(pmid);
      if (!agg) {
        agg = { pub, learners: new Map(), mentors: new Map() };
        pubAgg.set(pmid, agg);
      }
      agg.learners.set(l.cwid, {
        cwid: l.cwid,
        firstName: l.firstName,
        lastName: l.lastName,
        firstAuthor: position === 1,
        authorPosition: position,
        inWindow,
      });
      // The mentor once, with the type of every (learner, mentor) pair on it.
      for (const m of paperMentors) {
        let am = agg.mentors.get(m.cwid);
        if (!am) {
          am = { ...m, mentorships: [] };
          agg.mentors.set(m.cwid, am);
        }
        const t = l.mentors.get(m.cwid);
        if (t && !am.mentorships.some((x) => mentorshipKey(x) === mentorshipKey(t))) {
          am.mentorships.push(t);
        }
      }
    }
  }

  const summary: MentoredPubsSummaryRow[] = [...learners.values()].map((l) => {
    const { entryYear, source } = effectiveEntryYear(l.entryYear, l.rosterGradYear);
    const a = acc.get(l.cwid);
    // No window to count against → null, not a misleading 0.
    const windowed = (n: number) => (entryYear === null || (l.gradYear === null && !l.ongoing) ? null : n);
    return {
      gradYear: l.gradYear,
      entryYear,
      entryYearSource: source,
      cwid: l.cwid,
      firstName: l.firstName,
      lastName: l.lastName,
      program: programLabel(l.buckets),
      mentors: [...l.mentors]
        .map(([cwid, mentorship]) => ({ ...mentorRef(cwid), mentorship }))
        .sort(compareMentor),
      pubsInWindow: windowed(a?.inWindow.size ?? 0),
      withMentorInWindow: windowed(a?.withMentorInWindow.size ?? 0),
      pubsAllTime: a?.all.size ?? 0,
      highImpactInWindow: windowed(a?.highImpact.size ?? 0),
      firstAuthorInWindow: windowed(a?.firstAuthor.size ?? 0),
    };
  });

  // Newest graduating class first, then by learner name.
  const byLearner = (
    a: { gradYear: number | null; lastName: string | null; firstName: string | null },
    b: { gradYear: number | null; lastName: string | null; firstName: string | null },
  ) =>
    compareDescNullsLast(a.gradYear, b.gradYear) ||
    compareName(a.lastName, b.lastName) ||
    compareName(a.firstName, b.firstName);
  summary.sort((a, b) => byLearner(a, b) || a.cwid.localeCompare(b.cwid));
  detail.sort(
    (a, b) =>
      byLearner(
        { gradYear: a.gradYear, lastName: a.learnerLastName, firstName: a.learnerFirstName },
        { gradYear: b.gradYear, lastName: b.learnerLastName, firstName: b.learnerFirstName },
      ) ||
      a.learnerCwid.localeCompare(b.learnerCwid) ||
      compareDescNullsLast(a.year, b.year) ||
      b.pmid - a.pmid ||
      (a.mentorCwid ?? "").localeCompare(b.mentorCwid ?? ""),
  );

  const summaryRank = new Map(summary.map((r, i) => [r.cwid, i]));
  const publications: MentoredPubsPublicationRow[] = [...pubAgg.entries()].map(([pmid, agg]) => {
    const { jif, dateAdded, citations } = enrich(pmid);
    const mentors = [...agg.mentors.values()].sort(compareMentor);
    return {
      pmid,
      title: agg.pub.title ?? "",
      journal: agg.pub.journal ?? null,
      year: agg.pub.year ?? null,
      citation: mentoredPubCitation({
        title: agg.pub.title ?? "",
        journal: agg.pub.journal ?? null,
        year: agg.pub.year ?? null,
        volume: agg.pub.volume ?? null,
        issue: agg.pub.issue ?? null,
        pages: agg.pub.pages ?? null,
        authors: (agg.pub.authors ?? []) as CoPublicationAuthor[],
      }),
      jif,
      citations,
      dateAdded,
      authorCount: agg.pub.authors?.length ?? 0,
      learners: [...agg.learners.values()].sort(
        (a, b) => (summaryRank.get(a.cwid) ?? 0) - (summaryRank.get(b.cwid) ?? 0),
      ),
      mentors,
      withMentor: mentors.length > 0,
    };
  });
  // Most recently added to PubMed first, then year, title, pmid desc — the
  // Publications view's default order.
  publications.sort(
    (a, b) =>
      compareDateDescNullsLast(a.dateAdded, b.dateAdded) ||
      compareDescNullsLast(a.year, b.year) ||
      compareName(a.title, b.title) ||
      b.pmid - a.pmid,
  );

  return {
    summary,
    detail,
    publications,
    generatedAt,
    filters,
    allPubsLoaded,
    droppedNonPubmed: droppedNonPubmed.size,
    droppedUnresolved: droppedUnresolved.size,
  };
}
