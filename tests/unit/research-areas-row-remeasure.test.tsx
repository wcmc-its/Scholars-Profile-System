/**
 * `components/search/research-areas-row.tsx` — MeasuredChipRow re-measures when
 * the item SET changes (2026-07-07 review fix). The row is rendered without a
 * key, so a soft-nav query refinement hands the same instance a new `items`
 * array; before the fix the measure effect early-returned (measuring already
 * false) and the collapsed fit / "+N more" stayed sized for the OLD set.
 *
 * jsdom has no real layout (clientWidth 0), so the component falls back to
 * FALLBACK_VISIBLE (4). The bug is observable by growing the set on rerender:
 * pre-fix `fit` stays stuck at the previous (smaller) value; post-fix the
 * itemsKey re-arm re-runs measurement so "+N more" reflects the new set.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResearchAreasRow } from "@/components/search/research-areas-row";
import type { TaxonomyMatch, TaxonomyMatchResult } from "@/lib/api/search-taxonomy";

function area(name: string, n: number): TaxonomyMatch {
  const id = name.toLowerCase().replace(/\s+/g, "-");
  return {
    entityType: "parentTopic",
    id,
    name,
    parentTopicId: null,
    parentTopicLabel: null,
    href: `/topics/${id}`,
    scholarCount: n,
    publicationCount: n * 3,
    similarity: 1 / name.length,
    description: `${name} description.`,
    subtopicCount: 2,
    supercategory: null,
    familyLabel: null,
  };
}

function matches(names: string[]): TaxonomyMatchResult {
  const areas = names.map((nm, i) => area(nm, 100 - i));
  return {
    state: "matches",
    primary: areas[0],
    secondary: areas.slice(1, 5),
    overflowCount: 0,
    query: "q",
    meshResolution: null,
    areas,
    totalMatched: names.length,
    methodMatches: [],
  };
}

describe("ResearchAreasRow — re-measure on item-set change (#review-0707)", () => {
  it("updates '+N more' when the same instance is handed a larger set", () => {
    // Start with a 2-area set (fits, no overflow control).
    const { rerender } = render(<ResearchAreasRow result={matches(["Alpha", "Beta"])} />);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();

    // Refine the query → the SAME instance (no key) gets a 6-area set. With the
    // fallback fit of 4, the control must read "+2 more", not a stale value.
    rerender(
      <ResearchAreasRow
        result={matches(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"])}
      />,
    );
    expect(screen.getByRole("button", { name: /2 more/ })).toBeTruthy();
  });
});
