/**
 * The per-scholar Bibliometrics report (`EDIT_BIBLIOMETRICS`): one section
 * model, built here from plain rows, that the `/edit` tab and the Word
 * download both render, so the two cannot disagree.
 *
 * Pure on purpose: no database import, so the client island can import the
 * types and the tests need no mocks. The loader is `bibliometrics-loader.ts`.
 */
import type { PolicyCitingDoc } from "@/lib/api/publication-detail";
import type { CitingInvention, ScholarInvention } from "@/lib/citations/trials-patents";
import { formatVolIssuePages } from "@/lib/citation";
import { toPolicyRollup } from "@/lib/citations/policy-rollup";
import {
  displayStage,
  emptyCounts,
  STAGE_BUCKETS,
  STAGE_RULE,
  stagedShares,
  type StageBucket,
  type StageCounts,
  type StageShares,
} from "@/lib/translational-stage";
import { htmlToPlainText } from "@/lib/utils";

/** EDIT_BIBLIOMETRICS — gates the "Bibliometrics" Tools rail item and its route. */
export function isBibliometricsEnabled(): boolean {
  return process.env.EDIT_BIBLIOMETRICS === "on";
}

/** Narrative sentences need at least this many research articles that have an
 *  NIH percentile; below it the figures still show (plan, open decision 3). */
export const BIBLIOMETRICS_MIN_RATED_ARTICLES = 10;
/** How many papers "Most impactful papers" lists. */
export const BIBLIOMETRICS_TOP_PAPERS = 10;
/** ReCiter's canonical type for original research; the report's population. */
const RESEARCH_ARTICLE = "Academic Article";
const TOP_DECILE = 90;
const YEARS_CHARTED = 10;

export type BibliometricsFilters = {
  /** `lead` keeps first- or senior-authored papers only. */
  authorship: "all" | "lead";
  yearFrom: number | null;
  yearTo: number | null;
};

/**
 * Whether a research article falls inside the filters. Every section but the
 * h-index and h5-index counts only these; the loader reads citing documents
 * and patents for the same set.
 */
export function inScope(
  p: Pick<BibliometricsPubRow, "year" | "isFirst" | "isLast">,
  f: BibliometricsFilters,
): boolean {
  return (
    (f.authorship === "all" || positionOf(p) !== "co") &&
    (f.yearFrom === null || (p.year !== null && p.year >= f.yearFrom)) &&
    (f.yearTo === null || (p.year !== null && p.year <= f.yearTo))
  );
}

export function parseBibliometricsFilters(params: URLSearchParams): BibliometricsFilters {
  const year = (key: string) => {
    const n = Number(params.get(key));
    return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
  };
  return {
    authorship: params.get("authorship") === "lead" ? "lead" : "all",
    yearFrom: year("from"),
    yearTo: year("to"),
  };
}

/** One confirmed authorship of the scholar, joined to its publication. */
export type BibliometricsPubRow = {
  pmid: string;
  title: string;
  authorsString: string | null;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  publicationType: string | null;
  /** Scopus, the count the public profile shows. */
  citationCount: number;
  /** NIH iCite. */
  citedByCount: number | null;
  nihPercentile: number | null;
  relativeCitationRatio: number | null;
  dateAddedToEntrez: Date | null;
  authorityBodies: unknown;
  authorityCount: number;
  guidelineCount: number;
  consensusCount: number;
  reviewCount: number;
  /** Distinct inventions (patent families) citing the paper: the stored rollup. */
  patentFamilyCount: number;
  /** Raw ReCiterAI stage and confidence; `displayStage` decides what counts. */
  translationalStage?: string | null;
  translationalStageConfidence?: string | null;
  /** The scholar's 1-based place in the author list. */
  position: number;
  isFirst: boolean;
  isLast: boolean;
};

export type BibliometricsPosition = "first" | "senior" | "co";

export type BibliometricsPaper = {
  pmid: string;
  /** PubMed HTML, sanitized by the renderer. */
  title: string;
  /** First three authors; `bold` marks the scholar when among them. */
  authors: Array<{ name: string; bold: boolean }>;
  etAl: boolean;
  /** The paper's WCM authors in byline order, filled by the loader. */
  wcmAuthors: Array<{ cwid: string; name: string }>;
  journal: string | null;
  /** "2014;59(6):765-73" */
  dated: string;
  /** Publication year; the tab marks a percentile early for the last two. */
  year: number | null;
  doi: string | null;
  position: BibliometricsPosition;
  nihPercentile: number | null;
  relativeCitationRatio: number | null;
  citationCount: number;
  authority: Array<{ body: string; count: number }>;
  guidelines: number;
  consensus: number;
  reviews: number;
  /** Inventions (patent families) citing the paper. */
  patents: number;
  /** Citing documents, filled by the loader for listed papers that have any. */
  citing: PolicyCitingDoc[];
  /** Citing inventions, newest first, as the publication modal lists them;
   *  filled by the loader for listed papers that have any. */
  citingPatents: { items: CitingInvention[]; total: number } | null;
  reviewTotal: number;
};

export type BibliometricsPolicyLevel = {
  level: PolicyCitingDoc["level"];
  label: string;
  /** The scholar's research articles cited at this level. */
  papers: number;
  /** Distinct citing documents, filled by the loader. */
  documents: number;
  /** Authority level only: distinct documents per issuing body. */
  bodies: Array<{ body: string; count: number }>;
};

/** Patents citing the scholar's research articles inside the filters. The
 *  Excel download still lists every visible publication of any type. */
export type BibliometricsPatents = {
  /** The scholar's papers cited in a patent. */
  papers: number;
  /** Distinct inventions citing them, filled by the loader. */
  inventions: number;
  /** The inventions, most of the scholar's papers cited first (the first
   *  `TRIAL_PATENT_CAP`), filled by the loader. Shown to every viewer of the tab. */
  list: ScholarInvention[];
  /** Where the patent data ends ("31 December 2025"), filled by the loader. */
  dataEnd: string | null;
  /** Report 25 filtered to this scholar, filled by the route; null when the
   *  viewer may not open that report. */
  reportHref: string | null;
};

/** One paper in a stage's list. */
export type BibliometricsStagePaper = { pmid: string; title: string; journal: string | null; year: number | null };

/** The research articles matching the filters, by translational stage
 *  (report 26's rule). Each bucket lists the papers it counts, newest first. */
export type BibliometricsStages = {
  counts: StageCounts;
  /** Whole percents of the four T stages among papers WITH a stage, adding up
   *  to 100 (`stagedShares`, report 26's rule). No stage has no share. */
  shares: StageShares;
  papers: Record<StageBucket, BibliometricsStagePaper[]>;
  /** Report 26 for this scholar, filled by the route; null when the viewer may
   *  not open that report. */
  portfolioHref: string | null;
};

export type BibliometricsReport = {
  scholar: { cwid: string; name: string };
  /** ISO date the figures were calculated. */
  asOf: string;
  filters: BibliometricsFilters;
  /** Publication years of every research article (unfiltered), for the selects. */
  yearRange: { min: number; max: number } | null;
  /** Sentences that follow the scholar's name; empty below the minimum. */
  summary: string[];
  metrics: {
    hIndex: number;
    h5Index: number;
    ratedArticles: number;
    unratedArticles: number;
    /** Rated articles at or above the 90th NIH percentile. */
    topDecileArticles: number;
    /** Share of rated articles at or above the 90th NIH percentile. */
    topDecilePct: number | null;
  };
  /** Research articles inside the filters: everything below except the
   *  h-index and h5-index counts only these. */
  output: {
    first: number;
    senior: number;
    coAuthor: number;
    total: number;
    /** Research articles per year, and the same split by author position. */
    byYear: Array<{ year: number; count: number; first: number; senior: number; co: number }>;
  };
  papers: { rows: BibliometricsPaper[]; matching: number };
  /** Null while stage data is off (`SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET`). */
  stages: BibliometricsStages | null;
  policy: BibliometricsPolicyLevel[];
  patents: BibliometricsPatents;
  definitions: Array<{ term: string | null; text: string }>;
};

export const POLICY_LEVEL_LABELS: ReadonlyArray<[PolicyCitingDoc["level"], string]> = [
  ["authority", "Health authorities and national academies"],
  ["guideline", "Clinical practice guidelines"],
  ["consensus", "Consensus statements"],
  ["review", "Systematic reviews and meta-analyses"],
];

/** The largest h such that h papers each have at least h citations. */
export function hIndexOf(citations: readonly number[]): number {
  const sorted = [...citations].sort((a, b) => b - a);
  let h = 0;
  while (h < sorted.length && sorted[h]! >= h + 1) h++;
  return h;
}

/**
 * h-index over papers added to PubMed in the five years before `now`, on NIH
 * iCite citation counts. This mirrors ReCiter's `h5indexNIH`, the sibling of
 * the `hindexNIH` that `Scholar.hIndex` carries, so the two figures on the
 * page share one basis. A row with no Entrez date falls back to 1 January of
 * its publication year.
 */
export function h5IndexOf(
  pubs: ReadonlyArray<Pick<BibliometricsPubRow, "citedByCount" | "dateAddedToEntrez" | "year">>,
  now: Date,
): number {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 5);
  return hIndexOf(
    pubs
      .filter((p) => {
        const added = p.dateAddedToEntrez ?? (p.year ? new Date(Date.UTC(p.year, 0, 1)) : null);
        return added !== null && added > cutoff;
      })
      .map((p) => p.citedByCount ?? 0),
  );
}

export function positionOf(p: Pick<BibliometricsPubRow, "isFirst" | "isLast">): BibliometricsPosition {
  // A sole author is both; counted once, as first.
  return p.isFirst ? "first" : p.isLast ? "senior" : "co";
}

// Publication Manager sorts `authorPosition desc`: last, first, then the rest.
const POSITION_RANK: Record<BibliometricsPosition, number> = { senior: 0, first: 1, co: 2 };

/**
 * Publication Manager's order without the Mendeley tie-breaker: NIH
 * percentile, author position, citation ratio, citation count. Papers with no
 * percentile follow the rated ones.
 */
export function rankPapers<T extends BibliometricsPubRow>(pubs: readonly T[]): T[] {
  return [...pubs].sort(
    (a, b) =>
      (b.nihPercentile ?? -1) - (a.nihPercentile ?? -1) ||
      POSITION_RANK[positionOf(a)] - POSITION_RANK[positionOf(b)] ||
      (b.relativeCitationRatio ?? -1) - (a.relativeCitationRatio ?? -1) ||
      b.citationCount - a.citationCount ||
      a.pmid.localeCompare(b.pmid),
  );
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const BODY_PHRASE: Readonly<Record<string, string>> = {
  WHO: "the WHO",
  CDC: "the CDC",
  "National Academies": "the National Academies",
};

function toPaper(p: BibliometricsPubRow, surname: string): BibliometricsPaper {
  // `authorsString` wraps WCM authors as "((Name))"; the markers never show.
  const names = (p.authorsString ?? "").replace(/\(\(|\)\)/g, "").split(", ").filter(Boolean);
  const rollup = toPolicyRollup(p);
  const locator = formatVolIssuePages(p.volume, p.issue, p.pages);
  return {
    pmid: p.pmid,
    title: p.title,
    // First three then "et al.", as the public modal lists citing documents.
    // The scholar is bold only when the name in their slot carries their surname.
    authors: names.slice(0, 3).map((name, i) => ({
      name,
      bold: i === p.position - 1 && surname !== "" && name.toLowerCase().includes(surname),
    })),
    etAl: names.length > 3,
    wcmAuthors: [],
    journal: p.journal ? htmlToPlainText(p.journal, Number.POSITIVE_INFINITY) : null,
    dated: [p.year, locator].filter(Boolean).join(";"),
    year: p.year,
    doi: p.doi,
    position: positionOf(p),
    nihPercentile: p.nihPercentile,
    relativeCitationRatio: p.relativeCitationRatio,
    citationCount: p.citationCount,
    authority: rollup?.authority ?? [],
    guidelines: p.guidelineCount,
    consensus: p.consensusCount,
    reviews: p.reviewCount,
    patents: p.patentFamilyCount,
    citing: [],
    citingPatents: null,
    reviewTotal: p.reviewCount,
  };
}

function summarySentences(args: {
  total: number;
  /** "since 2016", "from 2016 to 2020", or "" with no years at all. */
  span: string;
  /** True under "First or senior author only": every article counted is lead. */
  leadOnly: boolean;
  lead: number;
  rated: number;
  topDecile: number;
  topDecilePct: number | null;
  guidelinePapers: number;
  authorityPapers: number;
  patentPapers: number;
  bodies: string[];
}): string[] {
  // The minimum-paper rule: too few rated articles to say anything about them.
  if (args.rated < BIBLIOMETRICS_MIN_RATED_ARTICLES) return [];
  const span = args.span ? ` ${args.span}` : "";
  const out = [
    args.leadOnly
      ? `has published ${count(args.total, "research article")} as first or senior author${span}.`
      : `has published ${count(args.total, "research article")}${span}, ` +
        `${args.lead.toLocaleString("en-US")} as first or senior author.`,
    // The count and the baseline: "11%" alone reads as average to anyone who
    // does not know 10% is expected.
    `Of the ${count(args.rated, "article")} with an NIH percentile, ${args.topDecile.toLocaleString("en-US")} ` +
      `(${args.topDecilePct}%) ${args.topDecile === 1 ? "is" : "are"} in the top 10% of NIH-funded papers ` +
      "for their field and year, where 10% is expected.",
  ];
  const from = args.bodies.map((b) => BODY_PHRASE[b] ?? b);
  const authorities =
    from.length > 1 ? `${from.slice(0, -1).join(", ")} or ${from[from.length - 1]}` : (from[0] ?? "");
  // "19 articles are cited in clinical practice guidelines, 84 in documents
  // from …, and 8 in patents." Each clause only when its count is above zero.
  const clauses = (
    [
      [args.guidelinePapers, "in clinical practice guidelines"],
      [args.authorityPapers, `in documents from ${authorities}`],
      [args.patentPapers, "in patents"],
    ] as const
  ).filter(([n]) => n > 0);
  if (clauses.length > 0) {
    const parts = clauses.map(([n, where], i) =>
      i === 0 ? `${count(n, "article is", "articles are")} cited ${where}` : `${n.toLocaleString("en-US")} ${where}`,
    );
    out.push(
      `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}` : parts[0]}.`,
    );
  }
  return out;
}

/** "since 2016" or "from 2016 to 2020": the years the summary covers. */
function spanOf(filters: BibliometricsFilters, years: readonly number[], thisYear: number): string {
  if (years.length === 0) return "";
  const from = filters.yearFrom ?? Math.min(...years);
  const to = filters.yearTo;
  if (to !== null && to < thisYear) return from === to ? `in ${to}` : `from ${from} to ${to}`;
  return `since ${from}`;
}

const DEFINITIONS: BibliometricsReport["definitions"] = [
  {
    term: "Research articles",
    text: "Original research as PubMed and ReCiter classify it. Reviews, editorials, letters and other types are not counted, except in the h-index and h5-index.",
  },
  {
    term: "NIH percentile and citation ratio",
    text: "NIH iCite. Recent papers are rated too, but for their first two years or so the figures rest on few citations and can still move; the papers list marks those percentiles early.",
  },
  {
    term: "h-index and h5-index",
    text: "Calculated from NIH iCite citation counts across all publications. The h5-index counts only papers added to PubMed in the last five years. Neither follows the Authorship and year filters; every other figure does.",
  },
  { term: "Cited by", text: "Scopus, the count shown on the public profile." },
  {
    term: "Guideline and policy citations",
    text: "PubMed, NIH iCite and NCBI Bookshelf. Covers documents those sources index, so some citing guidelines and reports are not listed.",
  },
  {
    term: null,
    text: "Corrections to the publication list are made in Publications. The figures here follow from it.",
  },
];

/**
 * Build the report from the scholar's authorships.
 *
 * `visible` is what the profile shows (hidden and never-displayed papers
 * removed); `all` is every confirmed authorship, which the h5-index uses so it
 * sits on the same footing as the ReCiter h-index beside it. The loader fills
 * `papers.rows[].citing` and `policy[].documents` afterwards.
 */
export function buildBibliometricsReport(input: {
  scholar: { cwid: string; name: string; hIndex: number | null };
  visible: readonly BibliometricsPubRow[];
  all: readonly BibliometricsPubRow[];
  filters: BibliometricsFilters;
  now: Date;
  /** `resolveSearchPubsTranslationalStageFacet()`, read by the loader. */
  stagesEnabled?: boolean;
}): BibliometricsReport {
  const { scholar, filters, now } = input;
  const allArticles = input.visible.filter((p) => p.publicationType === RESEARCH_ARTICLE);
  const allYears = allArticles.flatMap((p) => (p.year ? [p.year] : []));
  const yearRange = allYears.length > 0 ? { min: Math.min(...allYears), max: Math.max(...allYears) } : null;
  // Everything below but the h-index and h5-index counts these.
  const articles = allArticles.filter((p) => inScope(p, filters));

  const byPosition = { first: 0, senior: 0, co: 0 };
  for (const p of articles) byPosition[positionOf(p)]++;

  const years = articles.flatMap((p) => (p.year ? [p.year] : []));
  const positionsIn = (year: number) => {
    const n = { first: 0, senior: 0, co: 0 };
    for (const p of articles) if (p.year === year) n[positionOf(p)]++;
    return n;
  };
  // The campus calendar date: a late-evening load must not read as tomorrow.
  const asOf = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const thisYear = Number(asOf.slice(0, 4));
  // The ten years ending at the "to" year (this year by default), never
  // reaching back before the "from" year.
  const lastYear = Math.min(thisYear, filters.yearTo ?? thisYear);
  const firstYear = Math.max(lastYear - YEARS_CHARTED + 1, filters.yearFrom ?? -Infinity);
  const byYear = Array.from({ length: Math.max(0, lastYear - firstYear + 1) }, (_, i) => {
    const year = firstYear + i;
    return { year, count: years.filter((y) => y === year).length, ...positionsIn(year) };
  });

  const rated = articles.filter((p) => p.nihPercentile !== null);
  const topDecileArticles = rated.filter((p) => p.nihPercentile! >= TOP_DECILE).length;
  const topDecilePct = rated.length > 0 ? Math.round((topDecileArticles / rated.length) * 100) : null;

  const policy = POLICY_LEVEL_LABELS.map(([level, label]) => ({
    level,
    label,
    papers: articles.filter(
      (p) =>
        ({ authority: p.authorityCount, guideline: p.guidelineCount, consensus: p.consensusCount, review: p.reviewCount })[
          level
        ] > 0,
    ).length,
    documents: 0,
    bodies: [] as Array<{ body: string; count: number }>,
  }));
  const bodies = [
    ...new Set(articles.flatMap((p) => toPolicyRollup(p)?.authority.map((a) => a.body) ?? [])),
  ].sort();
  const patentPapers = articles.filter((p) => p.patentFamilyCount > 0).length;

  const matching = rankPapers(articles);
  const surname = (scholar.name.split(",")[0] ?? "").trim().split(/\s+/).pop()?.toLowerCase() ?? "";

  return {
    scholar: { cwid: scholar.cwid, name: scholar.name },
    asOf,
    filters,
    yearRange,
    summary: summarySentences({
      total: articles.length,
      span: spanOf(filters, years, thisYear),
      leadOnly: filters.authorship === "lead",
      lead: byPosition.first + byPosition.senior,
      rated: rated.length,
      topDecile: topDecileArticles,
      topDecilePct,
      guidelinePapers: policy[1]!.papers,
      authorityPapers: policy[0]!.papers,
      patentPapers,
      bodies,
    }),
    metrics: {
      // ReCiter's figure when Scholars has one (faculty); the same sum otherwise.
      hIndex: scholar.hIndex ?? hIndexOf(input.all.map((p) => p.citedByCount ?? 0)),
      h5Index: h5IndexOf(input.all, now),
      ratedArticles: rated.length,
      unratedArticles: articles.length - rated.length,
      topDecileArticles,
      topDecilePct,
    },
    output: {
      first: byPosition.first,
      senior: byPosition.senior,
      coAuthor: byPosition.co,
      total: articles.length,
      byYear,
    },
    papers: {
      rows: matching.slice(0, BIBLIOMETRICS_TOP_PAPERS).map((p) => toPaper(p, surname)),
      matching: matching.length,
    },
    stages: input.stagesEnabled ? stagesOf(matching) : null,
    policy,
    patents: {
      papers: patentPapers,
      inventions: 0,
      list: [],
      dataEnd: null,
      reportHref: null,
    },
    definitions: input.stagesEnabled ? [...DEFINITIONS.slice(0, -1), STAGE_DEFINITION, DEFINITIONS.at(-1)!] : DEFINITIONS,
  };
}

const STAGE_DEFINITION = { term: "Translational stage", text: STAGE_RULE };

function stagesOf(pubs: readonly BibliometricsPubRow[]): BibliometricsStages {
  const counts = emptyCounts();
  const papers = Object.fromEntries(STAGE_BUCKETS.map((k) => [k, []])) as unknown as BibliometricsStages["papers"];
  const newest = [...pubs].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.pmid.localeCompare(a.pmid));
  for (const p of newest) {
    const k = displayStage(p.translationalStage, p.translationalStageConfidence) ?? "none";
    counts[k]++;
    papers[k].push({
      pmid: p.pmid,
      title: p.title,
      journal: p.journal ? htmlToPlainText(p.journal, Number.POSITIVE_INFINITY) : null,
      year: p.year,
    });
  }
  return { counts, shares: stagedShares(counts), papers, portfolioHref: null };
}

/** What the stage section counts, under its heading. */
export const STAGES_NOTE =
  "Research articles matching the Authorship and year filters above. Shares are among papers with a stage. Select a count to list its papers.";

/** "Senior", "First", "Co-author" */
export const POSITION_LABEL: Record<BibliometricsPosition, string> = {
  first: "First",
  senior: "Senior",
  co: "Co-author",
};

/** The query string that carries the on-screen filters to the route. */
export function bibliometricsQuery(cwid: string, f: BibliometricsFilters): string {
  const q = new URLSearchParams({ cwid });
  if (f.authorship === "lead") q.set("authorship", "lead");
  if (f.yearFrom !== null) q.set("from", String(f.yearFrom));
  if (f.yearTo !== null) q.set("to", String(f.yearTo));
  return q.toString();
}

// ── wording both renderings share ───────────────────────────────────────────

export const NO_SUMMARY_NOTE =
  `A written summary needs at least ${BIBLIOMETRICS_MIN_RATED_ARTICLES} research articles with an NIH percentile. ` +
  "The figures below are complete.";

export const TOP_DECILE_LABEL = "of rated articles in the top 10% by NIH percentile";

/** Null when every research article is rated. */
export function unratedNote(r: BibliometricsReport): string | null {
  const n = r.metrics.unratedArticles;
  if (n === 0) return null;
  return `${count(n, "article has", "articles have")} no NIH percentile, usually because ${
    n === 1 ? "it is" : "they are"
  } too recent, and ${n === 1 ? "is" : "are"} not counted in the share.`;
}

export function papersNote(r: BibliometricsReport): string {
  return (
    "Ranked by NIH percentile, then author position, citation ratio and citation count. " +
    `Showing ${r.papers.rows.length} of ${r.papers.matching.toLocaleString("en-US")}.`
  );
}

/** "First or senior author only · published 2015 to 2024", or null with no filter set. */
export function filtersNote(f: BibliometricsFilters): string | null {
  const parts = [
    f.authorship === "lead" ? "First or senior author only" : null,
    f.yearFrom !== null && f.yearTo !== null
      ? `published ${f.yearFrom} to ${f.yearTo}`
      : f.yearFrom !== null
        ? `published ${f.yearFrom} or later`
        : f.yearTo !== null
          ? `published ${f.yearTo} or earlier`
          : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "12 papers cited by 30 patented inventions"; null when no patent cites the work. */
export function patentsLine(p: BibliometricsPatents): string | null {
  // A stale rollup with no live links would read "cited by 0": say nothing.
  if (p.papers === 0 || p.inventions === 0) return null;
  return `${count(p.papers, "paper")} cited by ${count(p.inventions, "patented invention")}`;
}

/** The limit of the patent data, on the tab and in the download. */
export const OWN_PATENTS_NOTE =
  "Patents on which the scholar is an inventor are not separated out.";

/** The Excel download of every patent citing the scholar's work. */
export const PATENTS_DOWNLOAD_PATH = "/api/edit/bibliometrics/patents";
export const PATENTS_DOWNLOAD_LABEL = "Download patents citing this work (Excel)";

/** Help text behind the tab's info marks, beside each metric's label. */
export const METRIC_HELP = {
  hIndex:
    "The largest h such that h of the scholar's publications each have at least h citations, on NIH iCite counts, across all publications. Does not follow the filters.",
  h5Index:
    "The h-index of the publications added to PubMed in the last five years, on NIH iCite counts. Does not follow the filters.",
  topDecile:
    "Rated research articles at or above the 90th NIH percentile for their field and year. By definition 10% of NIH-funded papers are, so 10% is the baseline.",
  percentile:
    "NIH iCite percentile among NIH-funded papers of the same field and year. Marked early for papers from this year and last: they rest on few citations and can still move.",
  citationRatio:
    "NIH iCite relative citation ratio: citations per year against NIH-funded papers in the same field. 1.0 matches the median NIH-funded paper.",
  citedBy: "Scopus citation count, the one the public profile shows. The h-index uses NIH iCite counts instead.",
} as const;

/** True for a paper from this year or last: its percentile is an early figure. */
export function isEarlyPercentile(p: Pick<BibliometricsPaper, "year" | "nihPercentile">, asOf: string): boolean {
  return p.nihPercentile !== null && p.year !== null && p.year >= Number(asOf.slice(0, 4)) - 1;
}

/** "98.4", or the label for a paper iCite has not rated. */
export function percentileText(p: Pick<BibliometricsPaper, "nihPercentile">): string {
  return p.nihPercentile === null ? "Not yet rated" : p.nihPercentile.toFixed(1);
}
