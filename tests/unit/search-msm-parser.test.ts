/**
 * Issue #259 §1.1 — msm-parser semantics for the people-index query.
 *
 * The restructured query uses `minimum_should_match: "-0% 3<-25%"`. The
 * OpenSearch DSL is easy to misread, and the exact required-token counts
 * decide whether a doc is admitted. The spec calls for a fixed test table
 * (1, 2, 3, 4, 5, 8 analyzed tokens → 1, 2, 3, 3, 4, 6 required tokens) so
 * any future tweak to the msm string fails this test loudly.
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
 * Minimal parser for the one msm expression we ship. Spec format:
 *   "<low>% <threshold><<high>%"
 * where:
 *   - `low` applies when clauseCount <= threshold
 *   - `high` applies when clauseCount  > threshold
 *   - a leading `-` on a percentage means "subtract from clauseCount"
 *     (i.e. `-25%` = at-most-25%-missing = require ceil(75% of N))
 *
 * Returns the minimum number of clauses that must match.
 */
function requiredClauses(clauseCount: number, msm: string): number {
  const m = msm.match(/^(-?)(\d+)% (\d+)<(-?)(\d+)%$/);
  if (!m) throw new Error(`unrecognized msm expression: ${msm}`);
  const lowNeg = m[1] === "-";
  const lowMag = parseInt(m[2], 10);
  const threshold = parseInt(m[3], 10);
  const highNeg = m[4] === "-";
  const highMag = parseInt(m[5], 10);
  const useLow = clauseCount <= threshold;
  const neg = useLow ? lowNeg : highNeg;
  const mag = useLow ? lowMag : highMag;
  // OpenSearch semantics:
  //   `N%`  — require ceil(N% of clauseCount) clauses
  //   `-N%` — allow floor(N% of clauseCount) clauses to be missing,
  //           i.e. require clauseCount - floor(N% of clauseCount)
  // (Per Elastic docs on `minimum_should_match`.)
  const required = neg
    ? clauseCount - Math.floor((mag / 100) * clauseCount)
    : Math.ceil((mag / 100) * clauseCount);
  return Math.max(1, Math.min(required, clauseCount));
}

describe("msm parser — PEOPLE_RESTRUCTURED_MSM semantics", () => {
  it('msm string is "-0% 3<-25%"', () => {
    // If this constant changes, the table below must change with it.
    expect(PEOPLE_RESTRUCTURED_MSM).toBe("-0% 3<-25%");
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
