/**
 * #3071 — the grant attribution queue's loaders. Server-only: the client
 * component imports the pure sibling `grant-attribution-queue.ts` instead.
 * Every loader takes the Prisma client as a parameter (the honors convention)
 * and none checks authorization: the page and routes gate first.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { isWcmOrg } from "@/etl/reporter-grants/transform";
import { formatPublishedName } from "@/lib/postnominal";

import type {
  GrantAttributionAward,
  GrantAttributionCue,
  GrantAttributionItem,
  GrantAttributionPaper,
  GrantAttributionStatus,
} from "./grant-attribution-queue";

type Client = Pick<PrismaClient, "grantAttributionReview" | "scholar" | "grant" | "publication">;

/** Shared papers listed under a co-PI cue. */
const COPI_PAPERS_SHOWN = 3;

type StoredCue = Omit<GrantAttributionCue, "coPi"> & { coPi?: { name: string; pmids: string[]; total?: number } };

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
    orgs: Array.isArray(a.orgs) ? a.orgs.map((o) => ({ ...o, wcm: isWcmOrg(o.name) })) : [],
    piNames: Array.isArray(a.piNames) ? a.piNames : [],
  };
}

function asCues(v: unknown): StoredCue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (c): c is StoredCue =>
        !!c && typeof c.id === "string" && typeof c.weight === "number" && typeof c.reason === "string",
    )
    .map((c) => {
      const p = c.coPi;
      const ok = !!p && typeof p.name === "string" && Array.isArray(p.pmids) && p.pmids.every((x) => typeof x === "string");
      return { id: c.id, weight: c.weight, reason: c.reason, ...(ok ? { coPi: p } : {}) };
    });
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

  const stored = new Map(rows.map((r) => [r.id, asCues(r.cues)]));
  const pmids = new Set<string>();
  for (const cues of stored.values()) for (const c of cues) for (const p of c.coPi?.pmids ?? []) pmids.add(p);
  const papers = new Map<string, GrantAttributionPaper>(
    pmids.size === 0
      ? []
      : (
          await client.publication.findMany({
            where: { pmid: { in: [...pmids] } },
            select: { pmid: true, title: true, journal: true, year: true },
          })
        ).map((p) => [p.pmid, p]),
  );
  const resolveCues = (cues: StoredCue[]): GrantAttributionCue[] =>
    cues.map(({ coPi, ...c }) => {
      if (!coPi) return c;
      const shared = coPi.pmids
        .map((p) => papers.get(p))
        .filter((p): p is GrantAttributionPaper => !!p)
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      return { ...c, coPi: { name: coPi.name, total: typeof coPi.total === "number" ? coPi.total : coPi.pmids.length, papers: shared.slice(0, COPI_PAPERS_SHOWN) } };
    });

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
        scholarSurname: (s?.fullName ?? "").split(",")[0]!.trim().split(/\s+/).pop() || null,
        title: s?.primaryTitle ?? null,
        department: s?.primaryDepartment ?? null,
        score: r.score,
        band: r.band,
        cues: resolveCues(stored.get(r.id) ?? []),
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

/** Every review in one status, for the decided tabs' pills (their lists are
 *  capped). */
export function countGrantAttribution(
  client: Pick<PrismaClient, "grantAttributionReview">,
  status: GrantAttributionStatus,
): Promise<number> {
  return client.grantAttributionReview.count({ where: { status } });
}
