/**
 * Unit Page v2 — per-member publication / grant counts for a roster, computed
 * the way each surface DISPLAYS them, so a "Most publications" / "Most grants"
 * sort always orders rows by the number the row shows (the row builders read
 * their badges from this module too).
 *
 *   - publications (every kind): confirmed `publication_author` rows minus the
 *     scholar's #356 per-author hides — one paper counts once, and a paper
 *     with no topic still counts. (`publication_topic` is keyed
 *     (pmid, cwid, parentTopicId), so counting its rows scored a paper once
 *     per parent topic and skipped untopiced papers; that over-count used to
 *     rank department and center rosters differently from division rosters.)
 *   - grants, department: active (endDate >= now), non-RePORTER.
 *   - grants, division: every non-RePORTER grant (`getDivisionFaculty`).
 *   - grants, center: active non-RePORTER minus #160-suppressed ones
 *     (`buildCenterMemberHits`, #481(b)).
 *
 * Server-only (Prisma).
 */
import { prisma } from "@/lib/db";
import {
  loadHiddenAuthorshipCounts,
  resolveActiveGrantSuppression,
} from "@/lib/api/manual-layer";

export type RosterCountKind = "department" | "division" | "center";

export type RosterCounts = {
  pubs: Map<string, number>;
  grants: Map<string, number>;
};

type CountRow = { cwid: string; _count: { _all?: number } };

export async function loadRosterCounts(
  kind: RosterCountKind,
  cwids: readonly string[],
): Promise<RosterCounts> {
  const pubs = new Map<string, number>();
  const grants = new Map<string, number>();
  if (cwids.length === 0) return { pubs, grants };
  const inList = [...cwids];
  const now = new Date();

  const groupBy = (model: "publicationAuthor" | "grant", args: unknown) =>
    (prisma[model].groupBy as unknown as (a: unknown) => Promise<CountRow[]>)(args);

  const pubsP = (async () => {
    const [pubRows, hidden] = await Promise.all([
      groupBy("publicationAuthor", {
        by: ["cwid"],
        where: { isConfirmed: true, cwid: { in: inList } },
        _count: { _all: true },
        orderBy: { cwid: "asc" },
      }),
      loadHiddenAuthorshipCounts(inList, prisma),
    ]);
    for (const r of pubRows) {
      pubs.set(r.cwid, Math.max(0, (r._count._all ?? 0) - (hidden.get(r.cwid) ?? 0)));
    }
  })();

  if (kind === "division") {
    const [, grantRows] = await Promise.all([
      pubsP,
      groupBy("grant", {
        by: ["cwid"],
        where: { cwid: { in: inList }, source: { not: "RePORTER" } },
        _count: { _all: true },
        orderBy: { cwid: "asc" },
      }),
    ]);
    for (const r of grantRows) grants.set(r.cwid, r._count._all ?? 0);
    return { pubs, grants };
  }

  const grantWhere = { cwid: { in: inList }, endDate: { gte: now }, source: { not: "RePORTER" } };

  if (kind === "center") {
    const [, grantRows] = await Promise.all([
      pubsP,
      prisma.grant.findMany({
        where: grantWhere,
        select: { cwid: true, externalId: true, id: true },
      }) as Promise<Array<{ cwid: string; externalId: string | null; id: string }>>,
    ]);
    const suppressed =
      grantRows.length > 0
        ? (await resolveActiveGrantSuppression(grantRows, prisma)).suppressed
        : new Set<string>();
    for (const g of grantRows) {
      if (g.externalId !== null && suppressed.has(g.externalId)) continue;
      grants.set(g.cwid, (grants.get(g.cwid) ?? 0) + 1);
    }
    return { pubs, grants };
  }

  const [, grantRows] = await Promise.all([
    pubsP,
    groupBy("grant", {
      by: ["cwid"],
      where: grantWhere,
      _count: { _all: true },
      orderBy: { cwid: "asc" },
    }),
  ]);
  for (const r of grantRows) grants.set(r.cwid, r._count._all ?? 0);
  return { pubs, grants };
}
