/**
 * Pasted-CWID-list parsing for report 8's "CWID list" filter — pure, no DB,
 * so the rail's client island and the create route (`POST
 * /api/edit/reports/article-count/cwid-list`) apply the same rule.
 *
 * Any separator works (commas, spaces, tabs, new lines, semicolons, quotes —
 * whatever a spreadsheet column or an email pastes as): the text is split on
 * every run of characters that cannot appear in a CWID, lowercased, and
 * deduplicated in first-seen order. A token that is not CWID-shaped
 * (`CWID_PATTERN`, `lib/cwid.ts`) is reported, never stored.
 */
import { CWID_PATTERN } from "@/lib/cwid";

/** The most CWIDs one stored list may hold. */
export const CWID_LIST_MAX = 5000;

export function parseCwidText(text: string): { cwids: string[]; invalid: string[] } {
  const cwids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const token = raw.toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    (CWID_PATTERN.test(token) ? cwids : invalid).push(token);
  }
  return { cwids, invalid };
}
