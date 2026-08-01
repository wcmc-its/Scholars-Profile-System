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
 * Extract the surname token from a "Given Last" preferredName. Strips a
 * trailing `" - <Department>"` name-collision disambiguation suffix (e.g.
 * "Alessandro Fichera - Surgery" → "Alessandro Fichera") before tokenizing,
 * so the department word never becomes the sort key (#2049 — it was
 * poisoning `knownSurnames` and misrouting People search). Also strips
 * trailing generational suffixes ("Jr", "II", etc.) so "Smith Jr" yields
 * "smith". Returns "" for empty input. Lowercased for stable,
 * case-insensitive sorting.
 */
export function extractLastNameSort(name: string): string {
  if (!name) return "";
  const dashIdx = name.indexOf(" - ");
  const withoutDisambiguation = dashIdx >= 0 ? name.slice(0, dashIdx) : name;
  const raw = withoutDisambiguation.trim().split(/\s+/).filter(Boolean);
  if (raw.length === 0) return "";
  let end = raw.length;
  while (end > 1 && NAME_SUFFIXES.test(raw[end - 1])) end -= 1;
  return raw[end - 1].toLowerCase();
}
