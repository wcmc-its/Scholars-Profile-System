/**
 * Scrape CTL's public technology portfolio (innovation.weill.cornell.edu).
 *
 * Attribution comes from the VIVO link CTL already prints beside each
 * "Principal Investigator" (`vivo.{weill,med}.cornell.edu/display/cwid-<cwid>`),
 * so a technology is joined to a scholar by identifier, never by name.
 *
 * Pages with no VIVO link are skipped — 60 of 279 as of 2026-07-09. They are a
 * mix: departed faculty (Cantley, Silverstein, Vahdat, Hla), people who would
 * never hold a `scholar` row (a resident, a senior technician), and current
 * faculty CTL simply did not link (Michelle Bradbury, `msb2006`). Recovering
 * them is a data-quality ask for CTL, NOT a name-matching problem — do not be
 * tempted to fuzzy-match, and do not attribute by PMID either: CTL's linked
 * papers average 3.2 scholar-authors, of whom at most one is the inventor.
 *
 * ponytail: this parses Drupal HTML with regexes because CTL exposes no
 * structured feed (`/jsonapi` 404s; sitemap.xml omits the portfolio). Every
 * shape assumption below is asserted, so a markup change throws instead of
 * silently yielding zero rows. If CTL ever ships a CSV/JSON export, delete this
 * file and read the export instead.
 */
import { CTL_ORIGIN, type TechnologyRow } from "./seed";

const ORIGIN = CTL_ORIGIN.replace(/\/$/, "");
const LISTING = `${ORIGIN}/technology-portfolio`;
const DETAIL_RE = /\/industry-investors-partners\/technology-portfolio\/[a-z0-9-]+/g;
const CWID_RE = /cwid-([A-Za-z0-9]+)/;

/** Hard ceiling on listing pages, so a pager bug can't spin forever. */
const MAX_LISTING_PAGES = 100;

export type ScrapeResult = {
  rows: TechnologyRow[];
  /** Detail pages seen, including ones that yielded no row. */
  pages: number;
  /** Detail pages that returned non-2xx (CTL links a few dead nodes). */
  fetchFailed: number;
  /** Detail pages carrying a PI but no VIVO/cwid link — the attribution gap. */
  pagesWithoutCwidLink: number;
};

type Fetcher = (url: string) => Promise<string | null>;

/**
 * Fetch one page, or null when it is genuinely unavailable.
 *
 * Retries transient failures: a single reset socket partway through a ~280-page
 * sequential walk would otherwise abort the whole weekly run. A page that is
 * still failing after the retries returns null and is counted in `fetchFailed`,
 * which shrinks the row count — the importer's volume guard is the backstop that
 * stops a bad crawl from truncating the table.
 */
const defaultFetch: Fetcher = async (url) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "WCM-Scholars-ETL/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null; // CTL links a few dead nodes (e.g. /rpe)
      if (res.ok) return await res.text();
    } catch {
      // transient: DNS, reset socket, timeout — fall through to the backoff
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  return null;
};

/** Collect every detail-page path across the paginated listing. */
export async function listingPaths(get: Fetcher = defaultFetch): Promise<string[]> {
  const paths = new Set<string>();
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    const html = await get(`${LISTING}?page=${page}`);
    if (html === null) break;
    const before = paths.size;
    for (const p of html.match(DETAIL_RE) ?? []) paths.add(p);
    // Drupal serves the last page for any `page=` beyond the end, so stop when a
    // page contributes nothing new rather than trusting the pager markup.
    if (paths.size === before) break;
  }
  return [...paths].sort();
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop C0/C7F control bytes, keeping the newlines we join bullets with. A stray
 * NUL once made git treat a source file as binary (#1602); the same byte must
 * never reach the DB or a public profile either. \x09/\x0a/\x0d are already
 * collapsed to spaces by `stripTags` within each item, so the only newline that
 * survives to here is the one we insert between bullets — preserve it.
 */
function stripControl(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Index of the first match of `re` in `s`, or `s.length` when it never matches. */
function firstIndex(s: string, re: RegExp): number {
  const m = re.exec(s);
  return m ? m.index : s.length;
}

const OVERVIEW_MAX = 8000;

/**
 * The page's "Technology Overview" section as plain text, plus whether it lists
 * a "PoC Data" bullet. Pure — exported for tests.
 *
 * Two markup shapes, both anchored on `<strong>Technology Overview</strong>`:
 * bullet form (134 of 260 harvested pages) follows the header with a `<ul>`
 * whose `<li>` items are the overview; prose form (23) follows it with `<p>` (or
 * `<div>`) paragraphs. Bullets are joined one per line, labels ("The
 * Technology:") kept inline as CTL wrote them, so the profile can render the
 * block with `whitespace-pre-line`.
 *
 * Scoped to the page BODY: the literal string "Technology Overview" also sits in
 * `<meta name="description">` on 103 pages that carry no section, so a body-wide
 * text match would fabricate an overview for ~40% of the portfolio.
 *
 * ponytail: regex over Drupal HTML, the same tax the rest of this file pays. The
 * overview is bounded by the next section header (a `<p>`/`<div>`-wrapped
 * `<strong>`, e.g. "Technology Applications") or a figure; prose additionally
 * stops at the first `<ul>`, which on these pages is a trailing citation list,
 * never overview text. If CTL ships a structured export, delete this.
 */
export function parseOverview(html: string): { overview: string | null; hasPocData: boolean } {
  const headEnd = html.indexOf("</head>");
  const body = headEnd >= 0 ? html.slice(headEnd + "</head>".length) : html;

  const anchor = /<strong>\s*Technology Overview\s*<\/strong>/i.exec(body);
  if (!anchor) return { overview: null, hasPocData: false };

  // Drop the header element's own closing tag (`</p>` or `</div>`).
  const rest = body
    .slice(anchor.index + anchor[0].length)
    .replace(/^\s*<\/(?:p|div)>/i, "");

  // A `<p>`/`<div>`-wrapped `<strong>` (or a figure) starts the next section and
  // ends the overview. `<li><strong>…` bullets are NOT `<p>`/`<div>`, so this
  // never cuts the overview short at "The Technology:" or "PoC Data:".
  const headerEnd = firstIndex(rest, /<(?:p|div)\b[^>]*>\s*(?:<br\s*\/?>\s*)*<strong>|<img\b/i);

  let text: string;
  let hasPocData = false;
  if (/^\s*(?:<br\s*\/?>\s*)*<ul\b/i.test(rest)) {
    // Bullet form: every `<li>` from the run of `<ul>` blocks before the header.
    const region = rest.slice(0, headerEnd);
    const bullets: string[] = [];
    for (const m of region.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const t = stripTags(m[1]);
      if (t) bullets.push(t);
    }
    text = bullets.join("\n");
    hasPocData = /<li\b[^>]*>\s*<strong>\s*PoC Data\s*:/i.test(region);
  } else {
    // Prose form: bounded by the header OR the first `<ul>` (a citation list),
    // whichever comes first. Flowing paragraphs, collapsed to one blob.
    const region = rest.slice(0, Math.min(headerEnd, firstIndex(rest, /<ul\b/i)));
    text = stripTags(region);
  }

  text = stripControl(text).trim();
  if (!text) return { overview: null, hasPocData };
  // Cap generously — the harvested max is ~2k, so this never truncates in
  // practice; slice rather than reject so a future long page still yields text.
  return { overview: text.slice(0, OVERVIEW_MAX), hasPocData };
}

/**
 * Collapse CTL's free-text patent line into one of four display labels.
 *
 * The raw text is prose, not an enum: it ranges from "PCT Application Filed" to
 * `US Patent 9,943,506 . "BCL6 inhibitors as anticancer agents." Issued...`.
 * Truncating that to fit a chip cuts mid-word, so classify instead.
 *
 * Order matters. "Provisional Application Filed" and "US Patent Application:
 * US2022..." both contain words that would otherwise match a later rule — a
 * pending application must never be labelled as an issued patent.
 *
 * Unrecognized text yields null (no chip) rather than an error: CTL is free to
 * invent new phrasing, and a missing chip is a far better failure than a wrong
 * one or a broken weekly run.
 */
export function normalizePatentStatus(raw: string): string | null {
  const s = raw.toLowerCase();
  if (!s.trim()) return null;
  if (/provisional/.test(s)) return "Provisional filed";
  if (/\bpct\b/.test(s)) return "PCT filed";
  if (/application/.test(s)) return "Application filed";
  // A bare patent number with no "application" nearby means it granted.
  if (/\bissued\b|\bgranted\b|patent\s*(no\.?|#)?\s*[\d,]{5,}|patent:\s*[a-z]{2}\d/.test(s)) {
    return "Issued";
  }
  return null;
}

/** The markup block following a `<div class="field-label">LABEL:</div>`. */
function fieldBlock(html: string, label: string): string {
  const re = new RegExp(
    `field-label">\\s*${label}:?\\s*(?:&nbsp;)?\\s*</div>([\\s\\S]*?)(?=<div class="panel-pane|<div class="field-label")`,
    "i",
  );
  return html.match(re)?.[1] ?? "";
}

/** One detail page → zero or more (scholar, technology) rows. Exported for tests. */
export function parseDetail(path: string, html: string): TechnologyRow[] {
  const title = stripTags(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(
    / \| Enterprise Innovation$/,
    "",
  );
  if (!title) return [];

  // Editors wrap the docket number in stray inline markup on some pages
  // (`<span>9220</span>`, `<p><span>11171 </span></p>`, `<span>7932<br></span>`),
  // so strip tags rather than trusting the <li> to hold a bare number. A few
  // pages legitimately carry prose ("3901 and 4055" — one invention, two dockets).
  const referenceRaw = html.match(/Cornell Reference<\/strong><\/p><ul><li>([\s\S]*?)<\/li>/)?.[1];
  const reference = referenceRaw ? stripTags(referenceRaw) || null : null;

  // Patent status. Same `<strong>LABEL</strong></p><ul><li>` shape as the
  // reference, but the <li> usually wraps the status in a Google Patents link
  // ("<a href=...>US Application Filed</a>"), so strip tags for the text and
  // ignore the href — CTL's own page is where someone goes for the patent.
  const patentRaw = html.match(/Patents<\/strong><\/p><ul><li>([\s\S]*?)<\/li>/)?.[1];
  const patentStatus = patentRaw ? normalizePatentStatus(stripTags(patentRaw)) : null;

  // Related papers. Scoped to CTL's dedicated publications pane, NOT the whole
  // page: a stray PubMed link in prose is not a claim about this invention.
  const pubPane = html.match(
    /field-technology-publications"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/,
  )?.[0];
  const pmids = pubPane
    ? [
        ...new Set(
          [...pubPane.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{6,9})/g)].map((m) => m[1]),
        ),
      ]
    : [];

  // The "Technology Overview" section (bullets or prose) + its "PoC Data" flag.
  const { overview, hasPocData } = parseOverview(html);

  const pi = fieldBlock(html, "Principal Investigator");
  const cwids = new Set<string>();
  for (const href of pi.match(/href="([^"]+)"/g) ?? []) {
    const m = href.match(CWID_RE);
    if (m) cwids.add(m[1].toLowerCase());
  }

  return [...cwids].map((cwid) => ({
    cwid,
    reference,
    title,
    url: ORIGIN + path,
    patentStatus,
    pmids,
    overview,
    hasPocData,
  }));
}

/** Fetch the whole portfolio. Throws when the markup stops yielding rows. */
export async function scrapePortfolio(get: Fetcher = defaultFetch): Promise<ScrapeResult> {
  const paths = await listingPaths(get);
  if (paths.length === 0)
    throw new Error("[Technology] listing yielded no pages — markup changed?");

  const rows: TechnologyRow[] = [];
  let fetchFailed = 0;
  let pagesWithoutCwidLink = 0;

  for (const path of paths) {
    const html = await get(ORIGIN + path);
    if (html === null) {
      fetchFailed++;
      continue;
    }
    const parsed = parseDetail(path, html);
    if (parsed.length === 0) pagesWithoutCwidLink++;
    rows.push(...parsed);
  }

  if (rows.length === 0) {
    throw new Error("[Technology] no page carried a VIVO cwid link — markup changed?");
  }

  // The importer's volume guard cannot protect the FIRST load into an empty
  // table, so a half-finished crawl must fail here rather than persist a partial
  // portfolio. CTL links a couple of dead nodes, hence a tolerance rather than 0.
  if (fetchFailed > Math.max(5, paths.length * 0.05)) {
    throw new Error(
      `[Technology] ${fetchFailed}/${paths.length} detail pages failed to fetch — CTL down or rate-limiting?`,
    );
  }

  rows.sort((a, b) => a.cwid.localeCompare(b.cwid) || a.title.localeCompare(b.title));
  return { rows, pages: paths.length, fetchFailed, pagesWithoutCwidLink };
}
