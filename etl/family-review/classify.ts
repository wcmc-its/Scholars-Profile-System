/**
 * Pure, DB-free matcher for the comms-steward Method-Family surfacing pass
 * (`docs/comms-steward-methods-visibility-spec.md` §6). Deterministic and
 * allow-by-default: it only decides whether a `(supercategory, family_label)`
 * pair carries an animal-model signal and, if so, the human-readable `reason`.
 * It never changes a tier, never hides anything, and never touches the DB —
 * so it is fully unit-testable in isolation.
 *
 * Signal (two parts, OR'd, §6):
 *   1. Structural — `supercategory === 'animal_cell_models'` →
 *      reason `'supercategory:animal_cell_models'` (strongest signal, free from A2).
 *   2. Lexical — the `family_label` contains a maintained, case-insensitive term
 *      from `animal-model-terms.txt` → reason `'term:<matched>'` (the first
 *      term that matches, in file order). Whole-word boundaries so "rat" does not
 *      fire on "demonstrate" or "ratio".
 */

const ANIMAL_SUPERCATEGORY = "animal_cell_models";

/** Escape a term for safe embedding in a RegExp source. */
function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the term list file body: one term per line, blank lines and `#`-prefixed
 * comment lines ignored, surrounding whitespace trimmed. Multi-word terms
 * (e.g. "in vivo", "animal model") are preserved verbatim. Returned in file
 * order so `reason='term:<matched>'` is deterministic.
 */
export function parseTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.push(line.toLowerCase());
  }
  return out;
}

/**
 * Decide whether a family is animal-model-flagged. Structural beats lexical: an
 * `animal_cell_models` family is always flagged regardless of label. Otherwise
 * the first whole-word term match (case-insensitive) wins.
 *
 * @returns `{ reason }` where `reason` is a non-null string when flagged, else null.
 */
export function classifyFamily(
  supercategory: string,
  familyLabel: string,
  terms: string[],
): { reason: string | null } {
  // 1. Structural — strongest signal, independent of the label.
  if (supercategory.trim().toLowerCase() === ANIMAL_SUPERCATEGORY) {
    return { reason: `supercategory:${ANIMAL_SUPERCATEGORY}` };
  }

  // 2. Lexical — first whole-word term match in file order.
  const haystack = familyLabel.toLowerCase();
  for (const term of terms) {
    if (!term) continue;
    // Whole-word match so "rat" doesn't fire inside "ratio"/"demonstrate". \b
    // anchors on the alphanumeric boundary; multi-word terms keep their spaces.
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
    if (pattern.test(haystack)) {
      return { reason: `term:${term}` };
    }
  }

  return { reason: null };
}
