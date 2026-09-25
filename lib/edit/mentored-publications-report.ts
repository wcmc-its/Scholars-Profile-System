/**
 * `/edit/reports/7` ("Mentored publications") data layer — for every learner
 * on the AOC pairing sheet (`aoc_mentee`; the Areas of Concentration program
 * IS the MD scholarly-concentration program, bucket `md`, labelled "AOC"),
 * every publication co-authored with one of their mentors, with Journal
 * Impact Factor and citations, plus a per-learner count.
 *
 * The AOC office asks for this spreadsheet every year and has built it by
 * hand. Every input already lives in this env's Aurora because of the
 * mentoring co-pub bridge (#443 / #928):
 *   - `aoc_mentee` — the raw `reporting_students_mentors` mirror of the AOC
 *     pairing sheet (which also carries the MD-PhD program office's list and
 *     the ECR classes): one row per (mentor, learner, program), with the
 *     learner's name, graduation year, program type and (once the bridge
 *     carries it) entry year;
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
 * NOT scope-gated — every `report_access` holder may select them:
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
 *   - `field_override(scholar, <mentor cwid>, 'manualMentees')` — the
 *     mentees a faculty member asserted on their own `/edit` profile
 *     (`lib/edit/manual-mentee.ts`): hand-entered, or a co-authorship
 *     suggestion they ACCEPTED on the "From your publications" card (the
 *     accept flow writes the suggestion's cwid + a `programType`). Confirmed
 *     — it is the mentor's word. Before this source the report read
 *     `mentee_suggestion` alone, so an accepted suggestion still showed as
 *     an inference, off by default: the confirmation was lost. Program =
 *     the entry's `programType` (AOC → md, MD-PhD → mdphd, PhD → phd,
 *     POSTDOC → postdoc) or `other`; grad year = the entry's `year`, no
 *     entry year. An entry with NO cwid cannot be a pair (nothing to join
 *     on): skipped and counted in `droppedNoCwid`. Pubs: not in the bridge
 *     either — a `mentee_suggestion` row for the pair (any tier, dismissed
 *     or not: a later dismissal must not lose the pubs of a pair the mentor
 *     asserted) supplies its evidence exactly as a co-author pair's does;
 *     otherwise the pair's confirmed `publication_author` rows are
 *     intersected by pmid, the mentee's `position` standing in for
 *     `menteeRank` (0 = rank unknown → no byline CWID, position null).
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
 * one of the learner's selected mentors; `"all"` is every publication of the
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
 * PubMed and Scopus-only publications alike (round 5): every pub key here is
 * the SPS `Publication.pmid` string — digits for a PubMed article, `SCOPUS:…`
 * for a Scopus-only one (the bridge tables' `pmid` column and suggestion
 * evidence `id`s both carry it). iCite citations are null for Scopus-only rows
 * by nature (NIH iCite is PubMed-only); JIF resolves through the journal
 * abbreviation either way.
 *
 * Mentor display name: the mentor's Scholar row (`preferredName`, canonical)
 * when there is one, else the roster's own `mentorFirstName mentorLastName`
 * from the bridge, else the bare CWID. The CWID is always carried alongside.
 * Mentor department: `Scholar.primaryDepartment` (ED), else the first pair
 * source that names one — the roster's `mentorDepartment` (free text, null on
 * most rows), Jenzabar's (the Grad School department, on nearly every thesis
 * row), the ED postdoc pass's (`ou=people` primary department of the role
 * record's manager). Mentor institution: the first pair source that names
 * one, in the same order (roster free text; Jenzabar "Sloan-Kettering" /
 * "Weill Cornell" / "HSS"; the ED primary-organization CODE), else
 * `Scholar.primaryOrgCode` (ED, `WCMC` / `MSKCC` / `HSS` / ...), every value
 * folded to WCM / MSKCC / HSS by `mentorInstitution` (codes named through
 * `lib/institutions.ts` first; anything else passes through as typed), else
 * WCM when the mentor has a Scholar row (a WCM ED appointment), else null.
 * Mentor name likewise: Scholar, then the first source with a name (roster,
 * Jenzabar, ED postdoc pass), then the bare CWID.
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
 * Types of mentorship (`types`, a `MentorshipTypeKey` list the caller has
 * already resolved against its scopes): the loader reads ONLY the sources a
 * selected key needs — `aoc_mentee` for aoc / mdphd / ecr (each bucket kept
 * only when its own key is selected), Jenzabar for thesis, ED for postdoc,
 * `mentee_suggestion` for likely (presumptive) / possible (ambiguous), the
 * `manualMentees` overrides for faculty — and
 * `mergePair` refuses any pair whose key is not selected, so a learner is
 * present only through selected pairs: their mentor lines, Program column,
 * counts and workbook rows all describe selected pairs and nothing else.
 * The rail facet this replaced kept a learner on one roster pair and then
 * listed every co-author pair beside it. ponytail: a pair two sources claim
 * takes the surest SELECTED source — with only co-author keys selected, a
 * roster-confirmed pair reads as a co-author inference, since the roster
 * was never read; the upgrade path is a "confirmed elsewhere" annotation.
 *
 * Server-only (reads `@/lib/db`); imported by the page and the download
 * route, never from a `"use client"` component.
 */
import type { CoPublicationAuthor, CoPublicationFull } from "@/lib/api/mentoring";
import { bucketProgramType, type MentoringProgramKey } from "@/lib/api/mentoring-pmids";
import { stripWcmMarkers } from "@/lib/author-byline";
import { db } from "@/lib/db";
import { HIGH_IMPACT_THRESHOLD } from "@/lib/edit/cancer-center-publications-report";
import { validateManualMentees, type ManualMentee } from "@/lib/edit/manual-mentee";
import { mentoredPubCitation } from "@/lib/edit/mentored-publications-citation";
import type { AppliedMentoredPubsFacets } from "@/lib/edit/mentored-publications-facets";
import {
  mentorshipKey,
  mentorshipLabel,
  mentorshipTypeKey,
  PROGRAM_LABEL,
  ROSTER_TYPE_BY_SCOPE,
  type MentorshipTier,
  type MentorshipType,
  type MentorshipTypeKey,
} from "@/lib/edit/mentorship-type";
import { scopeAdmits } from "@/lib/edit/report-access";
import { institutionName } from "@/lib/institutions";
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
  /** The types of mentorship selected (see the module doc). */
  types: ReadonlyArray<MentorshipTypeKey>;
  /** Graduation years kept (`null` in the list = learners with no graduation
   *  year); `null` = every year. */
  gradYears: ReadonlyArray<number | null> | null;
  tail: number;
  pubs: MentoredPubsSet;
};

/** A mentor as the report shows them: resolved display name + CWID, plus the
 *  department and institution (module doc). Optional so fixtures elsewhere
 *  need not carry them; the loader always sets both. */
export type MentorRef = {
  cwid: string;
  name: string;
  department?: string | null;
  institution?: string | null;
};
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
  /** "AOC", "MD-PhD", "ECR" — joined with " / " when the learner's rows span
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
  /** The pair's mentor's department / institution (`MentorRef`); null in `"all"` mode. */
  mentorDepartment: string | null;
  mentorInstitution: string | null;
  /** `mentorshipLabel` of the (learner, mentor) pair; null in `"all"` mode. */
  mentorship: string | null;
  /** Every one of the learner's mentors who is a WCM-identified co-author on
   *  this paper (via the co-pub bridge). Empty only in `"all"` mode. */
  paperMentors: MentorRef[];
  withMentor: boolean;
  pmid: string;
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
  pmid: string;
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
  /** Distinct suggestion-evidence pmids with no local `publication` row yet. */
  droppedUnresolved: number;
  /** Faculty-asserted mentees entered without a CWID — no pair to join on,
   *  so not shown (0 unless `faculty` is selected). */
  droppedNoCwid: number;
  /** The post-load facets this report was narrowed by — set only by
   *  `applyMentoredPubsFacets` (`mentored-publications-facets.ts`), absent
   *  when none were given. The workbook states them. */
  facets?: AppliedMentoredPubsFacets;
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
  mentorDepartment: string | null;
  mentorInstitution: string | null;
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

/** A faculty-asserted mentee WITH a cwid, keyed to the mentor who asserted
 *  them (`field_override.entityId`). */
type FacultyPair = { mentorCwid: string; entry: ManualMentee & { cwid: string } };

/** `manualMentees` `programType` → the report's program bucket. */
const FACULTY_PROGRAM: Record<string, string> = {
  AOC: "md",
  "MD-PhD": "mdphd",
  PhD: "phd",
  POSTDOC: "postdoc",
};

/** Every faculty-asserted mentee with a cwid, across every mentor, plus the
 *  count of entries without one. One scan of the `manualMentees` overrides
 *  (ponytail: `field_override` is small and the unique (entityType,
 *  entityId, fieldName) index narrows by entityType; a fieldName-led index
 *  is the upgrade path if the table ever outgrows the scan). A malformed
 *  value is skipped, never thrown — `validateManualMentees` is the same
 *  gate the write path applies. Used by the loader and the year picker. */
async function readFacultyPairs(): Promise<{ pairs: FacultyPair[]; droppedNoCwid: number }> {
  const rows = await db.read.fieldOverride.findMany({
    where: { entityType: "scholar", fieldName: "manualMentees" },
    select: { entityId: true, value: true },
  });
  const pairs: FacultyPair[] = [];
  let droppedNoCwid = 0;
  for (const r of rows) {
    const parsed = validateManualMentees(r.value);
    if (!parsed.ok) continue;
    for (const entry of parsed.value) {
      if (entry.cwid) pairs.push({ mentorCwid: r.entityId, entry: { ...entry, cwid: entry.cwid } });
      else droppedNoCwid += 1;
    }
  }
  return { pairs, droppedNoCwid };
}

/** Whether any roster key is selected — the gate on reading `aoc_mentee`. */
function rosterSelected(selected: ReadonlySet<string>): boolean {
  return Object.values(ROSTER_TYPE_BY_SCOPE).some((k) => k !== undefined && selected.has(k));
}

/** Fold one (mentor, learner) pair into the map. Sources are merged in
 *  confidence order (roster, Jenzabar, ED, faculty-asserted, co-author) so
 *  a pair two sources claim keeps the surer type — a system of record over
 *  the mentor's word, the mentor's word over an inference. A pair whose
 *  type is not selected is refused outright (the per-source reads already
 *  skip it; this keeps "surest source wins" honest when a caller widens a
 *  read). */
function mergePair(
  learners: Map<string, Learner>,
  r: PairRow,
  selected: ReadonlySet<string>,
): void {
  if (!selected.has(mentorshipTypeKey(r.type) ?? "")) return;
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
  // The surest source for a mentor wins; a pair it discards contributes
  // nothing (else a co-author KIND would leak into the Program column).
  if (l.mentors.has(r.mentorCwid)) return;
  l.mentors.set(r.mentorCwid, r.type);
  l.buckets.add(r.type.program);
}

/** Keep the rows whose program bucket the scope set admits AND whose type
 *  is selected; a row with an unbucketable `programType` is never admitted
 *  (not even by `"*"`, since it belongs to no program the report describes). */
function admittedRows(
  rows: readonly AocRow[],
  scopes: ReadonlyArray<string>,
  selected: ReadonlySet<string>,
): Array<AocRow & { bucket: MentoringProgramKey }> {
  const scopeSet = new Set(scopes);
  const out: Array<AocRow & { bucket: MentoringProgramKey }> = [];
  for (const r of rows) {
    const bucket = bucketProgramType(r.programType);
    if (!bucket) continue;
    if (!scopeAdmits(scopeSet, bucket)) continue;
    if (!selected.has(ROSTER_TYPE_BY_SCOPE[bucket] ?? "")) continue;
    out.push({ ...r, bucket });
  }
  return out;
}

function collapseLearners(
  rows: ReadonlyArray<AocRow & { bucket: MentoringProgramKey }>,
  selected: ReadonlySet<string>,
): Map<string, Learner> {
  const learners = new Map<string, Learner>();
  for (const r of rows) {
    mergePair(
      learners,
      {
        mentorCwid: r.mentorCwid,
        menteeCwid: r.menteeCwid,
        firstName: r.firstName,
        lastName: r.lastName,
        gradYear: r.graduationYear,
        entryYear: r.entryYear,
        type: { program: r.bucket, source: "roster", tier: "confirmed" },
      },
      selected,
    );
  }
  return learners;
}

/** A pair source's own word on the mentor — the roster's, Jenzabar's, the ED
 *  postdoc pass's. Every relationship table carries these four. */
type MentorSourceRow = {
  mentorCwid: string;
  mentorFirstName: string | null;
  mentorLastName: string | null;
  mentorDepartment: string | null;
  mentorInstitution: string | null;
};

/** The sources' own mentor name per mentor CWID — the first row that carries
 *  one wins (a mentor repeats per learner and per program; the caller orders
 *  the sources by trust). */
function bridgeMentorNames(
  rows: ReadonlyArray<Pick<MentorSourceRow, "mentorCwid" | "mentorFirstName" | "mentorLastName">>,
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

/** The first non-empty `get(row)` per mentor CWID (a mentor repeats per
 *  learner and per program). */
function firstPerMentor<R extends { mentorCwid: string }>(
  rows: ReadonlyArray<R>,
  get: (r: R) => string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const v = get(r)?.trim();
    if (v && !out.has(r.mentorCwid)) out.set(r.mentorCwid, v);
  }
  return out;
}

/** A source's institution — roster free text, Jenzabar's short form, or an
 *  ED primary-organization code (named through `lib/institutions.ts` first;
 *  `WCMC` has no entry there and folds on its own) — folded to the three the
 *  office tracks ("Weill Cornell Medical College" / "WCM, Cornell University"
 *  / "WCMC" → WCM; "Sloan-Kettering" / "MSKCC" → MSKCC; "Hospital for Special
 *  Surgery" / "HSS" → HSS); anything else passes through as named. Qatar is
 *  not WCM here. ponytail: three regexes, not an institution dictionary — add
 *  a fourth when one is asked for. */
export function mentorInstitution(raw: string | null | undefined): string | null {
  const s = raw?.trim() ? institutionName(raw.trim()) : "";
  if (!s) return null;
  if (/qatar/i.test(s)) return s;
  if (/weill|\bwcmc?\b/i.test(s)) return "WCM";
  if (/sloan|\bmsk(cc)?\b/i.test(s)) return "MSKCC";
  if (/special surgery|\bhss\b/i.test(s)) return "HSS";
  return s;
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

/** Distinct graduation years across the SELECTED types, newest first, then
 *  a trailing `null` when any selected source has a year-less learner — the
 *  page's year-picker choices. Per type: the roster's `graduationYear` for
 *  each admitted + selected bucket; Jenzabar's `conferralYear` for thesis;
 *  the postdoc `endDate` year for postdoc (ongoing = null = "unknown");
 *  co-author pairs carry no year, so likely / possible contribute "unknown";
 *  a faculty-asserted entry's own `year`, "unknown" when it has none. */
export async function loadMentoredGradYears(
  scopes: ReadonlyArray<string>,
  types: ReadonlyArray<MentorshipTypeKey>,
): Promise<Array<number | null>> {
  const selected = new Set<string>(types);
  const scopeSet = new Set(scopes);
  const years = new Set<number>();
  let unknown = false;
  const add = (y: number | null) => {
    if (y === null) unknown = true;
    else years.add(y);
  };
  if (rosterSelected(selected)) {
    const rows = await db.read.aocMentee.findMany({
      select: { graduationYear: true, programType: true },
    });
    for (const r of rows) {
      const bucket = bucketProgramType(r.programType);
      if (!bucket || !scopeAdmits(scopeSet, bucket) || !selected.has(ROSTER_TYPE_BY_SCOPE[bucket] ?? ""))
        continue;
      add(r.graduationYear);
    }
  }
  if (selected.has("thesis")) {
    const rows = await db.read.phdMentorRelationship.findMany({ select: { conferralYear: true } });
    for (const r of rows) add(r.conferralYear);
  }
  if (selected.has("postdoc")) {
    const rows = await db.read.postdocMentorRelationship.findMany({ select: { endDate: true } });
    for (const r of rows) add(r.endDate?.getUTCFullYear() ?? null);
  }
  if (selected.has("likely") || selected.has("possible")) unknown = true;
  if (selected.has("faculty")) {
    for (const p of (await readFacultyPairs()).pairs) add(p.entry.year ?? null);
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
 * empty — the page/route refuse before calling this); `types` the resolved
 * types of mentorship (never empty either — `resolveMentorshipTypes`);
 * `gradYears` narrows learners by graduation year (null = all); `tail`
 * widens the window past graduation; `pubs` picks the publication set (see
 * the module doc). Batched reads after the `aoc_mentee` / Jenzabar / postdoc
 * / suggestion / `manualMentees` scans (each only when a selected type
 * needs it): co-pubs per (mentor, learner) pair, `mentee_suggestion` and
 * `publication_author` per faculty-asserted pair, `publication` per
 * suggestion-evidence pmid,
 * `aoc_mentee_publication` per learner (`"all"` only), `publication` per
 * pmid, `journal_impact_factor` per abbreviation, `scholar` per mentor cwid.
 */
export async function loadMentoredPublicationsReport({
  scopes,
  types,
  gradYears = null,
  tail = DEFAULT_TAIL,
  pubs = "mentored",
}: {
  scopes: ReadonlyArray<string>;
  types: ReadonlyArray<MentorshipTypeKey>;
  gradYears?: ReadonlyArray<number | null> | null;
  tail?: number;
  pubs?: MentoredPubsSet;
}): Promise<MentoredPublicationsReport> {
  const generatedAt = new Date();
  const filters: MentoredPublicationsFilters = {
    scopes: [...scopes],
    types: [...types],
    gradYears,
    tail,
    pubs,
  };
  const selected = new Set<string>(types);
  const allMode = pubs === "all";
  // Faculty-asserted entries without a cwid are counted even when no learner
  // survives the other filters — the page's sentence must not vanish with them.
  const faculty = selected.has("faculty")
    ? await readFacultyPairs()
    : { pairs: [], droppedNoCwid: 0 };
  const empty = (allPubsLoaded: boolean | null): MentoredPublicationsReport => ({
    summary: [],
    detail: [],
    publications: [],
    generatedAt,
    filters,
    allPubsLoaded,
    droppedUnresolved: 0,
    droppedNoCwid: faculty.droppedNoCwid,
  });

  // A `null` in `gradYears` admits the rows with no graduation year.
  const knownYears = gradYears?.filter((y): y is number => y !== null) ?? [];
  // Each source is read only when a selected type needs it (module doc).
  const aocRows = rosterSelected(selected)
    ? ((await db.read.aocMentee.findMany({
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
          mentorDepartment: true,
          mentorInstitution: true,
        },
      })) as AocRow[])
    : [];
  const rows = admittedRows(aocRows, scopes, selected);
  const learners = collapseLearners(rows, selected);

  // The four other pair sources (module doc): not scope-gated, year-filtered
  // in memory by the source's own year (small tables), merged in confidence
  // order so a pair two sources claim keeps the surer type.
  const yearAdmitted = (y: number | null) =>
    !gradYears || (y === null ? gradYears.includes(null) : knownYears.includes(y));
  const phdRows = selected.has("thesis")
    ? await db.read.phdMentorRelationship.findMany({
        select: {
          mentorCwid: true,
          menteeCwid: true,
          menteeFirstName: true,
          menteeLastName: true,
          conferralYear: true,
          programType: true,
          mentorFirstName: true,
          mentorLastName: true,
          mentorDepartment: true,
          mentorInstitution: true,
        },
      })
    : [];
  for (const r of phdRows) {
    if (!yearAdmitted(r.conferralYear)) continue;
    mergePair(
      learners,
      {
        mentorCwid: r.mentorCwid,
        menteeCwid: r.menteeCwid,
        firstName: r.menteeFirstName,
        lastName: r.menteeLastName,
        gradYear: r.conferralYear,
        // ponytail: Jenzabar carries no start; upgrade path = ED student SOR start dates.
        entryYear: null,
        type: {
          program: r.programType === "MD-PhD" ? "mdphd" : "phd",
          source: "jenzabar",
          tier: "confirmed",
        },
      },
      selected,
    );
  }
  const postdocRows = selected.has("postdoc")
    ? await db.read.postdocMentorRelationship.findMany({
        select: {
          mentorCwid: true,
          menteeCwid: true,
          menteeFirstName: true,
          menteeLastName: true,
          startDate: true,
          endDate: true,
          mentorFirstName: true,
          mentorLastName: true,
          mentorDepartment: true,
          mentorInstitution: true,
        },
      })
    : [];
  for (const r of postdocRows) {
    const endYear = r.endDate?.getUTCFullYear() ?? null;
    if (!yearAdmitted(endYear)) continue;
    mergePair(
      learners,
      {
        mentorCwid: r.mentorCwid,
        menteeCwid: r.menteeCwid,
        firstName: r.menteeFirstName,
        lastName: r.menteeLastName,
        gradYear: endYear,
        entryYear: r.startDate?.getUTCFullYear() ?? null,
        type: { program: "postdoc", source: "ed", tier: "confirmed" },
        ongoing: r.endDate === null,
      },
      selected,
    );
  }
  // Faculty-asserted pairs: after the systems of record, before the
  // inferences — the mentor's own word beats a co-author pattern for the
  // same pair, and a roster / Jenzabar / ED row beats the mentor's word.
  for (const { mentorCwid, entry } of faculty.pairs) {
    const year = entry.year ?? null;
    if (!yearAdmitted(year)) continue;
    const cut = entry.name.lastIndexOf(" ");
    mergePair(
      learners,
      {
        mentorCwid,
        menteeCwid: entry.cwid,
        firstName: cut < 0 ? null : entry.name.slice(0, cut),
        lastName: cut < 0 ? entry.name : entry.name.slice(cut + 1),
        gradYear: year,
        entryYear: null,
        type: {
          program: (entry.programType && FACULTY_PROGRAM[entry.programType]) || "other",
          source: "faculty",
          tier: "confirmed",
        },
      },
      selected,
    );
  }
  // Co-author suggestions carry no year: admitted only with "unknown"
  // selected, and only the selected tier(s).
  const tiers: MentorshipTier[] = [
    ...(selected.has("likely") ? (["presumptive"] as const) : []),
    ...(selected.has("possible") ? (["ambiguous"] as const) : []),
  ];
  const suggestions =
    tiers.length > 0 && yearAdmitted(null)
      ? await db.read.menteeSuggestion.findMany({
          where: { dismissedAt: null, tier: { in: tiers } },
          select: {
            mentorCwid: true,
            menteeCwid: true,
            menteeName: true,
            kind: true,
            tier: true,
            evidence: true,
          },
        })
      : [];
  for (const s of suggestions) {
    const cut = s.menteeName.lastIndexOf(" ");
    mergePair(
      learners,
      {
        mentorCwid: s.mentorCwid,
        menteeCwid: s.menteeCwid,
        firstName: cut < 0 ? null : s.menteeName.slice(0, cut),
        lastName: cut < 0 ? s.menteeName : s.menteeName.slice(cut + 1),
        gradYear: null,
        entryYear: null,
        type: { program: s.kind, source: "coauthor", tier: s.tier as MentorshipTier },
      },
      selected,
    );
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

  type CopubRow = { mentorCwid: string; menteeCwid: string; pmid: string; pub: unknown };
  const copubs: CopubRow[] = [];
  for (const batch of chunks(pairs, PAIR_BATCH)) {
    const found = await db.read.menteeCopublicationPub.findMany({
      where: { OR: batch },
      select: { mentorCwid: true, menteeCwid: true, pmid: true, pub: true },
    });
    copubs.push(...found);
  }
  // learner → pmid → the mentors on that paper (the co-pub bridge's fact).
  const mentorsOnPaper = new Map<string, Map<string, Set<string>>>();
  const addMentorOnPaper = (menteeCwid: string, pmid: string, mentorCwid: string) => {
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

  // Faculty-asserted pairs are not in the bridge either. Those that survived
  // as `faculty` (a surer source did not claim them) read their pubs from
  // the pair's `mentee_suggestion` row when one exists — ANY tier, dismissed
  // or not: an accepted suggestion is never dismissed, but a later dismissal
  // must not lose the pubs of a pair the mentor asserted — else from the
  // `publication_author` intersection below. The read is per pair, so no
  // tier filter: the tier read above only covers the selected inference keys.
  const pairKey = (p: { mentorCwid: string; menteeCwid: string }) =>
    `${p.mentorCwid}::${p.menteeCwid}`;
  const facultyPairs = faculty.pairs
    .map(({ mentorCwid, entry }) => ({ mentorCwid, menteeCwid: entry.cwid }))
    .filter((p) => learners.get(p.menteeCwid)?.mentors.get(p.mentorCwid)?.source === "faculty");
  const facultySuggestions: Array<{ mentorCwid: string; menteeCwid: string; evidence: unknown }> =
    [];
  for (const batch of chunks(facultyPairs, PAIR_BATCH)) {
    const found = await db.read.menteeSuggestion.findMany({
      where: { OR: batch },
      select: { mentorCwid: true, menteeCwid: true, evidence: true },
    });
    facultySuggestions.push(...found);
  }
  const suggestedPairs = new Set(facultySuggestions.map(pairKey));

  // Suggestion pairs are not in the bridge: their pubs are the suggestion's
  // evidence (ponytail: the builder's last-8-years window, 50 per pair),
  // resolved from the local `publication` row by its `id` (the same key).
  const droppedUnresolved = new Set<string>();
  type Evidence = { id: string; menteeRank: number };
  const evidence: Array<{ mentorCwid: string; menteeCwid: string; pmid: string; menteeRank: number }> = [];
  for (const s of [...suggestions, ...facultySuggestions]) {
    // A pair a surer source also claims reads from the bridge instead. A
    // faculty pair reads its evidence too (the same row may arrive twice
    // when its inference tier is also selected; `addPub` dedupes by pmid).
    const source = learners.get(s.menteeCwid)?.mentors.get(s.mentorCwid)?.source;
    if (source !== "coauthor" && source !== "faculty") continue;
    // A malformed evidence blob (not an array, or a non-object entry) is
    // skipped, never thrown — one bad row must not take the whole report down.
    const list = Array.isArray(s.evidence) ? (s.evidence as unknown[]) : [];
    for (const e of list as Evidence[]) {
      if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id || e.id.length > 32) continue;
      evidence.push({ mentorCwid: s.mentorCwid, menteeCwid: s.menteeCwid, pmid: e.id, menteeRank: e.menteeRank });
    }
  }
  // A faculty pair with no suggestion row: intersect the two authors'
  // confirmed `publication_author` rows by pmid (the SPS key, digits or
  // `SCOPUS:…`). Grouped by cwid LOWERCASED — the `IN` filter matches
  // case-insensitively under the column's collation but returns the STORED
  // spelling (see `localCoPublications`, `lib/api/mentoring.ts`). The
  // mentee's `position` stands in for `menteeRank`; 0 ("rank unknown",
  // #2227) attaches no byline CWID, so the position reads null.
  const unsuggested = facultyPairs.filter((p) => !suggestedPairs.has(pairKey(p)));
  const pmidsByCwid = new Map<string, Map<string, number>>();
  const authorCwids = [...new Set(unsuggested.flatMap((p) => [p.mentorCwid, p.menteeCwid]))];
  for (const batch of chunks(authorCwids, PMID_BATCH)) {
    const found = await db.read.publicationAuthor.findMany({
      where: { cwid: { in: batch }, isConfirmed: true },
      select: { cwid: true, pmid: true, position: true },
    });
    for (const r of found) {
      if (!r.cwid) continue;
      const key = r.cwid.toLowerCase();
      let m = pmidsByCwid.get(key);
      if (!m) pmidsByCwid.set(key, (m = new Map()));
      m.set(r.pmid, r.position);
    }
  }
  for (const p of unsuggested) {
    const mentorPmids = pmidsByCwid.get(p.mentorCwid.toLowerCase());
    const menteePmids = pmidsByCwid.get(p.menteeCwid.toLowerCase());
    if (!mentorPmids || !menteePmids) continue;
    for (const [pmid, position] of menteePmids) {
      if (!mentorPmids.has(pmid)) continue;
      evidence.push({
        mentorCwid: p.mentorCwid,
        menteeCwid: p.menteeCwid,
        pmid,
        menteeRank: position,
      });
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
  for (const batch of chunks([...new Set(evidence.map((e) => e.pmid))], PMID_BATCH)) {
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
  const evidencePub = (p: LocalPub, e: { pmid: string; menteeCwid: string; menteeRank: number }): CoPublicationFull => {
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
      id: e.pmid,
      // ponytail: `pmid` is legacy — `id` is the key; a Scopus row has no honest number.
      pmid: /^\d+$/.test(e.pmid) ? Number(e.pmid) : -1,
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
  // the suggestion / faculty-pair evidence, or in "all" mode every
  // `aoc_mentee_publication` row for the learner.
  const mentoredByLearner = new Map<string, Map<string, CoPublicationFull>>();
  const addPub = (into: Map<string, Map<string, CoPublicationFull>>, cwid: string, pmid: string, pub: unknown) => {
    let m = into.get(cwid);
    if (!m) {
      m = new Map();
      into.set(cwid, m);
    }
    if (!m.has(pmid)) m.set(pmid, pub as CoPublicationFull);
  };
  for (const c of copubs) addPub(mentoredByLearner, c.menteeCwid, c.pmid, c.pub);
  for (const e of evidence) {
    const p = localPub.get(e.pmid);
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
  const pmidSet = new Set<string>();
  for (const m of pubsByLearner.values()) for (const pmid of m.keys()) pmidSet.add(pmid);
  const pmids = [...pmidSet];
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

  // Mentor display names: Scholar.preferredName → roster name → cwid;
  // department and institution likewise (module doc).
  const mentorCwids = [...new Set(pairs.map((p) => p.mentorCwid))];
  const scholarByCwid = new Map<
    string,
    { preferredName: string; primaryDepartment: string | null; primaryOrgCode: string | null }
  >();
  for (const batch of chunks(mentorCwids, PMID_BATCH)) {
    const found = await db.read.scholar.findMany({
      where: { cwid: { in: batch } },
      select: { cwid: true, preferredName: true, primaryDepartment: true, primaryOrgCode: true },
    });
    for (const s of found) scholarByCwid.set(s.cwid, s);
  }
  // Sources in trust order: the office's roster, Jenzabar, the ED postdoc pass.
  const sourceRows: MentorSourceRow[] = [...rows, ...phdRows, ...postdocRows];
  const sourceName = bridgeMentorNames(sourceRows);
  const sourceDept = firstPerMentor(sourceRows, (r) => r.mentorDepartment);
  const sourceInst = firstPerMentor(sourceRows, (r) => r.mentorInstitution);
  const mentorRef = (cwid: string): MentorRef => {
    const scholar = scholarByCwid.get(cwid);
    return {
      cwid,
      name: scholar?.preferredName ?? sourceName.get(cwid) ?? cwid,
      department: scholar?.primaryDepartment ?? sourceDept.get(cwid) ?? null,
      // ponytail: a Scholar row is a WCM ED appointment, so an MSK/HSS mentor
      // who also holds one reads WCM when no source and no org code says.
      institution:
        mentorInstitution(sourceInst.get(cwid) ?? scholar?.primaryOrgCode) ??
        (scholar ? "WCM" : null),
    };
  };
  const paperMentorsFor = (learnerCwid: string, pmid: string): MentorRef[] =>
    [...(mentorsOnPaper.get(learnerCwid)?.get(pmid) ?? [])].map(mentorRef).sort(compareMentor);

  const enrich = (pmid: string) => {
    const local = pubByPmid.get(pmid);
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
    all: Set<string>;
    inWindow: Set<string>;
    withMentorInWindow: Set<string>;
    highImpact: Set<string>;
    firstAuthor: Set<string>;
  };
  const acc = new Map<string, Acc>();
  const detail: MentoredPubsDetailRow[] = [];
  type PubAgg = {
    pub: CoPublicationFull;
    learners: Map<string, MentoredPubsLearnerOnPub>;
    mentors: Map<string, MentorRef & { mentorships: MentorshipType[] }>;
  };
  const pubAgg = new Map<string, PubAgg>();

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
        detail.push({
          ...base,
          mentorCwid: null,
          mentorName: null,
          mentorDepartment: null,
          mentorInstitution: null,
          mentorship: null,
        });
      } else {
        // One row per (learner, mentor, pub) — the pair is the bridge's key.
        for (const m of paperMentors) {
          const t = l.mentors.get(m.cwid);
          detail.push({
            ...base,
            mentorCwid: m.cwid,
            mentorName: m.name,
            mentorDepartment: m.department ?? null,
            mentorInstitution: m.institution ?? null,
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
      b.pmid.localeCompare(a.pmid) ||
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
      b.pmid.localeCompare(a.pmid),
  );

  return {
    summary,
    detail,
    publications,
    generatedAt,
    filters,
    allPubsLoaded,
    droppedUnresolved: droppedUnresolved.size,
    droppedNoCwid: faculty.droppedNoCwid,
  };
}
