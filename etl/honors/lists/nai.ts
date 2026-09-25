/**
 * National Academy of Inventors — Fellows.
 *
 * Roster: https://academyofinventors.org/search-fellows/ — ONE server-rendered
 * page carrying every Fellow in a single table (probed 2026-09-25: ~2,250 rows,
 * HTTP 200 to a plain client). Columns: a hidden sort letter, Fellow, Institution,
 * Elected Class, a hidden badge cell. The Fellow cell sometimes links the
 * person's VIVO profile (`vivo.weill.cornell.edu/display/cwid-<cwid>`); that link
 * is an identifier and becomes the candidate's cwid hint.
 */
import { HONOR_LISTS } from "@/lib/honors/lists";

import type { RosterEntry } from "./match";
import { splitDisplayName } from "./match";
import { type Fetcher, parseYear, tableCells, tableRows, textOf } from "./html";
import type { RosterScrape } from "./types";

export const NAI_ROSTER_URL = HONOR_LISTS.find((l) => l.id === "nai-fellows")!.rosterUrl;

const VIVO_CWID = /vivo\.weill\.cornell\.edu\/display\/cwid-([a-z0-9]+)/i;

export function parseNaiRoster(html: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const row of tableRows(html)) {
    const cells = tableCells(row);
    // Header rows use <th>; a data row has the sort letter, name, institution, year.
    if (cells.length < 4) continue;
    const nameCell = cells[1].html;
    const anchor = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(nameCell);
    const printedName = textOf(anchor ? anchor[1] : nameCell);
    const split = splitDisplayName(printedName);
    if (!split) continue;
    out.push({
      printedName,
      given: split.given,
      family: split.family,
      affiliation: textOf(cells[2].html) || null,
      year: parseYear(textOf(cells[3].html)),
      cwidHint: VIVO_CWID.exec(nameCell)?.[1]?.toLowerCase() ?? null,
    });
  }
  return out;
}

export async function scrapeNai(fetcher: Fetcher): Promise<RosterScrape> {
  const entries = parseNaiRoster(await fetcher(NAI_ROSTER_URL));
  return { entries, complete: true, warning: null };
}
