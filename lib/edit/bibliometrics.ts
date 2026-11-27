/**
 * The per-scholar Bibliometrics report (`EDIT_BIBLIOMETRICS`): one section
 * model, built here from plain rows, that the `/edit` tab and the Word
 * download both render, so the two cannot disagree.
 *
 * Pure on purpose: no database import, so the client island can import the
 * types and the tests need no mocks. The loader is `bibliometrics-loader.ts`.
 */
import type { PolicyCitingDoc } from "@/lib/api/publication-detail";
import { formatVolIssuePages } from "@/lib/citation";
import { toPolicyRollup } from "@/lib/citations/policy-rollup";
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

/** Patents citing the scholar's work. Every visible publication counts, of
 *  any type: the same papers the Excel download lists. */
export type BibliometricsPatents = {
  /** The scholar's papers cited in a patent. */
  papers: number;
  /** Distinct inventions citing them, filled by the loader. */
  inventions: number;
  /** Where the patent data ends ("31 December 2025"), filled by the loader. */
  dataEnd: string | null;
  /** Report 25 filtered to this scholar, filled by the route; null when the
   *  viewer may not open that report. */
  reportHref: string | null;
};

export type BibliometricsReport = {
  scholar: { cwid: string; name: string };
  /** ISO date the figures were calculated. */
  asOf: string;
  filters: BibliometricsFilters;
  /** Publication years of the research articles, for the filter selects. */
  yearRange: { min: number; max: number } | null;
  /** Sentences that follow the scholar's name; empty below the minimum. */
  summary: string[];
  metrics: {
    hIndex: number;
    h5Index: number;
    ratedArticles: number;
    unratedArticles: number;
    /** Share of rated articles at or above the 90th NIH percentile. */
    topDecilePct: number | null;
  };
  output: {
    first: number;
    senior: number;
    coAuthor: number;
    total: number;
    byYear: Array<{ year: number; count: number }>;
  };
  papers: { rows: BibliometricsPaper[]; matching: number };
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
    reviewTotal: p.reviewCount,
  };
}

function summarySentences(args: {
  total: number;
  since: number | null;
  lead: number;
  rated: number;
  topDecilePct: number | null;
  guidelinePapers: number;
  authorityPapers: number;
  bodies: string[];
}): string[] {
  // The minimum-paper rule: too few rated articles to say anything about them.
  if (args.rated < BIBLIOMETRICS_MIN_RATED_ARTICLES) return [];
  const out = [
    `has published ${count(args.total, "research article")}${args.since ? ` since ${args.since}` : ""}, ` +
      `${args.lead.toLocaleString("en-US")} as first or senior author.`,
    `Of the ${count(args.rated, "article")} with an NIH percentile, ${args.topDecilePct}% rank in the ` +
      "top 10% of NIH-funded papers in their field and year.",
  ];
  const from = args.bodies.map((b) => BODY_PHRASE[b] ?? b);
  const authorities =
    from.length > 1 ? `${from.slice(0, -1).join(", ")} or ${from[from.length - 1]}` : (from[0] ?? "");
  const cited = (n: number) => `${count(n, "article is", "articles are")} cited`;
  if (args.guidelinePapers > 0 && args.authorityPapers > 0) {
    out.push(
      `${cited(args.guidelinePapers)} in clinical practice guidelines, and ` +
        `${args.authorityPapers.toLocaleString("en-US")} in documents from ${authorities}.`,
    );
  } else if (args.guidelinePapers > 0) {
    out.push(`${cited(args.guidelinePapers)} in clinical practice guidelines.`);
  } else if (args.authorityPapers > 0) {
    out.push(`${cited(args.authorityPapers)} in documents from ${authorities}.`);
  }
  return out;
}

const DEFINITIONS: BibliometricsReport["definitions"] = [
  {
    term: "Research articles",
    text: "Original research as PubMed and ReCiter classify it. Reviews, editorials, letters and other types are not counted, except in the h-index and h5-index.",
  },
  {
    term: "NIH percentile and citation ratio",
    text: "NIH iCite. A paper needs about two years of citations before it is rated.",
  },
  {
    term: "h-index and h5-index",
    text: "Calculated from NIH iCite citation counts across all publications. The h5-index counts only papers added to PubMed in the last five years.",
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
}): BibliometricsReport {
  const { scholar, filters, now } = input;
  const articles = input.visible.filter((p) => p.publicationType === RESEARCH_ARTICLE);

  const byPosition = { first: 0, senior: 0, co: 0 };
  for (const p of articles) byPosition[positionOf(p)]++;

  const years = articles.flatMap((p) => (p.year ? [p.year] : []));
  const yearRange = years.length > 0 ? { min: Math.min(...years), max: Math.max(...years) } : null;
  // The campus calendar date: a late-evening load must not read as tomorrow.
  const asOf = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const thisYear = Number(asOf.slice(0, 4));
  const byYear = Array.from({ length: YEARS_CHARTED }, (_, i) => {
    const year = thisYear - YEARS_CHARTED + 1 + i;
    return { year, count: years.filter((y) => y === year).length };
  });

  const rated = articles.filter((p) => p.nihPercentile !== null);
  const topDecilePct =
    rated.length > 0
      ? Math.round((rated.filter((p) => p.nihPercentile! >= TOP_DECILE).length / rated.length) * 100)
      : null;

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

  const matching = rankPapers(
    articles.filter(
      (p) =>
        (filters.authorship === "all" || positionOf(p) !== "co") &&
        (filters.yearFrom === null || (p.year !== null && p.year >= filters.yearFrom)) &&
        (filters.yearTo === null || (p.year !== null && p.year <= filters.yearTo)),
    ),
  );
  const surname = (scholar.name.split(",")[0] ?? "").trim().split(/\s+/).pop()?.toLowerCase() ?? "";

  return {
    scholar: { cwid: scholar.cwid, name: scholar.name },
    asOf,
    filters,
    yearRange,
    summary: summarySentences({
      total: articles.length,
      since: yearRange?.min ?? null,
      lead: byPosition.first + byPosition.senior,
      rated: rated.length,
      topDecilePct,
      guidelinePapers: policy[1]!.papers,
      authorityPapers: policy[0]!.papers,
      bodies,
    }),
    metrics: {
      // ReCiter's figure when Scholars has one (faculty); the same sum otherwise.
      hIndex: scholar.hIndex ?? hIndexOf(input.all.map((p) => p.citedByCount ?? 0)),
      h5Index: h5IndexOf(input.all, now),
      ratedArticles: rated.length,
      unratedArticles: articles.length - rated.length,
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
    policy,
    patents: {
      papers: input.visible.filter((p) => p.patentFamilyCount > 0).length,
      inventions: 0,
      dataEnd: null,
      reportHref: null,
    },
    definitions: DEFINITIONS,
  };
}

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

/** "98.4", or the label for a paper iCite has not rated. */
export function percentileText(p: Pick<BibliometricsPaper, "nihPercentile">): string {
  return p.nihPercentile === null ? "Not yet rated" : p.nihPercentile.toFixed(1);
}
