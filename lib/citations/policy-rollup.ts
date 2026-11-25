/**
 * Guideline and policy citation rollup for one publication, as the public row
 * shows it. Built from the three `publication` columns the weekly
 * `etl:policy-citations` step maintains.
 */
export type PolicyRollup = {
  /** Distinct documents per health authority, most documents first. */
  authority: Array<{ body: string; count: number }>;
  guidelines: number;
  reviews: number;
};

/** Server-side gate for the public badges and the modal section. */
export function policyCitationBadgesOn(): boolean {
  return process.env.POLICY_CITATION_BADGES === "on";
}

/** The rollup, or null when nothing cites the paper (the row then adds nothing). */
export function toPolicyRollup(row: {
  authorityBodies: unknown;
  guidelineCount: number;
  reviewCount: number;
}): PolicyRollup | null {
  const authority = Array.isArray(row.authorityBodies)
    ? row.authorityBodies.flatMap((b) =>
        b && typeof b.body === "string" && typeof b.count === "number" && b.count > 0
          ? [{ body: b.body as string, count: b.count as number }]
          : [],
      )
    : [];
  if (authority.length === 0 && row.guidelineCount === 0 && row.reviewCount === 0) return null;
  return { authority, guidelines: row.guidelineCount, reviews: row.reviewCount };
}

/** What each authority's documents are called on a badge. */
const NOUN: Readonly<Record<string, string>> = { WHO: "guideline", NICE: "guideline" };

/** "Cited in 4 WHO guidelines", or "National Academies report" for a single one. */
export function authorityBadgeLabel(body: string, count: number): string {
  const noun = NOUN[body] ?? "report";
  return count === 1 ? `${body} ${noun}` : `Cited in ${count} ${body} ${noun}s`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
