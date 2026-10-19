/**
 * #3071 — the grant attribution queue's loaders. Server-only: the client
 * component imports the pure sibling `grant-attribution-queue.ts` instead.
 * Every loader takes the Prisma client as a parameter (the honors convention)
 * and none checks authorization: the page and routes gate first.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { formatPublishedName } from "@/lib/postnominal";

import type {
  GrantAttributionAward,
  GrantAttributionCue,
  GrantAttributionItem,
  GrantAttributionStatus,
} from "./grant-attribution-queue";

type Client = Pick<PrismaClient, "grantAttributionReview" | "scholar" | "grant">;

function asAward(v: unknown): GrantAttributionAward {
  const a = (v && typeof v === "object" ? v : {}) as Partial<GrantAttributionAward>;
  return {
    title: a.title ?? null,
    awardNumber: a.awardNumber ?? null,
    coreProjectNum: a.coreProjectNum ?? null,
    activityCode: a.activityCode ?? null,
    applId: typeof a.applId === "number" ? a.applId : null,
    startYear: a.startYear ?? null,
    endYear: a.endYear ?? null,
    orgs: Array.isArray(a.orgs) ? a.orgs : [],
    piNames: Array.isArray(a.piNames) ? a.piNames : [],
  };
}

function asCues(v: unknown): GrantAttributionCue[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is GrantAttributionCue =>
      !!c && typeof c.id === "string" && typeof c.weight === "number" && typeof c.reason === "string",
  );
}

/**
 * One status bucket of the queue, newest-first for decided items and
 * oldest-first for pending ones. A pending item whose grant row no longer
 * exists (reconciled out of RePORTER, or now covered by InfoEd) is left out:
 * there is nothing on the profile left to decide.
 */
export async function loadGrantAttributionQueue(
  client: Client,
  status: GrantAttributionStatus,
  opts: { limit?: number } = {},
): Promise<GrantAttributionItem[]> {
  const rows = await client.grantAttributionReview.findMany({
    where: { status },
    orderBy: status === "pending" ? { firstSeenAt: "asc" } : { decidedAt: "desc" },
    take: opts.limit ?? 500,
  });
  if (rows.length === 0) return [];

  let live: Set<string> | null = null;
  if (status === "pending") {
    live = new Set(
      (
        await client.grant.findMany({
          where: { id: { in: rows.map((r) => r.grantExternalId) } },
          select: { id: true },
        })
      ).map((g) => g.id),
    );
  }

  const cwids = new Set(rows.map((r) => r.cwid));
  for (const r of rows) if (r.decidedByCwid) cwids.add(r.decidedByCwid);
  const scholars = new Map(
    (
      await client.scholar.findMany({
        where: { cwid: { in: [...cwids] } },
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          fullName: true,
          postnominal: true,
          roleCategory: true,
          primaryTitle: true,
          primaryDepartment: true,
        },
      })
    ).map((s) => [s.cwid, s]),
  );

  return rows
    .filter((r) => live === null || live.has(r.grantExternalId))
    .map((r) => {
      const s = scholars.get(r.cwid);
      const decider = r.decidedByCwid ? scholars.get(r.decidedByCwid) : undefined;
      return {
        id: r.id,
        cwid: r.cwid,
        slug: s?.slug ?? null,
        scholarName: formatPublishedName(
          s?.preferredName ?? s?.fullName ?? r.cwid,
          s?.postnominal ?? null,
          s?.roleCategory ?? null,
        ),
        title: s?.primaryTitle ?? null,
        department: s?.primaryDepartment ?? null,
        score: r.score,
        band: r.band,
        cues: asCues(r.cues),
        award: asAward(r.award),
        status: r.status as GrantAttributionStatus,
        firstSeenAt: r.firstSeenAt.toISOString(),
        reopenedAt: r.reopenedAt ? r.reopenedAt.toISOString() : null,
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        decidedByName: r.decidedByCwid
          ? (decider?.preferredName ?? decider?.fullName ?? r.decidedByCwid)
          : null,
        rejectionReason: r.rejectionReason,
      };
    });
}

/** The sub-nav pill. Counts pending reviews regardless of grant liveness: a
 *  cheap index read, and the page shows the exact list. */
export function countPendingGrantAttribution(
  client: Pick<PrismaClient, "grantAttributionReview">,
): Promise<number> {
  return client.grantAttributionReview.count({ where: { status: "pending" } });
}
