/**
 * Report 7's post-load facets (`/edit/reports/mentored-publications`, the
 * 2026-09-24 redesign): In window, Author position, Publication year, Mentor
 * and "Hide learners with no publications". The loader
 * (`loadMentoredPublicationsReport`) reads what the SERVER filters select —
 * types, graduation years, counting window, publication set — and this module
 * narrows its result by the rest, the same way on the page and in the
 * download (so what the page shows is what the workbook holds).
 *
 * These used to be an in-memory rail inside the client island, one set per
 * tab (the Publications tab's Year / Author position / In program window /
 * Mentor; the Summary tab's Known/Unknown window and Mentor) that never
 * touched the counts or the download. Now they are URL params
 * (`mentored-publications-params.ts`) with one rail for both tabs, so each
 * facet has to say what it does to a LEARNER's counts. The unit is the
 * (learner, publication) pair, the Raw Data sheet's grain:
 *   - `window` / `position` / `pubYears` keep a (learner, publication) pair
 *     when the learner's own window flag / byline position / the paper's year
 *     is selected. A learner's counts are recomputed over the pairs kept, so
 *     "First author" + "In window: yes" leaves each learner's first-authored
 *     in-window papers; a paper two learners share stays listed under the
 *     learner(s) whose pair survived. A pair with no position (the byline
 *     carries no CWID for the learner) or no year never matches a selected
 *     position / year — the old facets' behaviour.
 *   - `mentors` keeps the learners with one of the selected mentors, and
 *     their pairs with the selected mentors only: in the mentored set, the
 *     papers co-authored with a selected mentor (the Raw Data row's
 *     `mentorCwid`); in the all-publications set every paper of the learner
 *     stays, "with a mentor" then meaning a SELECTED mentor on the byline.
 *     The mockup's rule (`L.ms.filter(selected)`), and the same "present
 *     only through selected pairs" rule the type filter follows.
 *   - `withPubs` then drops the learners left with no publication.
 * An unknowable window stays `null` (never 0) on every in-window count, as
 * the loader has it. No facet set → the report is returned untouched (the
 * SAME object), so every link that predates them reads exactly as before.
 *
 * Also here: the rail's option counts (`mentoredPubsFacetOptions`), each
 * facet counted over the pairs that pass every OTHER facet (the cross-facet
 * convention `RosterFacet` documents) — distinct publications for the three
 * publication facets, learners for Mentor.
 *
 * Pure (no `@/lib/db`): the threshold is a parameter because its home module
 * reads the database. Server-side callers only (the body and the route).
 */
import type {
  MentoredPublicationsReport,
  MentoredPubsDetailRow,
  MentoredPubsSummaryRow,
  MentorRef,
} from "@/lib/edit/mentored-publications-report";
import {
  hasMentoredPubsFacets,
  MENTORED_PUBS_POSITIONS,
  MENTORED_PUBS_WINDOWS,
  type MentoredPubsParams,
  type MentoredPubsPosition,
  type MentoredPubsWindow,
} from "@/lib/edit/mentored-publications-params";

export type MentoredPubsFacets = Pick<
  MentoredPubsParams,
  "window" | "position" | "pubYears" | "mentors" | "withPubs"
>;

/** The facets a report was narrowed by, as the workbook's Query &
 *  Assumptions sheet states them (mentors resolved to names). */
export type AppliedMentoredPubsFacets = Omit<MentoredPubsFacets, "mentors"> & {
  mentors: MentorRef[];
};

export type MentoredPubsFacetOption = { value: string; label: string; count: number };

export const WINDOW_FACET_LABEL: Record<MentoredPubsWindow, string> = {
  yes: "In window",
  no: "Outside window",
  unknown: "Window unknown",
};

export const POSITION_FACET_LABEL: Record<MentoredPubsPosition, string> = {
  first: "First author",
  last: "Last author",
  middle: "Middle author",
};

export function windowValue(inWindow: boolean | null): MentoredPubsWindow {
  return inWindow === null ? "unknown" : inWindow ? "yes" : "no";
}

/** First wins on a one-author paper; null when the byline has no CWID for
 *  the learner. */
export function positionValue(position: number | null, authorCount: number): MentoredPubsPosition | null {
  if (position === null) return null;
  if (position === 1) return "first";
  if (position === authorCount) return "last";
  return "middle";
}

const lc = (s: string) => s.toLowerCase();

/** One (learner, publication) pair, folded from the detail rows (in the
 *  mentored set, one detail row per mentor on the paper). */
type Pair = {
  learner: string;
  pmid: string;
  year: number | null;
  window: MentoredPubsWindow;
  position: MentoredPubsPosition | null;
  jif: number | null;
  firstAuthor: boolean;
  inWindow: boolean | null;
  /** Mentors on the paper (lower-cased CWIDs): the pair rows' `mentorCwid`s
   *  in the mentored set, `paperMentors` in the all-publications set. */
  mentors: Set<string>;
  rows: MentoredPubsDetailRow[];
};

function pairsOf(detail: ReadonlyArray<MentoredPubsDetailRow>): Map<string, Pair> {
  const out = new Map<string, Pair>();
  for (const d of detail) {
    const key = `${d.learnerCwid}\u0000${d.pmid}`;
    let p = out.get(key);
    if (!p) {
      p = {
        learner: d.learnerCwid,
        pmid: d.pmid,
        year: d.year,
        window: windowValue(d.inWindow),
        position: positionValue(d.learnerAuthorPosition, d.authorCount),
        jif: d.jif,
        firstAuthor: d.learnerAuthorPosition === 1,
        inWindow: d.inWindow,
        mentors: new Set(d.paperMentors.map((m) => lc(m.cwid))),
        rows: [],
      };
      out.set(key, p);
    }
    if (d.mentorCwid) p.mentors.add(lc(d.mentorCwid));
    p.rows.push(d);
  }
  return out;
}

type Test = (p: Pair) => boolean;

/** The per-facet predicates; an empty selection passes everything. */
function predicates(report: MentoredPublicationsReport, f: MentoredPubsFacets) {
  const window = new Set<string>(f.window);
  const position = new Set<string>(f.position);
  const years = new Set(f.pubYears);
  const mentors = new Set(f.mentors.map(lc));
  const learnersWithMentor = new Set(
    report.summary.filter((r) => r.mentors.some((m) => mentors.has(lc(m.cwid)))).map((r) => r.cwid),
  );
  const allMode = report.filters.pubs === "all";
  const tests: Record<"window" | "position" | "pubYears" | "mentors", Test> = {
    window: (p) => window.size === 0 || window.has(p.window),
    position: (p) => position.size === 0 || (p.position !== null && position.has(p.position)),
    pubYears: (p) => years.size === 0 || (p.year !== null && years.has(p.year)),
    mentors: (p) =>
      mentors.size === 0 ||
      (learnersWithMentor.has(p.learner) && (allMode || [...p.mentors].some((m) => mentors.has(m)))),
  };
  return { tests, mentors, learnersWithMentor };
}

/** Narrow a loaded report by the post-load facets (module doc). */
export function applyMentoredPubsFacets(
  report: MentoredPublicationsReport,
  facets: MentoredPubsFacets,
  highImpactThreshold: number,
): MentoredPublicationsReport {
  if (!hasMentoredPubsFacets(facets)) return report;
  const { tests, mentors, learnersWithMentor } = predicates(report, facets);
  const keep = (p: Pair) => tests.window(p) && tests.position(p) && tests.pubYears(p) && tests.mentors(p);
  const pickMentor = (m: MentorRef) => mentors.size === 0 || mentors.has(lc(m.cwid));

  const kept = [...pairsOf(report.detail).values()].filter(keep);
  // In the mentored set a pair keeps only its selected mentors' rows; in the
  // all set a row's `paperMentors` narrow to the selected mentors instead.
  const allMode = report.filters.pubs === "all";
  const detail: MentoredPubsDetailRow[] = [];
  const keptKeys = new Set<string>();
  const mentorsOnPub = new Map<string, Set<string>>();
  type Acc = { all: Set<string>; win: Set<string>; winMentor: Set<string>; high: Set<string>; first: Set<string> };
  const acc = new Map<string, Acc>();
  for (const p of kept) {
    const rows = allMode
      ? p.rows.map((r) => {
          const paperMentors = r.paperMentors.filter(pickMentor);
          return { ...r, paperMentors, withMentor: paperMentors.length > 0 };
        })
      : p.rows.filter((r) => mentors.size === 0 || (r.mentorCwid !== null && mentors.has(lc(r.mentorCwid))));
    if (rows.length === 0) continue;
    detail.push(...rows);
    keptKeys.add(`${p.learner}\u0000${p.pmid}`);
    const onPub = mentorsOnPub.get(p.pmid) ?? new Set<string>();
    for (const r of rows) {
      if (r.mentorCwid) onPub.add(lc(r.mentorCwid));
      for (const m of r.paperMentors) onPub.add(lc(m.cwid));
    }
    mentorsOnPub.set(p.pmid, onPub);
    let a = acc.get(p.learner);
    if (!a) {
      a = { all: new Set(), win: new Set(), winMentor: new Set(), high: new Set(), first: new Set() };
      acc.set(p.learner, a);
    }
    a.all.add(p.pmid);
    if (p.inWindow) {
      a.win.add(p.pmid);
      if (rows.some((r) => r.withMentor)) a.winMentor.add(p.pmid);
      if (p.jif !== null && p.jif >= highImpactThreshold) a.high.add(p.pmid);
      if (p.firstAuthor) a.first.add(p.pmid);
    }
  }

  const summary: MentoredPubsSummaryRow[] = [];
  for (const r of report.summary) {
    if (mentors.size > 0 && !learnersWithMentor.has(r.cwid)) continue;
    const a = acc.get(r.cwid);
    const all = a?.all.size ?? 0;
    if (facets.withPubs && all === 0) continue;
    // An unknowable window stays null, never 0 (the loader's rule).
    const windowed = (n: number | undefined) => (r.pubsInWindow === null ? null : (n ?? 0));
    summary.push({
      ...r,
      mentors: r.mentors.filter(pickMentor),
      pubsInWindow: windowed(a?.win.size),
      withMentorInWindow: windowed(a?.winMentor.size),
      pubsAllTime: all,
      highImpactInWindow: windowed(a?.high.size),
      firstAuthorInWindow: windowed(a?.first.size),
    });
  }

  const publications = report.publications.flatMap((pub) => {
    const learners = pub.learners.filter((l) => keptKeys.has(`${l.cwid}\u0000${pub.pmid}`));
    if (learners.length === 0) return [];
    const onPub = mentorsOnPub.get(pub.pmid) ?? new Set<string>();
    const pubMentors = pub.mentors.filter((m) => onPub.has(lc(m.cwid)));
    return [{ ...pub, learners, mentors: pubMentors, withMentor: pubMentors.length > 0 }];
  });

  // Mentor names for the workbook, from the unfiltered learners' pairs.
  const names = new Map<string, MentorRef>();
  for (const r of report.summary) for (const m of r.mentors) names.set(lc(m.cwid), m);
  return {
    ...report,
    summary,
    detail,
    publications,
    facets: {
      window: facets.window,
      position: facets.position,
      pubYears: facets.pubYears,
      withPubs: facets.withPubs,
      mentors: facets.mentors.map((c) => {
        const m = names.get(lc(c));
        return m ? { cwid: m.cwid, name: m.name } : { cwid: c, name: c };
      }),
    },
  };
}

export type MentoredPubsFacetOptions = {
  window: MentoredPubsFacetOption[];
  position: MentoredPubsFacetOption[];
  pubYears: MentoredPubsFacetOption[];
  mentors: MentoredPubsFacetOption[];
};

/** The rail's options with their counts, from the UNFILTERED report (module
 *  doc). Window / position keep their fixed order and always list every
 *  value; years newest first, only those with a paper; mentors by learner
 *  count, then name. A selected value is always listed, even at 0. */
export function mentoredPubsFacetOptions(
  report: MentoredPublicationsReport,
  facets: MentoredPubsFacets,
): MentoredPubsFacetOptions {
  const { tests } = predicates(report, facets);
  const pairs = [...pairsOf(report.detail).values()];
  const count = (skip: keyof typeof tests, valuesOf: (p: Pair) => Array<string | null>) => {
    const others = (Object.keys(tests) as Array<keyof typeof tests>).filter((k) => k !== skip);
    const pmids = new Map<string, Set<string>>();
    for (const p of pairs) {
      if (!others.every((k) => tests[k](p))) continue;
      for (const v of valuesOf(p)) {
        if (v === null) continue;
        let s = pmids.get(v);
        if (!s) pmids.set(v, (s = new Set()));
        s.add(p.pmid);
      }
    }
    return (v: string) => pmids.get(v)?.size ?? 0;
  };

  const winCount = count("window", (p) => [p.window]);
  const posCount = count("position", (p) => [p.position]);
  const yearCount = count("pubYears", (p) => [p.year === null ? null : String(p.year)]);
  const years = new Set<number>(facets.pubYears);
  for (const p of pairs) if (p.year !== null) years.add(p.year);

  // Mentor: learners per mentor, over the learners the other facets leave
  // with a paper when "hide learners with no publications" is on.
  const withPaper = new Set(
    pairs
      .filter((p) => tests.window(p) && tests.position(p) && tests.pubYears(p))
      .map((p) => p.learner),
  );
  const mentorCounts = new Map<string, { label: string; count: number }>();
  for (const r of report.summary) {
    const counted = !facets.withPubs || withPaper.has(r.cwid);
    for (const m of r.mentors) {
      const key = lc(m.cwid);
      const e = mentorCounts.get(key) ?? { label: m.name, count: 0 };
      if (counted) e.count += 1;
      mentorCounts.set(key, e);
    }
  }
  for (const c of facets.mentors) if (!mentorCounts.has(lc(c))) mentorCounts.set(lc(c), { label: c, count: 0 });

  return {
    window: MENTORED_PUBS_WINDOWS.map((v) => ({ value: v, label: WINDOW_FACET_LABEL[v], count: winCount(v) })),
    position: MENTORED_PUBS_POSITIONS.map((v) => ({
      value: v,
      label: POSITION_FACET_LABEL[v],
      count: posCount(v),
    })),
    pubYears: [...years]
      .sort((a, b) => b - a)
      .map((y) => ({ value: String(y), label: String(y), count: yearCount(String(y)) })),
    mentors: [...mentorCounts]
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}
