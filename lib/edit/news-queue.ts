/**
 * The news-mentions approval queue loader (docs/2026-07-18-news-mentions-plan.md).
 *
 * etl/news attaches a scholar to an article two ways: a VIVO cwid link (trusted,
 * published straight away) or a prose full-name match (untrusted — one PENDING
 * row per candidate). This queue is where comms confirms the name matches before
 * they reach a public profile. A full name that matched more than one scholar
 * yields competing candidates sharing a `sourceRef` (`<url>|<foldedName>`): at
 * most one is the right person, so approving one MUST reject the siblings (the
 * decision route does this atomically — see app/api/edit/news-mention/decision).
 *
 * Read-only and pure of authz: the caller gates (isSuperuser || isCommsSteward).
 */
import { formatPublishedName } from "@/lib/postnominal";
import { formatRoleCategory } from "@/lib/role-display";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { NewsMentionStatus } from "@/lib/generated/prisma/enums";

/** The Prisma surface this loader needs — a hand-rolled structural type does NOT
 *  accept a real `PrismaClient`, so Pick from it. */
type NewsQueueClient = Pick<PrismaClient, "newsMention" | "scholar">;

export type NewsQueueRow = {
  id: string;
  cwid: string;
  slug: string | null;
  /** The name AS THE PROFILE RENDERS IT (preferredName + postnominal). */
  scholarName: string;
  roleLabel: string | null;
  roleCategory: string | null;
  /** The scholar's primary title + department — the disambiguators the reviewer
   *  weighs when a name matched more than one person. */
  title: string | null;
  department: string | null;
  articleTitle: string;
  articleUrl: string;
  publishedAt: string | null;
  /** The prose name string the ETL matched — "the name being matched against". */
  detectedName: string | null;
  likelihood: string | null;
  /** How the ETL attached this scholar: `VIVO` (trusted cwid link, auto-published)
   *  or `NAME` (prose match, queue-reviewed). Only shown on the history tabs —
   *  pending is name-only. */
  source: string;
  sourceRef: string | null;
  createdAt: string;
  /** When decided (approve/reject) — its `updatedAt`; equals seed time on Pending. */
  decidedAt: string;
  /** Competing candidates for the same detected name (contested groups only). */
  competingCwids: string[];
};

/** One detected-name's worth of candidates. A group of 1 is the normal case. */
export type NewsQueueGroup = {
  /** `sourceRef` when present; otherwise the row id (an unlinked singleton). */
  key: string;
  rows: NewsQueueRow[];
  /** The prose name shared by every candidate on a contested group. */
  detectedName: string | null;
  /** True when >1 scholar competes for one detected name ⇒ approving one MUST
   *  reject the others. The UI must not offer a plain "approve" here. */
  contested: boolean;
};

export function isNewsQueueEnabled(): boolean {
  return process.env.NEWS_APPROVAL_QUEUE === "on";
}

/**
 * Whether to advertise the "News" tab in the admin sub-nav for this viewer: the
 * surface is enabled AND the viewer can open it. Mirrors `isHonorsQueueTabVisible`.
 *
 * 🔴 `isSuperuser || isCommsSteward`, never a bare `isCommsSteward`: the session
 * route reports role booleans as `false` FOR a superuser to skip a redundant
 * LDAPS call, and a bare role read would lock superusers out of a surface they
 * administer.
 */
export function isNewsQueueTabVisible(session: {
  isSuperuser: boolean;
  isCommsSteward?: boolean;
}): boolean {
  return isNewsQueueEnabled() && (session.isSuperuser || session.isCommsSteward === true);
}

const LIKELIHOOD_RANK: Readonly<Record<string, number>> = { HIGH: 2, MEDIUM: 1 };

/**
 * How many rows the read-only history tabs load.
 *
 * ponytail: a flat cap, not pagination. Mentions are never deleted (etl/news
 * upserts, never downgrades), so `published` grows monotonically — the weekly
 * scrape adds to it forever, and a full `NEWS_BACKFILL` lands ~1,200 rows on day
 * one. Uncapped, every one of them is materialised, joined against a scholar
 * IN-list, and serialised into the client-component payload on EVERY visit to
 * the page — including the Pending workflow, which loads all three tabs at once.
 * Pending itself is the working queue and must be complete, so it is uncapped.
 * Upgrade path if comms ever needs the deep history: a cursor on
 * (publishedAt, id) plus a (status, publishedAt) index — there is no index on
 * `status` today, both existing ones lead with `cwid`.
 */
export const NEWS_HISTORY_LIMIT = 500;

/**
 * Mentions in `status`, grouped by the detected name they came from.
 *
 * NOT filtered to `source: "NAME"`. Pending is name-only by construction (a VIVO
 * link publishes straight away and never sits pending), but the history statuses
 * must show BOTH sources: a scholar with only VIVO-published mentions on their
 * profile would otherwise appear nowhere in the queue at all. A VIVO row has a
 * null `sourceRef`, so it groups alone under `id:<id>` and is never contested.
 *
 * Ordering: Pending puts confident single matches (HIGH, uncontested) first and
 * sinks contested groups (they need human disambiguation). The history tabs skip
 * that rank entirely — VIVO rows have a null likelihood and would rank 0, burying
 * them under every NAME approval. Both then sort most-recent article first, with
 * `createdAt` breaking the final tie for a deterministic order.
 */
export async function loadNewsQueue(
  client: NewsQueueClient,
  status: NewsMentionStatus = "pending",
): Promise<NewsQueueGroup[]> {
  // Pending is the working queue: complete, oldest-first. History is capped, so
  // it must order newest-first at the DB or the cap would keep the oldest rows.
  const isHistory = status !== "pending";
  const rows = await client.newsMention.findMany({
    where: { status },
    orderBy: isHistory
      ? [{ publishedAt: "desc" }, { createdAt: "desc" }]
      : { createdAt: "asc" },
    ...(isHistory ? { take: NEWS_HISTORY_LIMIT } : {}),
    select: {
      id: true,
      cwid: true,
      url: true,
      title: true,
      publishedAt: true,
      detectedName: true,
      likelihood: true,
      source: true,
      sourceRef: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (rows.length === 0) return [];

  // One query for every scholar, not one per row.
  const scholars = await client.scholar.findMany({
    where: { cwid: { in: [...new Set(rows.map((r) => r.cwid))] } },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      postnominal: true,
      fullName: true,
      roleCategory: true,
      primaryTitle: true,
      primaryDepartment: true,
    },
  });
  const byCwid = new Map(scholars.map((s) => [s.cwid, s]));

  // Group by detected-name line. A NULL sourceRef is its own group keyed by id,
  // never lumped with other NULLs (which would falsely mark rows as competing).
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.sourceRef ?? `id:${r.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }

  const out: NewsQueueGroup[] = [];
  for (const [key, groupRows] of groups) {
    const cwids = groupRows.map((r) => r.cwid);
    const contested = new Set(cwids).size > 1;
    out.push({
      key,
      contested,
      detectedName: groupRows[0].detectedName,
      rows: groupRows.map((r) => {
        const s = byCwid.get(r.cwid);
        const preferred = s?.preferredName ?? s?.fullName ?? r.cwid;
        return {
          id: r.id,
          cwid: r.cwid,
          slug: s?.slug ?? null,
          scholarName: formatPublishedName(preferred, s?.postnominal ?? null),
          roleLabel: formatRoleCategory(s?.roleCategory ?? null),
          roleCategory: s?.roleCategory ?? null,
          title: s?.primaryTitle ?? null,
          department: s?.primaryDepartment ?? null,
          articleTitle: r.title,
          articleUrl: r.url,
          publishedAt: r.publishedAt ? r.publishedAt.toISOString().slice(0, 10) : null,
          detectedName: r.detectedName,
          likelihood: r.likelihood,
          source: r.source,
          sourceRef: r.sourceRef,
          createdAt: r.createdAt.toISOString(),
          decidedAt: r.updatedAt.toISOString(),
          competingCwids: contested ? cwids.filter((c) => c !== r.cwid) : [],
        };
      }),
    });
  }

  const rankByLikelihood = status === "pending";
  return out.sort((a, b) => {
    if (rankByLikelihood) {
      const ra = a.contested ? 0 : (LIKELIHOOD_RANK[a.rows[0].likelihood ?? ""] ?? 0);
      const rb = b.contested ? 0 : (LIKELIHOOD_RANK[b.rows[0].likelihood ?? ""] ?? 0);
      if (ra !== rb) return rb - ra;
    }
    const ad = a.rows[0].publishedAt;
    const bd = b.rows[0].publishedAt;
    if (ad !== bd) {
      if (ad === null) return 1;
      if (bd === null) return -1;
      return bd.localeCompare(ad);
    }
    return a.rows[0].createdAt.localeCompare(b.rows[0].createdAt);
  });
}

/** Count pending mentions — the admin sub-nav's pending-count pill. */
export function countPendingNews(client: Pick<PrismaClient, "newsMention">): Promise<number> {
  return client.newsMention.count({ where: { status: "pending" } });
}
