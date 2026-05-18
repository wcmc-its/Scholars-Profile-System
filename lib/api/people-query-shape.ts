/**
 * Issue #308 / SPEC §6.1.1 — People-tab query-shape classifier.
 *
 * A lexical, pure, synchronous classifier. Given the raw query, whether it
 * resolved to a MeSH descriptor, and the boot-cached surname / department
 * sets, it returns one of seven shapes.
 *
 * PR-1 *logs* the shape (telemetry, SPEC §9); it does NOT route ranking. The
 * per-shape ranking templates are SPEC PR-2 (#309) through PR-4 (#311).
 *
 * Model: independent signals, then a precedence ladder — not the SPEC §6.1.1
 * rule table read literally. That table conflates signal detection with
 * classification: e.g. "topic = >=4 tokens that fail name AND department"
 * reads as "there exist 4 non-surname tokens", which would mis-route a long
 * topic query that merely starts with a surname to `topic` instead of
 * `hybrid`. Computing four signals and combining them on a ladder removes the
 * ambiguity.
 */

/**
 * The seven People-tab query shapes.
 *
 * `empty` is not in the SPEC §9 enum — it covers the no-query browse branch
 * (a People-tab request carrying only filters). §9 says the telemetry field
 * is never null, so the no-query case still needs a value.
 */
export type PeopleQueryShape =
  | "cwid"
  | "name"
  | "department"
  | "topic"
  | "hybrid"
  | "unclassified"
  | "empty";

/**
 * Words dropped from a department-prefix leftover before the
 * pure-department-vs-hybrid test, so e.g. "cardiology department" reads as a
 * pure department rather than a department plus a stray topic token.
 */
const DEPARTMENT_NOISE: ReadonlySet<string> = new Set([
  "department",
  "dept",
  "division",
  "the",
  "of",
  "and",
  "&",
]);

/** Longest department phrase (in words) a query prefix is matched against. */
const MAX_DEPARTMENT_WORDS = 6;

export interface ClassifyPeopleQueryInput {
  /** The raw user query. Trimmed internally. */
  query: string;
  /**
   * Did `matchQueryToTaxonomy()` resolve the query to a MeSH descriptor?
   * `searchPeople` already computes the resolution; pass `resolution != null`.
   */
  meshResolved: boolean;
  /**
   * Lowercased `Scholar.cwid` values. CWID detection is exact set membership —
   * `scholar.cwid` is the PK, so this catches all-letter CWIDs (`rgcryst`)
   * that no format regex could, with zero false positives.
   */
  knownCwids: ReadonlySet<string>;
  /**
   * Lowercased surname tokens — the OpenSearch `lastNameSort` value set, built
   * and cached by `people-classifier-sets.ts`. `lastNameSort` is an index
   * field, not a Prisma column (see #308).
   */
  knownSurnames: ReadonlySet<string>;
  /** Lowercased distinct `Scholar.primaryDepartment` values. */
  knownDepartments: ReadonlySet<string>;
}

/**
 * If `tokens` begins with a known department name (longest match wins), return
 * the remaining tokens with department-noise words removed; otherwise `null`.
 * An empty array means the query was exactly a department name.
 */
function departmentLeftover(
  tokens: readonly string[],
  knownDepartments: ReadonlySet<string>,
): string[] | null {
  const maxWords = Math.min(tokens.length, MAX_DEPARTMENT_WORDS);
  for (let n = maxWords; n >= 1; n--) {
    if (knownDepartments.has(tokens.slice(0, n).join(" "))) {
      return tokens.slice(n).filter((t) => !DEPARTMENT_NOISE.has(t));
    }
  }
  return null;
}

/**
 * Classify a People-tab query into one of seven {@link PeopleQueryShape}s.
 *
 * Precedence ladder (first match wins):
 *
 *   1. empty query                       -> "empty"
 *   2. one CWID-shaped token             -> "cwid"
 *   3. surname anchor AND topic signal   -> "hybrid"
 *   4. department AND non-empty leftover -> "hybrid"
 *   5. surname anchor                    -> "name"
 *   6. department (leftover empty)       -> "department"
 *   7. topic signal                      -> "topic"
 *   8. otherwise                         -> "unclassified"
 *
 * Pure `name` (rule 5) is reached only when there is no topic signal, which
 * implies fewer than 4 tokens — so the SPEC's "1-3 token" name constraint
 * holds without a separate gate.
 */
export function classifyPeopleQuery(
  input: ClassifyPeopleQueryInput,
): PeopleQueryShape {
  const trimmed = input.query.trim();
  if (trimmed.length === 0) return "empty";

  const tokens = trimmed.toLowerCase().split(/\s+/);

  // 2. CWID — a single token that is a known scholar CWID (exact set
  // membership; catches all-letter CWIDs, no false positives).
  if (tokens.length === 1 && input.knownCwids.has(tokens[0])) return "cwid";

  // Surname anchor — the first OR last token is a known surname. Both ends, so
  // "lewis cantley" (given surname) and "cantley lewis" / "cantley l"
  // (directory order) both fire; a middle-only match does not, which avoids
  // the false fire an unanchored "any token" rule would cause. No token-count
  // gate — a long surname+topic query becomes `hybrid` via the ladder.
  const surnameAnchor =
    input.knownSurnames.has(tokens[0]) ||
    input.knownSurnames.has(tokens[tokens.length - 1]);

  // Department — a known department name as a phrase prefix. The leftover
  // (minus noise words) decides pure-department vs. hybrid.
  const leftover = departmentLeftover(tokens, input.knownDepartments);
  const departmentSignal = leftover !== null;
  const departmentHasLeftover = leftover !== null && leftover.length > 0;

  // Topic — resolved to a MeSH descriptor, or simply a long (>= 4 token) query.
  const topicSignal = input.meshResolved || tokens.length >= 4;

  if (surnameAnchor && topicSignal) return "hybrid";
  if (departmentHasLeftover) return "hybrid";
  if (surnameAnchor) return "name";
  if (departmentSignal) return "department";
  if (topicSignal) return "topic";
  return "unclassified";
}
