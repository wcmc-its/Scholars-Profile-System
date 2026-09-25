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
 *
 * "CWID-shaped" is deliberately loose: a letter then 2–31 letters or digits,
 * with NO digit required, because legacy all-letter (name-derived) CWIDs
 * exist and must be accepted. So any word of 3+ letters passes here — a
 * pasted surname or a header like "cwid" is kept as an entry. That is safe:
 * the report resolves each entry against active scholars, and the rail lists
 * every entry that matched no one as "not found" (it never calls the entries
 * valid CWIDs). Only tokens the pattern rejects (too short, digit-first) are
 * skipped here.
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
