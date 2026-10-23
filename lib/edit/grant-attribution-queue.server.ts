/**
 * #3071 — the grant attribution queue's loaders. Server-only: the client
 * component imports the pure sibling `grant-attribution-queue.ts` instead.
 * Every loader takes the Prisma client as a parameter (the honors convention)
 * and none checks authorization: the page and routes gate first.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { isWcmOrg } from "@/etl/reporter-grants/transform";
import { formatPublishedName } from "@/lib/postnominal";

import {
  decidingReason,
  type GrantAttributionAutoItem,
  type GrantAttributionAward,
  type GrantAttributionCue,
  type GrantAttributionItem,
  type GrantAttributionPaper,
  type GrantAttributionRunTotals,
  type GrantAttributionStatus,
} from "./grant-attribution-queue";

type Client = Pick<
  PrismaClient,
  "grantAttributionReview" | "grantAttributionScore" | "scholar" | "grant" | "publication"
>;

/** The ETL's hide on a name-matched award, and its revoke when the scorer now
 *  says show (`etl/reporter-grants`). */
const SYSTEM_UNVERIFIED = "system-unverified";
const SYSTEM_RESCORED = "system-rescored";

/** The scholar's names on record, for marking where RePORTER's differs. */
const namesOf = (s: { preferredName?: string | null; fullName?: string | null } | undefined) =>
  [s?.preferredName, s?.fullName].filter((n): n is string => !!n);

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

  const reporterNames = new Map(
    (
      await client.grantAttributionScore.findMany({
        where: { grantExternalId: { in: rows.map((r) => r.grantExternalId) } },
        select: { grantExternalId: true, reporterName: true },
      })
    ).map((x) => [x.grantExternalId, x.reporterName]),
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
        reporterName: reporterNames.get(r.grantExternalId) ?? null,
        scholarNames: namesOf(s),
      };
    });
}

/** The latest scoring runs, newest first. */
export async function loadGrantAttributionRuns(
  client: Pick<PrismaClient, "grantAttributionRun">,
  take = 2,
): Promise<GrantAttributionRunTotals[]> {
  const rows = await client.grantAttributionRun.findMany({ orderBy: { ranAt: "desc" }, take });
  return rows.map((r) => ({
    ranAt: r.ranAt.toISOString(),
    scholars: r.scholars,
    show: r.show,
    hide: r.hide,
    queue: r.queue,
    recovered: r.recovered,
    cues:
      r.cues && typeof r.cues === "object" && !Array.isArray(r.cues)
        ? Object.fromEntries(
            Object.entries(r.cues as Record<string, unknown>).filter(
              (e): e is [string, number] => typeof e[1] === "number",
            ),
          )
        : {},
  }));
}

/**
 * Awards the weekly check hid or queued and later showed again on its own (its
 * hide revoked as `system-rescored`), newest first. Left out: an award hidden
 * again since, one a curator has decided or is reviewing, and one the scorer
 * no longer says show. `total` counts them all; `items` is capped.
 */
export async function loadAutoConfirmed(
  client: Pick<PrismaClient, "suppression" | "grantAttributionReview" | "grantAttributionScore" | "scholar">,
  opts: { limit?: number } = {},
): Promise<{ items: GrantAttributionAutoItem[]; total: number }> {
  const revoked = await client.suppression.findMany({
    where: { entityType: "grant", createdBy: SYSTEM_UNVERIFIED, revokedBy: SYSTEM_RESCORED },
    orderBy: { revokedAt: "desc" },
    select: { entityId: true, revokedAt: true },
  });
  const latest = new Map<string, Date>();
  for (const r of revoked) if (r.revokedAt && !latest.has(r.entityId)) latest.set(r.entityId, r.revokedAt);
  if (latest.size === 0) return { items: [], total: 0 };
  const ids = [...latest.keys()];

  const [active, reviews, scores] = await Promise.all([
    client.suppression.findMany({
      // Any active hide (a curator's, the age rule's) means it is not showing.
      where: { entityType: "grant", entityId: { in: ids }, revokedAt: null },
      select: { entityId: true },
    }),
    client.grantAttributionReview.findMany({
      where: { grantExternalId: { in: ids } },
      select: { grantExternalId: true, status: true },
    }),
    client.grantAttributionScore.findMany({
      where: { grantExternalId: { in: ids }, band: "show" },
    }),
  ]);
  const hiddenAgain = new Set(active.map((a) => a.entityId));
  const reviewOf = new Map(reviews.map((r) => [r.grantExternalId, r.status]));
  const scoreOf = new Map(scores.map((x) => [x.grantExternalId, x]));
  const kept = ids.filter((id) => {
    const st = reviewOf.get(id);
    return !hiddenAgain.has(id) && scoreOf.has(id) && (st === undefined || st === "withdrawn");
  });
  const page = kept.slice(0, opts.limit ?? 200);

  const scholars = new Map(
    (
      await client.scholar.findMany({
        where: { cwid: { in: [...new Set(page.map((id) => scoreOf.get(id)!.cwid))] } },
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          fullName: true,
          postnominal: true,
          roleCategory: true,
          primaryDepartment: true,
        },
      })
    ).map((s) => [s.cwid, s]),
  );
  const items = page.map((id) => {
    const sc = scoreOf.get(id)!;
    const s = scholars.get(sc.cwid);
    return {
      id,
      cwid: sc.cwid,
      slug: s?.slug ?? null,
      scholarName: formatPublishedName(
        s?.preferredName ?? s?.fullName ?? sc.cwid,
        s?.postnominal ?? null,
        s?.roleCategory ?? null,
      ),
      scholarNames: namesOf(s),
      department: s?.primaryDepartment ?? null,
      award: asAward(sc.award),
      reporterName: sc.reporterName,
      was: reviewOf.get(id) === "withdrawn" ? ("queued" as const) : ("hidden" as const),
      decidedAt: latest.get(id)!.toISOString(),
      reason: decidingReason("show", asCues(sc.cues)),
    };
  });
  return { items, total: kept.length };
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
