import "server-only";

import { AREA_BOOST_TOP_N } from "@/lib/search";
import { getConceptScholarConcentration } from "@/lib/api/search";
import {
  resolveAreaBoostTopN,
  resolveSearchPeopleAreaBoost,
  resolveSearchPeopleConceptArmFirst,
} from "@/lib/api/search-flags";
import type { TaxonomyMatchResult } from "@/lib/api/search-taxonomy";
import { getAreaScholarConcentration } from "@/lib/api/topics";

export type AreaConcentration = { cwid: string; total: number }[];

/**
 * Resolves the `{cwid,total}` concentration list that `searchPeople` tiers into the
 * prominence `function_score`. Two arms, and which one wins is the whole point:
 *
 * - **curated arm** — `getAreaScholarConcentration` over `taxonomyMatch.areas[0]`, the
 *   area drawn as the "Research Areas" chip. Keyed on AREA MEMBERSHIP, not on the query.
 * - **concept arm** (#1343) — `getConceptScholarConcentration` over the resolved MeSH
 *   `descendantUis`. Keyed on the QUERY's descriptor: on-topic count x on-topic fraction.
 *
 * #2018 — on master the curated arm always wins, because the concept arm is gated on the
 * curated one returning nothing. Measured 2026-07-29 on `gene therapy` / `genetic therapy`:
 * neither query matches any area NAME (verified against `matchesAtTokenBoundary`), yet
 * `gene_cell_therapy` and `ophthalmology_vision_science` both reach `matchedTopicSlugs` —
 * via a curated MeSH anchor (search-taxonomy.ts:681-693) or a subtopic collapsed to its
 * parent (:884-893). So `areas` is non-empty, the curated arm fires, and the arm actually
 * keyed on the descriptor never runs. The measured cost: scholars with 1-of-393 and
 * 1-of-607 tagged publications gained up to 30 ranks while the scholar with the highest
 * tagged count in the set (36 of 135) LOST 5.
 *
 * With `SEARCH_PEOPLE_CONCEPT_ARM_FIRST=on` the descriptor-keyed arm is tried first and the
 * curated arm becomes the fallback for queries that resolve no descriptor. Reorder-only —
 * a `function_score` function scores documents already matched, it never admits one, so
 * `total` and every facet bucket are invariant. Flag OFF reproduces master's arm order
 * exactly, including the number of round-trips.
 *
 * Called from BOTH `app/api/search/route.ts` and `app/(public)/search/page.tsx`; they must
 * resolve identically or the badge count and the result list diverge. That is why this
 * lives here rather than being mirrored in two files.
 *
 * server-only: pulls `@/lib/api/topics` (constructs `prisma`). Never import it from
 * `lib/edit/manageable-units.ts` or anything reachable from `components/edit/home-panel.tsx`.
 */
export async function resolveAreaConcentration(input: {
  taxonomyMatch: TaxonomyMatchResult;
  meshOff: boolean;
}): Promise<AreaConcentration | undefined> {
  const { taxonomyMatch, meshOff } = input;
  if (!resolveSearchPeopleAreaBoost() || meshOff) return undefined;

  const topN = resolveAreaBoostTopN(AREA_BOOST_TOP_N);
  const descendantUis = taxonomyMatch.meshResolution?.descendantUis ?? [];
  const conceptFirst = resolveSearchPeopleConceptArmFirst() && descendantUis.length > 0;

  let concentration: AreaConcentration | undefined;

  if (conceptFirst) {
    concentration = await getConceptScholarConcentration(descendantUis, topN);
  }

  if (
    !concentration?.length &&
    taxonomyMatch.state === "matches" &&
    taxonomyMatch.areas.length > 0
  ) {
    const top = taxonomyMatch.areas[0];
    const parentTopicId = top.entityType === "subtopic" ? top.parentTopicId : top.id;
    const subtopicId = top.entityType === "subtopic" ? top.id : null;
    if (parentTopicId) {
      concentration = await getAreaScholarConcentration(parentTopicId, subtopicId, topN);
    }
  }

  // #1343 — concept-axis fallback for queries with no curated area (obesity/hypertension).
  // ponytail: skipped when `conceptFirst` already ran it and came back empty — re-running
  // the same aggregation cannot return a different answer.
  if (!concentration?.length && !conceptFirst && descendantUis.length > 0) {
    concentration = await getConceptScholarConcentration(descendantUis, topN);
  }

  return concentration;
}
