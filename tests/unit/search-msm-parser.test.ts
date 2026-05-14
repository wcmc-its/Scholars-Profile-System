/**
 * Issue #259 §1.1 — msm-parser semantics for the people-index query.
 *
 * The restructured query uses `minimum_should_match: "3<-25%"`. The
 * OpenSearch DSL is easy to misread, and the exact required-token counts
 * decide whether a doc is admitted. The spec calls for a fixed test table
 * (1, 2, 3, 4, 5, 8 analyzed tokens → 1, 2, 3, 3, 4, 6 required tokens) so
 * any future tweak to the msm string fails this test loudly.
 *
 * Note: the spec originally wrote this as `"-0% 3<-25%"`, but OpenSearch
 * rejects bare segments without a `<` operator (it throws `For input
 * string: "-0%"`). The shorter form `"3<-25%"` produces the same table:
 * the bare-segment form was meant to express "require all when ≤3" which
 * is already the implicit default when no condition matches.
 *
 * We don't run OpenSearch here. We test our local interpretation of the
 * DSL: a pure function that mirrors the documented semantics, fed the same
 * msm string the production query uses. If OpenSearch ever changes how it
 * parses this expression, the integration tier will catch it; this tier
 * locks the intent.
 */
import { describe, expect, it } from "vitest";
import { PEOPLE_RESTRUCTURED_MSM } from "@/lib/search";

/**
 * Minimal parser for the conditional msm expression we ship.
 *
 * Format: `"<threshold><<spec>"`
 *   - When clauseCount <= threshold: require ALL clauses (implicit default).
 *   - When clauseCount  > threshold: apply <spec>.
 *
 * Spec sub-grammar:
 *   - `N%`  — require ceil(N% of clauseCount) clauses.
 *   - `-N%` — allow floor(N% of clauseCount) clauses to be missing, i.e.
 *             require clauseCount - floor(N% of clauseCount).
 *
 * Returns the minimum number of clauses that must match.
 */
function requiredClauses(clauseCount: number, msm: string): number {
  const m = msm.match(/^(\d+)<(-?)(\d+)%$/);
  if (!m) throw new Error(`unrecognized msm expression: ${msm}`);
  const threshold = parseInt(m[1], 10);
  const neg = m[2] === "-";
  const mag = parseInt(m[3], 10);
  if (clauseCount <= threshold) {
    // Below threshold: implicit "require all".
    return clauseCount;
  }
  const required = neg
    ? clauseCount - Math.floor((mag / 100) * clauseCount)
    : Math.ceil((mag / 100) * clauseCount);
  return Math.max(1, Math.min(required, clauseCount));
}

describe("msm parser — PEOPLE_RESTRUCTURED_MSM semantics", () => {
  it('msm string is "3<-25%"', () => {
    // If this constant changes, the table below must change with it.
    expect(PEOPLE_RESTRUCTURED_MSM).toBe("3<-25%");
  });

  // Spec table from docs/taxonomy-aware-search.md §1.1 ("Unit test required").
  const cases: Array<[number, number]> = [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 4],
    [8, 6],
  ];

  it.each(cases)(
    "%i analyzed tokens → %i required tokens",
    (tokens, expected) => {
      expect(requiredClauses(tokens, PEOPLE_RESTRUCTURED_MSM)).toBe(expected);
    },
  );
});
