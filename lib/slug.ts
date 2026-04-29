/**
 * Slug derivation per Q3' decision.
 *
 * Source: ED preferred_name. Steps:
 *   - NFKD normalize, strip combining marks (diacritics)
 *   - Replace any character outside [a-z0-9 -] with whitespace
 *   - Collapse whitespace runs into single hyphens
 *   - Trim leading/trailing hyphens
 *
 * Collisions are resolved at the call site via `nextAvailableSlug`, which appends
 * -2, -3, ... in CWID-creation order. Established profiles never get renamed by
 * a later collision; only the new arrival gets the suffix.
 */

const COMBINING_MARKS = /\p{Mark}/gu;
const APOSTROPHES = /['‘’ʼ]/g; // straight, curly, modifier letter
const NON_SLUG_CHARS = /[^a-z0-9\s-]/g;
const WHITESPACE_RUN = /[\s-]+/g;

// Latin characters that NFKD doesn't decompose (no combining-mark form).
// Mapped to their conventional ASCII transliterations.
const NON_DECOMPOSABLE_LATIN: Record<string, string> = {
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
};
const NON_DECOMPOSABLE_REGEX = new RegExp(
  `[${Object.keys(NON_DECOMPOSABLE_LATIN).join("")}]`,
  "g",
);

/**
 * Convert a name to its base slug form.
 *
 * Algorithm:
 *   1. NFKD normalize to split accented letters into base + combining marks
 *   2. Strip combining marks
 *   3. Lowercase
 *   4. Drop apostrophes (so O'Brien -> obrien, not o-brien)
 *   5. Map non-decomposable Latin extensions (ø -> o, ß -> ss, etc.)
 *   6. Replace remaining non-[a-z0-9 -] with whitespace
 *   7. Collapse whitespace/hyphen runs into single hyphens
 *   8. Trim leading/trailing hyphens
 *
 * Examples:
 *   "Jane Smith" -> "jane-smith"
 *   "María José García-López" -> "maria-jose-garcia-lopez"
 *   "Mary-Anne O'Brien" -> "mary-anne-obrien"
 *   "Søren Kierkegaard" -> "soren-kierkegaard"
 *   "李明" -> "" (CJK falls outside ASCII; expects ED romanization to be supplied instead)
 */
export function deriveSlug(name: string): string {
  if (!name) return "";
  return name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(NON_DECOMPOSABLE_REGEX, (ch) => NON_DECOMPOSABLE_LATIN[ch] ?? "")
    .replace(NON_SLUG_CHARS, " ")
    .replace(WHITESPACE_RUN, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Given a base slug and a set of taken slugs, return the next available variant
 * with a numeric suffix. Used at scholar-creation time when ED reports a name
 * whose slug collides with an existing scholar.
 *
 * Returns the base slug unchanged if it isn't taken.
 *
 * Example:
 *   nextAvailableSlug("jane-smith", new Set()) -> "jane-smith"
 *   nextAvailableSlug("jane-smith", new Set(["jane-smith"])) -> "jane-smith-2"
 *   nextAvailableSlug("jane-smith", new Set(["jane-smith", "jane-smith-2"])) -> "jane-smith-3"
 */
export function nextAvailableSlug(base: string, taken: Set<string> | ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Quick predicate for use in URL middleware: does this string look like a slug
 * (vs. a raw CWID, which is typically alphanumeric without hyphens)?
 */
export function looksLikeSlug(s: string): boolean {
  return /-/.test(s) || /^[a-z]+$/.test(s);
}
