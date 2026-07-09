/**
 * Scrape CTL's public technology portfolio (innovation.weill.cornell.edu).
 *
 * Attribution comes from the VIVO link CTL already prints beside each
 * "Principal Investigator" (`vivo.{weill,med}.cornell.edu/display/cwid-<cwid>`),
 * so a technology is joined to a scholar by identifier, never by name. Pages
 * with no VIVO link are skipped: as of 2026-07-09 that is 60 of 279, and those
 * inventors are overwhelmingly departed faculty with no `scholar` row.
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

const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": "WCM-Scholars-ETL/1.0" } });
  return res.ok ? res.text() : null;
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

  const reference =
    html.match(/Cornell Reference<\/strong><\/p><ul><li>([\s\S]*?)<\/li>/)?.[1]?.trim() || null;

  const pi = fieldBlock(html, "Principal Investigator");
  const cwids = new Set<string>();
  for (const href of pi.match(/href="([^"]+)"/g) ?? []) {
    const m = href.match(CWID_RE);
    if (m) cwids.add(m[1].toLowerCase());
  }

  return [...cwids].map((cwid) => ({ cwid, reference, title, url: ORIGIN + path }));
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

  rows.sort((a, b) => a.cwid.localeCompare(b.cwid) || a.title.localeCompare(b.title));
  return { rows, pages: paths.length, fetchFailed, pagesWithoutCwidLink };
}
