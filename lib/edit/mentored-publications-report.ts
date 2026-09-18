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
 * Program window: `entryYear <= pubYear <= gradYear + tail`. A pub outside the
 * window is still LISTED (the office wants the all-time list too) but flagged
 * `inWindow: false`, and the summary carries both counts. A pub shared with two
 * of a learner's mentors is one detail row per mentor but counts ONCE in that
 * learner's summary (distinct pmids).
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
import type { CoPublicationFull } from "@/lib/api/mentoring";
import { bucketProgramType, type MentoringProgramKey } from "@/lib/api/mentoring-pmids";
import { db } from "@/lib/db";
import { HIGH_IMPACT_THRESHOLD } from "@/lib/edit/cancer-center-publications-report";
import { scopeAdmits } from "@/lib/edit/report-access";
import { normalizeJournalAbbrev } from "@/lib/journal-abbrev";

export { HIGH_IMPACT_THRESHOLD };

/** Years past graduation a publication may still count as "in program". */
export const DEFAULT_TAIL = 1;
export const MAX_TAIL = 3;

/** Human label per `aoc_mentee` program bucket. */
export const PROGRAM_LABEL: Record<string, string> = {
  md: "MD",
  mdphd: "MD-PhD",
  ecr: "ECR",
};

const PAIR_BATCH = 500;
const PMID_BATCH = 1000;

export type MentoredPublicationsFilters = {
  /** The scope keys the caller may see (`"*"` = every bucket). */
  scopes: ReadonlyArray<string>;
  /** Graduation years kept; `null` = every year. */
  gradYears: ReadonlyArray<number> | null;
  tail: number;
};

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
  /** Mentor display names, sorted. */
  mentors: string[];
  /** Distinct pmids inside the program window. */
  pubsInWindow: number;
  /** Distinct pmids across every year. */
  pubsAllTime: number;
  /** Distinct in-window pmids in a journal with JIF >= HIGH_IMPACT_THRESHOLD. */
  highImpactInWindow: number;
  /** Distinct in-window pmids where the learner is author #1 (from the
   *  bridge's per-author CWIDs). */
  firstAuthorInWindow: number;
};

export type MentoredPubsDetailRow = {
  gradYear: number | null;
  entryYear: number | null;
  program: string;
  learnerCwid: string;
  learnerFirstName: string | null;
  learnerLastName: string | null;
  mentorCwid: string;
  mentorName: string;
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
  inWindow: boolean;
};

export type MentoredPublicationsReport = {
  summary: MentoredPubsSummaryRow[];
  detail: MentoredPubsDetailRow[];
  generatedAt: Date;
  filters: MentoredPublicationsFilters;
};

/** Whether `year` falls in the learner's program window. Unknown year, grad
 *  year or entry year → false (never a guess). */
export function inProgramWindow(
  year: number | null,
  entryYear: number | null,
  gradYear: number | null,
  tail: number,
): boolean {
  if (year === null || entryYear === null || gradYear === null) return false;
  return entryYear <= year && year <= gradYear + tail;
}

/** The effective entry year: the bridge value when present, else
 *  `gradYear - 4`. */
export function effectiveEntryYear(
  entryYear: number | null,
  gradYear: number | null,
): { entryYear: number | null; source: "bridge" | "fallback" | null } {
  if (entryYear !== null) return { entryYear, source: "bridge" };
  // ponytail: 4-year MD track fallback until the bridge carries entry year for every row.
  if (gradYear !== null) return { entryYear: gradYear - 4, source: "fallback" };
  return { entryYear: null, source: null };
}

function chunks<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function compareNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compareDescNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
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
};

/** One learner, collapsed across their `aoc_mentee` rows (a learner repeats
 *  per mentor and per program). */
type Learner = {
  cwid: string;
  firstName: string | null;
  lastName: string | null;
  gradYear: number | null;
  entryYear: number | null;
  buckets: Set<MentoringProgramKey>;
  mentorCwids: Set<string>;
};

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
    let l = learners.get(r.menteeCwid);
    if (!l) {
      l = {
        cwid: r.menteeCwid,
        firstName: null,
        lastName: null,
        gradYear: null,
        entryYear: null,
        buckets: new Set(),
        mentorCwids: new Set(),
      };
      learners.set(r.menteeCwid, l);
    }
    l.firstName ??= r.firstName;
    l.lastName ??= r.lastName;
    // A learner repeating across programs can carry two graduation years; the
    // latest is the one the office reports under.
    if (r.graduationYear !== null && (l.gradYear === null || r.graduationYear > l.gradYear)) {
      l.gradYear = r.graduationYear;
    }
    // Earliest known entry year — the start of the window.
    if (r.entryYear !== null && (l.entryYear === null || r.entryYear < l.entryYear)) {
      l.entryYear = r.entryYear;
    }
    l.buckets.add(r.bucket);
    l.mentorCwids.add(r.mentorCwid);
  }
  return learners;
}

function programLabel(buckets: ReadonlySet<MentoringProgramKey>): string {
  return [...buckets]
    .map((b) => PROGRAM_LABEL[b] ?? b)
    .sort()
    .join(" / ");
}

/** Distinct graduation years present in `aoc_mentee` within `scopes`, newest
 *  first — the page's year-picker choices (default = the two most recent). */
export async function loadMentoredGradYears(scopes: ReadonlyArray<string>): Promise<number[]> {
  const rows = await db.read.aocMentee.findMany({
    select: { graduationYear: true, programType: true },
  });
  const scopeSet = new Set(scopes);
  const years = new Set<number>();
  for (const r of rows) {
    if (r.graduationYear === null) continue;
    const bucket = bucketProgramType(r.programType);
    if (!bucket || !scopeAdmits(scopeSet, bucket)) continue;
    years.add(r.graduationYear);
  }
  return [...years].sort((a, b) => b - a);
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
 * graduation. Four batched reads after the `aoc_mentee` scan: co-pubs per
 * (mentor, learner) pair, `publication` per pmid, `journal_impact_factor` per
 * abbreviation, `scholar` per mentor cwid.
 */
export async function loadMentoredPublicationsReport({
  scopes,
  gradYears = null,
  tail = DEFAULT_TAIL,
}: {
  scopes: ReadonlyArray<string>;
  gradYears?: ReadonlyArray<number> | null;
  tail?: number;
}): Promise<MentoredPublicationsReport> {
  const generatedAt = new Date();
  const filters: MentoredPublicationsFilters = { scopes: [...scopes], gradYears, tail };

  const aocRows = (await db.read.aocMentee.findMany({
    where: gradYears ? { graduationYear: { in: [...gradYears] } } : undefined,
    select: {
      mentorCwid: true,
      menteeCwid: true,
      firstName: true,
      lastName: true,
      graduationYear: true,
      entryYear: true,
      programType: true,
    },
  })) as AocRow[];
  const rows = admittedRows(aocRows, scopes);
  const learners = collapseLearners(rows);
  if (learners.size === 0) return { summary: [], detail: [], generatedAt, filters };

  // Every admitted (mentor, learner) pair — the co-pub bridge's key.
  const pairs: Array<{ mentorCwid: string; menteeCwid: string }> = [];
  const pairKeys = new Set<string>();
  for (const l of learners.values()) {
    for (const mentorCwid of l.mentorCwids) {
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

  // Enrich from the local corpus (date added, JIF join key, iCite citations).
  const pmids = [...new Set(copubs.map((c) => String(c.pmid)))];
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

  const mentorCwids = [...new Set(pairs.map((p) => p.mentorCwid))];
  const mentorName = new Map<string, string>();
  for (const batch of chunks(mentorCwids, PMID_BATCH)) {
    const found = await db.read.scholar.findMany({
      where: { cwid: { in: batch } },
      select: { cwid: true, preferredName: true },
    });
    for (const s of found) mentorName.set(s.cwid, s.preferredName);
  }
  const nameFor = (cwid: string) => mentorName.get(cwid) ?? cwid;

  // Per-learner distinct-pmid accumulators (a pub shared with two mentors
  // counts once) and the per-(learner, mentor, pub) detail rows.
  type Acc = { all: Set<number>; inWindow: Set<number>; highImpact: Set<number>; firstAuthor: Set<number> };
  const acc = new Map<string, Acc>();
  const detail: MentoredPubsDetailRow[] = [];
  for (const c of copubs) {
    const l = learners.get(c.menteeCwid);
    if (!l) continue;
    const pub = c.pub as CoPublicationFull;
    const { entryYear } = effectiveEntryYear(l.entryYear, l.gradYear);
    const year = pub.year ?? null;
    const local = pubByPmid.get(String(c.pmid));
    const abbrev = local?.journalAbbrev ? normalizeJournalAbbrev(local.journalAbbrev) : null;
    const jif = abbrev ? (jifByAbbrev.get(abbrev) ?? null) : null;
    const position = authorPosition(pub, l.cwid);
    const inWindow = inProgramWindow(year, entryYear, l.gradYear, tail);

    let a = acc.get(l.cwid);
    if (!a) {
      a = { all: new Set(), inWindow: new Set(), highImpact: new Set(), firstAuthor: new Set() };
      acc.set(l.cwid, a);
    }
    a.all.add(c.pmid);
    if (inWindow) {
      a.inWindow.add(c.pmid);
      if (jif !== null && jif >= HIGH_IMPACT_THRESHOLD) a.highImpact.add(c.pmid);
      if (position === 1) a.firstAuthor.add(c.pmid);
    }

    detail.push({
      gradYear: l.gradYear,
      entryYear,
      program: programLabel(l.buckets),
      learnerCwid: l.cwid,
      learnerFirstName: l.firstName,
      learnerLastName: l.lastName,
      mentorCwid: c.mentorCwid,
      mentorName: nameFor(c.mentorCwid),
      pmid: c.pmid,
      title: pub.title ?? "",
      journal: pub.journal ?? null,
      jif,
      year,
      dateAdded: local?.dateAddedToEntrez ?? null,
      citations: local?.citedByCount ?? null,
      learnerAuthorPosition: position,
      authorCount: pub.authors?.length ?? 0,
      inWindow,
    });
  }

  const summary: MentoredPubsSummaryRow[] = [...learners.values()].map((l) => {
    const { entryYear, source } = effectiveEntryYear(l.entryYear, l.gradYear);
    const a = acc.get(l.cwid);
    return {
      gradYear: l.gradYear,
      entryYear,
      entryYearSource: source,
      cwid: l.cwid,
      firstName: l.firstName,
      lastName: l.lastName,
      program: programLabel(l.buckets),
      mentors: [...l.mentorCwids].map(nameFor).sort(compareName),
      pubsInWindow: a?.inWindow.size ?? 0,
      pubsAllTime: a?.all.size ?? 0,
      highImpactInWindow: a?.highImpact.size ?? 0,
      firstAuthorInWindow: a?.firstAuthor.size ?? 0,
    };
  });

  const byLearner = (
    a: { gradYear: number | null; lastName: string | null; firstName: string | null },
    b: { gradYear: number | null; lastName: string | null; firstName: string | null },
  ) =>
    compareNullsLast(a.gradYear, b.gradYear) ||
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
      a.mentorCwid.localeCompare(b.mentorCwid),
  );

  return { summary, detail, generatedAt, filters };
}
