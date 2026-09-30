/**
 * The ONE "visible publications of a unit" predicate, shared by the three unit
 * Publications-tab list loaders (department / center / division) and the hero
 * research-area hover preview (`lib/api/unit-area-previews.ts`). Because the
 * preview and the area-filtered tab build their `where` here, the preview's
 * "See all N" always equals the filtered tab's total and its top 3 papers are
 * that tab's first 3 rows under "Most cited".
 *
 * A publication is visible for a unit when:
 *   1. it has at least one CONFIRMED author who is a unit member, and
 *   2. (with `area`) a unit member has a `publication_topic` row for that
 *      parent topic, and
 *   3. its pmid is not one of the unit's dark pmids (`resolveUnitDarkPmids`).
 *
 * `membership` is the unit's member predicate as the Publications tab defines
 * it — `{ scholar: { deptCode, deletedAt: null, status: "active" } }` for a
 * department, `{ cwid: { in: memberCwids } }` for a center or division. Both
 * `PublicationAuthor` and `PublicationTopic` carry `cwid` + a `scholar`
 * relation, so the same object filters either. It is deliberately NOT the
 * roster predicate (`publicRoleWhere`): #718 keeps student-authored work in a
 * unit's publication totals.
 *
 * Pure (no Prisma client) so it is safe to unit-test and to import anywhere
 * server-side.
 */
import type { Prisma } from "@/lib/generated/prisma/client";

export type UnitMembershipWhere =
  | { scholar: { deptCode: string; deletedAt: null; status: string } }
  | { cwid: { in: string[] } };

export function unitPublicationWhere({
  membership,
  darkPmids,
  area,
}: {
  membership: UnitMembershipWhere;
  darkPmids: string[];
  /** Parent topic id (`Topic.id`) to restrict to; omit for every area. */
  area?: string | null;
}): Prisma.PublicationWhereInput {
  return {
    authors: { some: { isConfirmed: true, ...membership } },
    ...(area ? { publicationTopics: { some: { parentTopicId: area, ...membership } } } : {}),
    ...(darkPmids.length > 0 ? { pmid: { notIn: darkPmids } } : {}),
  };
}
