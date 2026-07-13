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

/** Concept terms are LLM output and reach us as data, not as patterns. "IL-6 (p<0.05)" or a
 *  term containing `+`, `*` or `(` would otherwise be compiled as a regex — at best matching
 *  the wrong thing, at worst throwing on an unbalanced bracket and taking the panel down. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const needles = new Map<string, string>(); // needle → concept term
  for (const concept of concepts) {
    for (const member of [concept.term, ...concept.members]) {
      const key = member.trim();
      // Must contain a letter or digit. A member that is empty, or is pure punctuation, would
      // otherwise match every hyphen or bracket in the email and scatter meaningless marks
      // through the officer's text. These are LLM output; they are not guaranteed sane.
      if (/[A-Za-z0-9]/.test(key)) needles.set(key.toLowerCase(), concept.term);
    }
  }
  if (needles.size === 0) return [{ text: paste }];

  // Longest first, so a specific concept claims its span before a generic one nested inside it.
  const ordered = [...needles.entries()].sort((a, b) => b[0].length - a[0].length);

  const claimed: { start: number; end: number; term: string }[] = [];

  for (const [needle, term] of ordered) {
    // Case-insensitive search over the PASTE ITSELF, via a regex, rather than `indexOf` over a
    // lowercased copy. `toLowerCase()` is NOT length-preserving in Unicode — "İ" (U+0130) maps
    // to two code units — so an index taken in the lowercased copy can address a different
    // character in the original, and every span after it would slice the wrong text. Matching
    // the original keeps the index domain and the slice domain the same string, by
    // construction. (`i` handles the case-folding; `escapeRegExp` keeps the term a literal.)
    const re = new RegExp(escapeRegExp(needle), "gi");
    for (;;) {
      const m = re.exec(paste);
      if (m === null) break;
      const at = m.index;
      const end = at + m[0].length;
      // Advance by one so overlapping occurrences of the same needle are still considered;
      // a zero-length match cannot happen (empty needles are filtered above) but guard anyway.
      re.lastIndex = at + 1;

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
