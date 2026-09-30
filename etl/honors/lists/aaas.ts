/**
 * American Association for the Advancement of Science — Fellows.
 *
 * Roster: https://www.aaas.org/fellows/listing — a server-rendered, paginated
 * table (probed 2026-09-25: HTTP 200, 25 rows a page, ~8,000 Fellows). Columns
 * carry per-field classes, so cells are read by class rather than position:
 *   views-field-field-last-name                "Last, First"
 *   views-field-field-year-elected             "2010"
 *   views-field-field-institutional-affiliation "Weill Cornell Medicine"
 *
 * The whole roster is ~320 pages, so the scrape uses the page's own
 * institutional-affiliation search (`field_institutional_affiliation_value`, a
 * substring filter) for "Cornell" and "Weill" and walks only those results.
 * "On list" for this list therefore counts the Fellows those two searches
 * return, not all Fellows. The matcher still applies its own affiliation gate
 * (the "Cornell" search is mostly the Ithaca campus).
 */
import { HONOR_LISTS } from "@/lib/honors/lists";

import type { RosterEntry } from "./match";
import { splitSortName } from "./match";
import { type Fetcher, parseYear, tableCells, tableRows, textOf } from "./html";
import type { RosterScrape } from "./types";

export const AAAS_ROSTER_URL = HONOR_LISTS.find((l) => l.id === "aaas-fellows")!.rosterUrl;

export const AAAS_SEARCH_TERMS = ["Cornell", "Weill"] as const;

/** Page cap per search, so a pager bug cannot spin forever. */
export const AAAS_MAX_PAGES = 60;

export function aaasPageUrl(term: string, page: number): string {
  const u = new URL(AAAS_ROSTER_URL);
  u.searchParams.set("field_institutional_affiliation_value", term);
  if (page > 0) u.searchParams.set("page", String(page));
  return u.toString();
}

function cellByField(cells: Array<{ attrs: string; html: string }>, field: string): string | null {
  const cell = cells.find((c) => c.attrs.includes(`views-field-field-${field}`));
  return cell ? textOf(cell.html) : null;
}

export function parseAaasPage(html: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const row of tableRows(html)) {
    const cells = tableCells(row);
    const printedName = cellByField(cells, "last-name");
    if (!printedName) continue;
    const split = splitSortName(printedName);
    if (!split) continue;
    out.push({
      printedName,
      given: split.given,
      family: split.family,
      affiliation: cellByField(cells, "institutional-affiliation") || null,
      year: parseYear(cellByField(cells, "year-elected")),
    });
  }
  return out;
}

const lineKey = (e: RosterEntry) => `${e.printedName}\u0000${e.year ?? ""}`;

export async function scrapeAaas(fetcher: Fetcher): Promise<RosterScrape> {
  const seen = new Map<string, RosterEntry>();
  const failures: string[] = [];
  let pagesRead = 0;
  for (const term of AAAS_SEARCH_TERMS) {
    // Rows this search has returned so far. Per search, not global: the second
    // search's first page can overlap the first search entirely and still have
    // new rows further on.
    const termSeen = new Set<string>();
    for (let page = 0; page < AAAS_MAX_PAGES; page++) {
      let html: string;
      try {
        html = await fetcher(aaasPageUrl(term, page));
      } catch (err) {
        // The first page failing means the list is unreachable: fail the run.
        if (pagesRead === 0) throw err;
        failures.push(
          `"${term}" page ${page + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
      pagesRead += 1;
      const rows = parseAaasPage(html);
      if (rows.length === 0) break;
      const before = termSeen.size;
      for (const r of rows) {
        termSeen.add(lineKey(r));
        seen.set(lineKey(r), r);
      }
      // A pager that ignores `page=` serves page 0 forever; stop on no new rows.
      if (termSeen.size === before) break;
    }
  }
  return {
    entries: [...seen.values()],
    complete: failures.length === 0,
    warning: failures.length ? `Stopped early: ${failures.join("; ")}` : null,
  };
}
