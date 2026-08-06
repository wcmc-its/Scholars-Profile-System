/**
 * Surname extraction for "Last name (A–Z)" ordering — the single source of
 * truth shared by the search index (`lastNameSort` keyword field, #82) and the
 * center roster sort, so both order people the same way. Dependency-free so it
 * can be imported from either side without a cycle (`search-index-docs` already
 * imports from `lib/api/centers`).
 */

/** Generational / honorific suffix tokens dropped before the surname anchor. */
const NAME_SUFFIXES = /^(Jr|Sr|I{1,3}|IV|V|VI{0,3}|Esq)\.?,?$/i;

/**
 * One trailing balanced parenthetical, with the whitespace in front of it —
 * the `Name (Unit)` disambiguation form (#2214). Anchored at the end so a
 * parenthetical *inside* a name ("John (Jack) Smith") is left alone, and
 * `[^()]*` keeps it from swallowing an unbalanced run.
 */
const TRAILING_PARENTHETICAL = /\s*\([^()]*\)\s*$/;

/** How many times {@link stripUnitDisambiguation} may re-run. */
const STRIP_PASSES = 4;

/**
 * Remove the curated name-collision disambiguation suffixes from a published
 * name. Two forms are in the data and they nest either way round
 * ("Jane Doe (Surgery - Cardiothoracic)" vs "Jane Doe (Radiology) - Surgery"),
 * so the two strips run to a fixed point rather than in one fixed order.
 * `STRIP_PASSES` bounds it; each pass that changes anything removes at least
 * one suffix, so real names (zero suffixes) exit after the first pass.
 */
function stripUnitDisambiguation(name: string): string {
  let s = name.trim();
  for (let i = 0; i < STRIP_PASSES; i++) {
    const before = s;
    // #2214 — trailing `(<Unit>)`.
    s = s.replace(TRAILING_PARENTHETICAL, "").trim();
    // #2049 — `" - <Department>"`; cut at the FIRST separator, as before.
    const dashIdx = s.indexOf(" - ");
    if (dashIdx >= 0) s = s.slice(0, dashIdx).trim();
    if (s === before) break;
  }
  return s;
}

/**
 * Extract the surname token from a "Given Last" preferredName. Strips the
 * curated name-collision disambiguation suffixes before tokenizing so the unit
 * name never becomes the sort key:
 *
 *   - `" - <Department>"` — "Alessandro Fichera - Surgery" → "fichera" (#2049;
 *     it was poisoning `knownSurnames` and misrouting People search).
 *   - `" (<Unit>)"` — "Jane Doe (Radiology)" → "doe" (#2214). Untreated, the
 *     last whitespace token is "(Radiology)"; OpenSearch keyword sort is byte
 *     order and "(" (0x28) precedes "a" (0x61), so a single such record sorts
 *     ahead of EVERY real surname and takes row 1 of the A–Z people browse.
 *
 * Also strips trailing generational suffixes ("Jr", "II", etc.) so "Smith Jr"
 * yields "smith". Name particles are deliberately NOT special-cased: the
 * surname anchor is the last token, so "Vincent van Gogh" → "gogh",
 * "Ana del Rio" → "rio", "Sinead O'Connor" → "o'connor" and hyphenates
 * ("Mary Smith-Jones") pass through whole.
 *
 * Returns "" for empty input. Lowercased for stable, case-insensitive sorting.
 */
export function extractLastNameSort(name: string): string {
  if (!name) return "";
  // A name that is ENTIRELY a parenthetical strips to nothing. Fall back to the
  // unstripped name rather than emitting "", which sorts first — the very
  // defect #2214 is about.
  const base = stripUnitDisambiguation(name) || name;
  const raw = base.trim().split(/\s+/).filter(Boolean);
  if (raw.length === 0) return "";
  let end = raw.length;
  while (end > 1 && NAME_SUFFIXES.test(raw[end - 1])) end -= 1;
  return raw[end - 1].toLowerCase();
}
