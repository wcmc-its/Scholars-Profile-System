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

/**
 * Topic / method page phase 4 flag (server-only, read like the one above).
 *
 * `TAXONOMY_FEED_LOAD_MORE=on` turns on, together, on the topic, method family
 * and method category publication feeds:
 *   - "Show 20 more · 40 of 279" Load more in place of numbered pages, with
 *     `?shown=N` kept in the URL so Back restores the loaded rows, and the
 *     routes' bounded `limit` param that restores them in one request;
 *   - on topics, ONE "All relevant" list instead of the strongly list plus a
 *     separate "Also relevant" section;
 *   - the per-row area label ("· {subarea}" / "· {family}") when no rail item
 *     is selected;
 *   - on the category page, the paged, sortable "All families" feed over every
 *     family's pubs (`/api/methods/[sc]/all/publications`) in place of the
 *     fixed 12-newest list.
 *
 * Off (the default) is today's behavior, and the new route answers 404.
 */
export function isTaxonomyFeedLoadMoreOn(): boolean {
  return process.env.TAXONOMY_FEED_LOAD_MORE === "on";
}
