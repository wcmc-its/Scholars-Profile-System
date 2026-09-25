/**
 * Turn one list's scrape into writes. Pure, so the "never overrule a curator"
 * rules are testable without a DB.
 *
 * The rules, in order:
 *   - A matched (list honor, scholar) that already has an `honor` row, in ANY
 *     status, is left alone. `published` is on a profile already; `rejected` is
 *     a curator's "no" and must not come back (the Rejected tab promises "They
 *     won't be suggested again"); `pending` is already in the queue. The one
 *     write allowed on an existing row is filling a MISSING evidence line on a
 *     still-`pending` row (a seeded row has none).
 *   - Everything else becomes a NEW row with status `pending`. There is no path
 *     from here to `published`.
 *   - One scholar is proposed at most once per list per run, even when the
 *     roster prints them twice (two classes, a name variant).
 *   - A roster line one of whose candidates already has a row proposes nobody
 *     else: the award on that line is already claimed or being decided.
 *
 * The existing-row key is (cwid, organization, name) — the seed import's upsert
 * key, and the DB compares it case-insensitively, which is why the caller loads
 * existing rows with an equality WHERE rather than comparing strings here.
 */
import type { HonorListMeta } from "@/lib/honors/lists";

import { matchEntry, type ScholarIndex } from "./match";
import type { RosterScrape } from "./types";

/** `honor.entered_by_cwid` for a scraper-proposed row (VARCHAR(32)). */
export const HONORS_SCRAPER_ACTOR = "honors-list-scraper";

/** `honor.source_ref` is VARCHAR(512). */
const SOURCE_REF_MAX = 512;

export type ExistingHonor = {
  id: string;
  cwid: string;
  status: "published" | "pending" | "rejected";
  evidence: string | null;
};

export type HonorCreate = {
  cwid: string;
  category: HonorListMeta["category"];
  name: string;
  organization: string;
  year: number | null;
  status: "pending";
  showOnProfile: true;
  source: string;
  sourceRef: string;
  enteredByCwid: string;
  evidence: string;
};

export type ListPlan = {
  /** Entries read from the roster. */
  onListTotal: number;
  /** Entries matched to at least one scholar. */
  matched: number;
  creates: HonorCreate[];
  evidenceFills: Array<{ id: string; evidence: string }>;
};

/**
 * The roster-line identity the queue groups on: `<roster>|<printed name>|<year>`
 * (the seed's format — `rosterMatchedName` and `rosterKey` in
 * `lib/edit/honor-queue.ts` parse it). Candidates for the same line share it,
 * which is what makes a same-name pair a contested, pick-one line.
 */
export function lineSourceRef(
  meta: Pick<HonorListMeta, "rosterUrl">,
  printedName: string,
  year: number | null,
): string {
  const name = printedName.replace(/\|/g, "/").trim();
  return `${meta.rosterUrl}|${name}|${year ?? ""}`.slice(0, SOURCE_REF_MAX);
}

export function planList(
  meta: HonorListMeta,
  scrape: RosterScrape,
  index: ScholarIndex,
  existing: readonly ExistingHonor[],
): ListPlan {
  const byCwid = new Map<string, ExistingHonor>();
  for (const e of existing) if (!byCwid.has(e.cwid)) byCwid.set(e.cwid, e);

  const creates: HonorCreate[] = [];
  const evidenceFills: ListPlan["evidenceFills"] = [];
  const proposed = new Set<string>();
  let matched = 0;

  for (const entry of scrape.entries) {
    const candidates = matchEntry(entry, index);
    if (candidates.length === 0) continue;
    matched += 1;
    const sourceRef = lineSourceRef(meta, entry.printedName, entry.year);
    // A line one of whose candidates already holds this honor is accounted for:
    // proposing the OTHER same-name scholars would put a lone, uncontested
    // claim in the queue for an award someone else already has.
    const lineClaimed = candidates.some((c) => byCwid.has(c.cwid));
    for (const c of candidates) {
      if (proposed.has(c.cwid)) continue;
      proposed.add(c.cwid);
      const prior = byCwid.get(c.cwid);
      if (prior) {
        if (prior.status === "pending" && !prior.evidence) {
          evidenceFills.push({ id: prior.id, evidence: c.evidence });
        }
        continue;
      }
      if (lineClaimed) continue;
      creates.push({
        cwid: c.cwid,
        category: meta.category,
        name: meta.honorName,
        organization: meta.organization,
        year: entry.year,
        status: "pending",
        showOnProfile: true,
        source: meta.source,
        sourceRef,
        enteredByCwid: HONORS_SCRAPER_ACTOR,
        evidence: c.evidence,
      });
    }
  }
  return { onListTotal: scrape.entries.length, matched, creates, evidenceFills };
}
