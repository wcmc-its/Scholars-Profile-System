/**
 * Burroughs Wellcome Fund — Career Awards for Medical Scientists (CAMS).
 *
 * Roster: the program page's "Grant Recipients" section, one server-rendered
 * page (probed 2026-09-25: HTTP 200 to a plain client). Recipients are grouped
 * in collapsible year sections:
 *
 *   <div class="toggle"><div class="toggle-title">2020</div>
 *     <div class="toggle-inner"><p>
 *       <div><strong>First Last, MD, PhD</strong></div>
 *       <div>Institution</div>
 *       <div>Project title</div> …
 *
 * The year comes from the section title; each recipient is a <strong> name
 * followed by the institution <div>.
 */
import { HONOR_LISTS } from "@/lib/honors/lists";

import type { RosterEntry } from "./match";
import { splitDisplayName } from "./match";
import { type Fetcher, parseYear, textOf } from "./html";
import type { RosterScrape } from "./types";

export const BWF_ROSTER_URL = HONOR_LISTS.find((l) => l.id === "bwf-cams")!.rosterUrl;

const SECTION = /<div[^>]*class="[^"]*\btoggle-title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
const RECIPIENT = /<strong>([\s\S]*?)<\/strong>\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/gi;

export function parseBwfRoster(html: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  const titles = [...html.matchAll(SECTION)];
  titles.forEach((t, i) => {
    const year = parseYear(textOf(t[1]));
    const start = (t.index ?? 0) + t[0].length;
    const end = i + 1 < titles.length ? (titles[i + 1].index ?? html.length) : html.length;
    const body = html.slice(start, end);
    for (const m of body.matchAll(RECIPIENT)) {
      const printedName = textOf(m[1]);
      const split = splitDisplayName(printedName);
      if (!split) continue;
      out.push({
        printedName,
        given: split.given,
        family: split.family,
        affiliation: textOf(m[2]) || null,
        year,
      });
    }
  });
  return out;
}

export async function scrapeBwf(fetcher: Fetcher): Promise<RosterScrape> {
  const entries = parseBwfRoster(await fetcher(BWF_ROSTER_URL));
  return { entries, complete: true, warning: null };
}
