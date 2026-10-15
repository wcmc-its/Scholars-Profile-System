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

/**
 * Research-area ranking with grants and trials (server-only, read like the ones
 * above). `TOPIC_RANK_AREA_SIGNALS=on` adds PI grant and PI clinical-trial
 * points (lib/ranking.ts `scoreAreaSignals`) to the topic page's top-scholar
 * order, `getTopScholarsForTopic` only, and only for scholars who already rank
 * there on their papers. Membership, counts, subarea lists, search and the CSV
 * export are unchanged either way.
 *
 * Off (the default) is today's order exactly.
 */
export function isTopicRankAreaSignalsOn(): boolean {
  return process.env.TOPIC_RANK_AREA_SIGNALS === "on";
}

/**
 * Research-area feed of grants and trials (server-only, read like the ones
 * above). `TOPIC_FEED_GRANTS_TRIALS=on` serves `/api/topics/[slug]/activity`
 * (lib/api/topic-activity.ts): the area's PI grants and PI clinical trials as
 * feed items, cut at the area's display threshold like its papers.
 *
 * Off (the default) the route answers 404. The page control ("Activities")
 * that reads it lands in a later PR behind the same flag.
 */
export function isTopicFeedGrantsTrialsOn(): boolean {
  return process.env.TOPIC_FEED_GRANTS_TRIALS === "on";
}
