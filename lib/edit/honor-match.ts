/**
 * Match strength for one honors-queue line — the review pane's "Match evidence"
 * checklist, its Strong / Likely / Weak pill, and the "Strong only" filter.
 * Pure and client-safe (no db import): the queue computes it in the browser
 * from what the loader already sends.
 *
 * Two kinds of evidence reach the queue:
 *  - a QUOTE from the source article (newsroom rows), in curly quotes and maybe
 *    prefixed "Nickname match. ". Four checks: the listed name matches the
 *    profile name, the quote names the scholar, mentions Weill Cornell, and
 *    names the award.
 *  - a one-line NOTE from a roster match ("Name and institution match: listed
 *    at …", "Nickname match (…); …", "Roster links this scholar's …"). Checks:
 *    the listed name and the stated affiliation.
 * Either way: no miss = strong, one = likely, more = weak. A nickname match
 * counts as a miss.
 * A contested line (several candidates) is "pick" until the curator picks.
 */
import type { HonorQueueGroup, HonorQueueRow } from "@/lib/edit/honor-queue";

export type MatchLevel = "strong" | "likely" | "weak" | "pick";

/** Sort rank for "Strongest match first". */
export const MATCH_LEVEL_RANK: Record<MatchLevel, number> = {
  strong: 0,
  likely: 1,
  pick: 2,
  weak: 3,
};

export type MatchSignal = { ok: boolean; text: string };

const INSTITUTION = /weill cornell/i;

/** "Ada Q. Example, MD" → ["ada", "example"]: first and last word, postnominal dropped. */
function firstLast(name: string): [string, string] {
  const words = name.split(",")[0].trim().split(/\s+/).filter(Boolean);
  return [(words[0] ?? "").toLowerCase(), (words[words.length - 1] ?? "").toLowerCase()];
}

/** The evidence split into its article quote (when it is one) and nickname basis. */
export function parseEvidence(evidence: string | null): {
  quote: string | null;
  note: string | null;
  nickname: boolean;
} {
  if (!evidence) return { quote: null, note: null, nickname: false };
  const nickname = /^nickname/i.test(evidence);
  const m = evidence.match(/“([\s\S]*)”/);
  return m ? { quote: m[1], note: null, nickname } : { quote: null, note: evidence, nickname };
}

/** The checklist and level for one candidate on a line. */
export function matchSignals(
  row: HonorQueueRow,
  listedAs: string | null,
): { signals: MatchSignal[]; level: Exclude<MatchLevel, "pick"> } {
  const [first, last] = firstLast(row.scholarName);
  const signals: MatchSignal[] = [];
  if (listedAs) {
    const listed = listedAs.toLowerCase();
    const ok = listed.includes(first) && listed.includes(last);
    signals.push({
      ok,
      text: ok ? "Listed name matches profile name" : `Listed as “${listedAs}”, which differs`,
    });
  }
  const { quote, note, nickname } = parseEvidence(row.evidence);
  if (nickname) signals.push({ ok: false, text: "Matched on a nickname" });
  if (quote !== null) {
    const q = quote.toLowerCase();
    const named = q.includes(last);
    const inst = INSTITUTION.test(quote);
    const award = [row.name, row.organization].some((t) => q.includes(t.toLowerCase()));
    signals.push(
      { ok: named, text: named ? "Quote names the scholar" : "Quote doesn’t name the scholar" },
      {
        ok: inst,
        text: inst ? "Quote mentions Weill Cornell" : "Quote doesn’t mention Weill Cornell",
      },
      { ok: award, text: award ? "Quote names this award" : "Quote doesn’t name this award" },
    );
  } else if (note !== null) {
    const ok = INSTITUTION.test(note) || /institution match|links this scholar/i.test(note);
    signals.push({
      ok,
      text: ok ? "Source states a Weill Cornell affiliation" : "Source states no affiliation",
    });
  }
  const misses = signals.filter((s) => !s.ok).length;
  const level = misses === 0 ? "strong" : misses === 1 ? "likely" : "weak";
  return { signals, level };
}

/** A line's level: "pick" while contested, else its one candidate's. */
export function groupMatchLevel(group: HonorQueueGroup): MatchLevel {
  if (group.contested) return "pick";
  return matchSignals(group.rows[0], group.rosterMatchedName).level;
}

export type Segment = { t: string; k?: "name" | "award" | "inst" };

/** Split `text` into plain and highlighted runs. Whole-word, case-insensitive;
 *  where terms overlap the earlier, longer one wins. */
export function highlight(
  text: string,
  terms: ReadonlyArray<{ t: string; k: NonNullable<Segment["k"]> }>,
): Segment[] {
  const low = text.toLowerCase();
  const edge = (i: number) => i < 0 || i >= low.length || !/[a-z0-9]/i.test(low[i]);
  const marks: Array<{ s: number; e: number; k: NonNullable<Segment["k"]> }> = [];
  for (const { t, k } of terms) {
    const tl = t.trim().toLowerCase();
    if (tl.length < 2) continue;
    for (let i = low.indexOf(tl); i !== -1; i = low.indexOf(tl, i + tl.length)) {
      if (edge(i - 1) && edge(i + tl.length)) marks.push({ s: i, e: i + tl.length, k });
    }
  }
  marks.sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s));
  const out: Segment[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.s < pos) continue;
    if (m.s > pos) out.push({ t: text.slice(pos, m.s) });
    out.push({ t: text.slice(m.s, m.e), k: m.k });
    pos = m.e;
  }
  if (pos < text.length) out.push({ t: text.slice(pos) });
  return out;
}

/** The terms the review pane highlights in a line's quote. */
export function highlightTerms(
  group: HonorQueueGroup,
): Array<{ t: string; k: NonNullable<Segment["k"]> }> {
  const head = group.rows[0];
  const names = group.rows.flatMap((r) => {
    const full = r.scholarName.split(",")[0].trim();
    const words = full.split(/\s+/);
    const l = words[words.length - 1];
    return [full, `${words[0]} ${l}`, `Dr. ${l}`, l];
  });
  return [
    ...names.map((t) => ({ t, k: "name" as const })),
    ...(group.rosterMatchedName ? [{ t: group.rosterMatchedName, k: "name" as const }] : []),
    { t: head.name, k: "award" },
    { t: head.organization, k: "award" },
    ...["Weill Cornell Medical College", "Weill Cornell Medicine", "Weill Cornell"].map((t) => ({
      t,
      k: "inst" as const,
    })),
  ];
}
