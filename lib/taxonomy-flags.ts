/**
 * Topic / method page phase 3 flag. Server-only: pages read it at render and
 * pass a boolean down; the two publication routes read it per request.
 *
 * `TAXONOMY_SCHOLAR_CARDS=on` turns on, together:
 *   - the portrait `ScholarCardGrid` (top 6 with area chips) in place of the
 *     `TopScholarsChipRow` on topic, method family and method category pages;
 *   - the pick-to-filter scholar cards for the selected rail item, and the
 *     `?cwid=` filter on `/api/topics/[slug]/publications` and
 *     `/api/methods/[sc]/[family]/publications`.
 *
 * Off (the default) is today's behavior: the chip row renders, the selected-item
 * scholars are plain profile links, and both routes ignore `cwid`.
 *
 * Wired per env in `cdk/lib/app-stack.ts` (flag-parity rule); a merged value is
 * dark until `cdk deploy Sps-App-<env>`.
 */
export function isTaxonomyScholarCardsOn(): boolean {
  return process.env.TAXONOMY_SCHOLAR_CARDS === "on";
}
