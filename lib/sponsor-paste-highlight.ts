/**
 * Mark the sponsor's paste with the concept terms the extractor pulled out of it (#6a).
 *
 * WHY: the fastest way for an officer to catch a bad decomposition is to see WHICH PHRASE the
 * matcher thought meant WHICH CONCEPT. A chip that says "cystic fibrosis" is a claim; the same
 * chip anchored to the words that produced it is auditable.
 *
 * WHAT THIS CANNOT DO, and why that is not a bug to be fixed here:
 * the extractor CANONICALISES. Its prompt says, in as many words, "prefer the standard medical
 * term over the sponsor's jargon: 'cystic fibrosis', not 'CF'" and "expand abbreviations". So a
 * concept's terms are frequently NOT substrings of the paste, and no string matcher — however
 * clever — can anchor them. Those concepts simply go unmarked.
 *
 * That makes the marking a LOWER BOUND on the decomposition, never a picture of it, and the UI
 * must not imply otherwise: an unmarked stretch of paste means "we could not point at it", NOT
 * "we ignored it". Closing the gap honestly needs the extractor to emit the verbatim span it
 * read each concept from — a server + prompt change, and that prompt is eval-tuned, so it is
 * not a change to make casually for a highlight.
 *
 * ponytail: a plain longest-match-wins scan, not a trie or a tokeniser. The paste is an email
 * (kilobytes) and the needle set is a couple of dozen terms — O(needles × paste) is microseconds
 * and runs once per search, not per keystroke.
 */
import type { SponsorConcept } from "@/lib/api/sponsor-match-contract";

/** A run of paste text. `term` present ⇒ it is the representative term of the concept this run
 *  was matched to (the join key back to the rail's chips). Absent ⇒ ordinary text. */
export type PasteSegment = {
  text: string;
  term?: string;
};

/** A word character for boundary purposes. Deliberately includes digits: "CD8" must not match
 *  inside "CD80", and "IL-6" must not match inside "IL-6R". */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/**
 * Split `paste` into segments, marking every literal occurrence of any concept member.
 *
 * Overlaps resolve LONGEST-FIRST: when "cardiac fibrosis" and "fibrosis" both match at the same
 * place, the officer is shown the specific concept, not the generic one it contains. Occurrences
 * are matched case-insensitively but the paste's OWN casing is preserved in the output — the
 * officer reads their sponsor's words back, not a normalised copy.
 *
 * A term may occur many times; every occurrence is marked.
 */
export function markPaste(paste: string, concepts: readonly SponsorConcept[]): PasteSegment[] {
  if (paste.length === 0) return [];

  // Every phrasing that merged into a cluster is a candidate needle, plus the representative
  // term itself. Deduped case-insensitively; a member that duplicates another is not two hits.
  const needles = new Map<string, string>(); // lowercased needle → concept term
  for (const concept of concepts) {
    for (const member of [concept.term, ...concept.members]) {
      const key = member.trim().toLowerCase();
      if (key.length > 0) needles.set(key, concept.term);
    }
  }
  if (needles.size === 0) return [{ text: paste }];

  // Longest first, so a specific concept claims its span before a generic one nested inside it.
  const ordered = [...needles.entries()].sort((a, b) => b[0].length - a[0].length);

  const hay = paste.toLowerCase();
  const claimed: { start: number; end: number; term: string }[] = [];

  for (const [needle, term] of ordered) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      const end = at + needle.length;
      from = at + 1;

      // Whole-word only: "CF" must not light up inside "CFTR".
      if (isWordChar(paste[at - 1]) || isWordChar(paste[end])) continue;
      // First (longest) claim wins; a shorter needle nested in a claimed span is dropped.
      if (claimed.some((c) => at < c.end && end > c.start)) continue;

      claimed.push({ start: at, end, term });
    }
  }
  if (claimed.length === 0) return [{ text: paste }];

  claimed.sort((a, b) => a.start - b.start);

  const segments: PasteSegment[] = [];
  let cursor = 0;
  for (const c of claimed) {
    if (c.start > cursor) segments.push({ text: paste.slice(cursor, c.start) });
    segments.push({ text: paste.slice(c.start, c.end), term: c.term });
    cursor = c.end;
  }
  if (cursor < paste.length) segments.push({ text: paste.slice(cursor) });
  return segments;
}

/** How many of `concepts` could actually be pointed at in the paste. The panel uses this to
 *  say so out loud rather than let an officer read absence of a mark as absence of a concept. */
export function markedConceptCount(segments: readonly PasteSegment[]): number {
  return new Set(segments.filter((s) => s.term).map((s) => s.term)).size;
}
