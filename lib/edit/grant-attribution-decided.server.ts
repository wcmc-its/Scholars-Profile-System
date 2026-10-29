/**
 * #3071 — the decided tabs' loader. Server-only; the page gates first.
 *
 * One pass over every scored award and every review: a few thousand rows, read
 * whole, classified with `decidedTabOf`, then filtered, sorted and paged here.
 * Only the page's rows are hydrated (scholar, degree, decider, co-PI papers).
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { isWcmOrg } from "@/etl/reporter-grants/transform";
import { doctoralDegree } from "@/lib/edit/honor-queue";
import { formatPublishedName } from "@/lib/postnominal";

import { evidenceLevel } from "./grant-attribution-board";
import {
  DECIDED_PAGE_SIZE,
  DECIDED_TABS,
  decidedTabOf,
  sortableName,
  type DecidedPage,
  type DecidedParams,
  type DecidedRow,
  type DecidedTab,
} from "./grant-attribution-decided";
import {
  asRejectedPapers,
  decidingReason,
  type GrantAttributionAward,
  type GrantAttributionCue,
  type GrantAttributionPaper,
  type GrantAttributionRunTotals,
} from "./grant-attribution-queue";

type Client = Pick<
  PrismaClient,
  | "grantAttributionScore"
  | "grantAttributionReview"
  | "suppression"
  | "scholar"
  | "education"
  | "publication"
>;

const SYSTEM_UNVERIFIED = "system-unverified";
const SYSTEM_RESCORED = "system-rescored";
const SYSTEM_RECENCY = "system-recency";
const COPI_PAPERS_SHOWN = 3;

type StoredCue = Omit<GrantAttributionCue, "coPi"> & {
  coPi?: { name: string; pmids: string[]; total?: number };
};

function asCues(v: unknown): StoredCue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (c): c is StoredCue =>
        !!c &&
        typeof c.id === "string" &&
        typeof c.weight === "number" &&
        typeof c.reason === "string",
    )
    .map((c) => {
      const p = c.coPi;
      const ok =
        !!p &&
        typeof p.name === "string" &&
        Array.isArray(p.pmids) &&
        p.pmids.every((x) => typeof x === "string");
      const rejected = asRejectedPapers(c.rejected);
      return {
        id: c.id,
        weight: c.weight,
        reason: c.reason,
        ...(ok ? { coPi: p } : {}),
        ...(rejected ? { rejected } : {}),
      };
    });
}

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

/** One classified award before hydration. */
type Entry = {
  grantId: string;
  cwid: string;
  reviewId: string | null;
  tab: DecidedTab;
  by: "curator" | "auto";
  was: "hidden" | "queued" | null;
  stillHidden: boolean;
  changed: boolean;
  when: Date | null;
  decidedByCwid: string | null;
  rejectionReason: string | null;
  score: number;
  band: string;
  cues: StoredCue[];
  award: GrantAttributionAward;
  reporterName: string | null;
  name: string;
  haystack: string;
};

export async function loadDecidedPage(
  client: Client,
  params: DecidedParams,
  runs: ReadonlyArray<GrantAttributionRunTotals>,
  opts: { hydrate?: boolean } = {},
): Promise<DecidedPage> {
  const [scores, reviews] = await Promise.all([
    client.grantAttributionScore.findMany({
      select: {
        grantExternalId: true,
        cwid: true,
        band: true,
        score: true,
        cues: true,
        award: true,
        reporterName: true,
        scoredAt: true,
      },
    }),
    client.grantAttributionReview.findMany({
      select: {
        id: true,
        grantExternalId: true,
        cwid: true,
        status: true,
        decidedAt: true,
        decidedByCwid: true,
        rejectionReason: true,
        score: true,
        band: true,
        cues: true,
        award: true,
      },
    }),
  ]);
  const reviewOf = new Map(reviews.map((r) => [r.grantExternalId, r]));
  const scoreOf = new Map(scores.map((s) => [s.grantExternalId, s]));
  const ids = [...new Set([...scoreOf.keys(), ...reviewOf.keys()])];

  const supps =
    ids.length === 0
      ? []
      : await client.suppression.findMany({
          where: { entityType: "grant", entityId: { in: ids } },
          select: {
            entityId: true,
            createdBy: true,
            createdAt: true,
            revokedAt: true,
            revokedBy: true,
          },
        });
  const activeAny = new Set<string>();
  const activeRecency = new Set<string>();
  const hiddenAt = new Map<string, Date>();
  const recoveredAt = new Map<string, Date>();
  /** A person lifted the check's hide by hand: the award is live. */
  const liftedByHand = new Set<string>();
  for (const s of supps) {
    if (s.revokedAt === null) {
      activeAny.add(s.entityId);
      if (s.createdBy === SYSTEM_RECENCY) activeRecency.add(s.entityId);
      if (s.createdBy === SYSTEM_UNVERIFIED) {
        const prev = hiddenAt.get(s.entityId);
        if (!prev || s.createdAt > prev) hiddenAt.set(s.entityId, s.createdAt);
      }
    } else if (s.createdBy === SYSTEM_UNVERIFIED && s.revokedBy === SYSTEM_RESCORED) {
      const prev = recoveredAt.get(s.entityId);
      if (!prev || s.revokedAt > prev) recoveredAt.set(s.entityId, s.revokedAt);
    } else if (s.createdBy === SYSTEM_UNVERIFIED) {
      liftedByHand.add(s.entityId);
    }
  }
  // "Since the previous run": after the run before the latest finished.
  const since = runs[1] ? new Date(runs[1].ranAt) : null;

  const cwids = [...new Set([...scores.map((s) => s.cwid), ...reviews.map((r) => r.cwid)])];
  const people = new Map(
    (
      await client.scholar.findMany({
        where: { cwid: { in: cwids } },
        select: { cwid: true, fullName: true, preferredName: true },
      })
    ).map((s) => [s.cwid, s]),
  );

  const counts = Object.fromEntries(
    DECIDED_TABS.map((t) => [t, { all: 0, curator: 0, auto: 0 }]),
  ) as DecidedPage["counts"];
  const changedCounts = Object.fromEntries(
    DECIDED_TABS.map((t) => [t, 0]),
  ) as DecidedPage["changed"];
  const entries: Entry[] = [];

  for (const id of ids) {
    const sc = scoreOf.get(id);
    const rv = reviewOf.get(id);
    const cwid = sc?.cwid ?? rv!.cwid;
    if (rv?.status === "pending") continue;
    if (activeRecency.has(id)) continue; // hidden for age: out of scope
    const cues = asCues(sc?.cues ?? rv?.cues);
    const band = sc?.band ?? rv?.band ?? "";
    const cls = decidedTabOf({ reviewStatus: rv?.status ?? null, band, cues });
    if (!cls) continue;
    // No score row: the check no longer judges it, so nothing here could act on it.
    if (cls.by === "auto" && !sc) continue;
    // An auto-confirmed award someone hid outside the queue isn't on the profile.
    const stillHidden = hiddenAt.has(id);
    if (cls.by === "auto" && cls.tab === "confirmed" && activeAny.has(id) && !stillHidden) continue;
    // A hidden award a person lifted by hand is live, not rejected or unproven.
    if (cls.by === "auto" && cls.tab !== "confirmed" && !activeAny.has(id) && liftedByHand.has(id))
      continue;

    const recovered =
      cls.by === "auto" && cls.tab === "confirmed" ? (recoveredAt.get(id) ?? null) : null;
    const newer = (d: Date | null | undefined) => !!d && (since === null || d > since);
    // Shown again, or newly hidden as someone else's, by the latest check.
    const changed =
      cls.by === "auto" &&
      (cls.tab === "confirmed"
        ? newer(recovered)
        : cls.tab === "rejected" && newer(hiddenAt.get(id)));
    const when =
      cls.by === "curator"
        ? (rv?.decidedAt ?? null)
        : cls.tab === "confirmed"
          ? (recovered ?? sc?.scoredAt ?? null)
          : (hiddenAt.get(id) ?? sc?.scoredAt ?? null);
    const p = people.get(cwid);
    const award = asAward(sc?.award ?? rv?.award);
    const reporterName = sc?.reporterName ?? null;
    entries.push({
      grantId: id,
      cwid,
      reviewId: rv?.id ?? null,
      tab: cls.tab,
      by: cls.by,
      was: recovered ? (rv?.status === "withdrawn" ? "queued" : "hidden") : null,
      stillHidden: cls.by === "auto" && cls.tab === "confirmed" && stillHidden,
      changed,
      when,
      decidedByCwid: cls.by === "curator" ? (rv?.decidedByCwid ?? null) : null,
      rejectionReason: cls.by === "curator" ? (rv?.rejectionReason ?? null) : null,
      score: sc?.score ?? rv?.score ?? 0,
      band,
      cues,
      award,
      reporterName,
      name: sortableName(p?.fullName ?? cwid),
      haystack: [
        p?.fullName,
        p?.preferredName,
        cwid,
        award.title,
        award.awardNumber,
        award.coreProjectNum,
        reporterName,
        ...award.piNames,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    });
    counts[cls.tab].all++;
    counts[cls.tab][cls.by]++;
    if (changed) changedCounts[cls.tab]++;
  }

  const needle = params.q.toLowerCase();
  const matching = entries.filter(
    (e) =>
      e.tab === params.tab &&
      (params.by === "all" || e.by === params.by) &&
      (!params.changed || e.changed) &&
      (params.level === "all" || evidenceLevel(e.score, e.cues) === params.level) &&
      (!needle || e.haystack.includes(needle)),
  );
  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);
  matching.sort(
    params.sort === "name"
      ? (a, b) => byName(a, b) || b.score - a.score
      : params.sort === "low"
        ? (a, b) => a.score - b.score || byName(a, b)
        : (a, b) => b.score - a.score || byName(a, b),
  );

  const pageEntries = params.all
    ? matching
    : matching.slice((params.page - 1) * DECIDED_PAGE_SIZE, params.page * DECIDED_PAGE_SIZE);

  return {
    params,
    counts,
    changed: changedCounts,
    matched: matching.length,
    unprovenIds: entries.filter((e) => e.tab === "unproven").map((e) => e.grantId),
    rows: opts.hydrate === false ? [] : await hydrate(client, pageEntries),
  };
}

async function hydrate(client: Client, entries: Entry[]): Promise<DecidedRow[]> {
  if (entries.length === 0) return [];
  const cwids = new Set(entries.map((e) => e.cwid));
  for (const e of entries) if (e.decidedByCwid) cwids.add(e.decidedByCwid);
  const pmids = new Set<string>();
  for (const e of entries)
    for (const c of e.cues) for (const p of c.coPi?.pmids ?? []) pmids.add(p);

  const [scholars, educations, papers] = await Promise.all([
    client.scholar.findMany({
      where: { cwid: { in: [...cwids] } },
      select: {
        cwid: true,
        slug: true,
        fullName: true,
        preferredName: true,
        postnominal: true,
        roleCategory: true,
        primaryTitle: true,
        primaryDepartment: true,
      },
    }),
    client.education.findMany({
      where: { cwid: { in: [...new Set(entries.map((e) => e.cwid))] } },
      select: { cwid: true, degree: true, year: true },
    }),
    pmids.size === 0
      ? Promise.resolve([])
      : client.publication.findMany({
          where: { pmid: { in: [...pmids] } },
          select: { pmid: true, title: true, journal: true, year: true },
        }),
  ]);
  const scholarOf = new Map(scholars.map((s) => [s.cwid, s]));
  const paperOf = new Map<string, GrantAttributionPaper>(papers.map((p) => [p.pmid, p]));
  const doctorate = new Map<string, string>();
  for (const ed of educations) {
    const d = doctoralDegree(ed.degree);
    if (!d || ed.year === null) continue;
    const prev = doctorate.get(ed.cwid);
    const label = `${d} ${ed.year}`;
    if (!prev || Number(prev.split(" ")[1]) > ed.year) doctorate.set(ed.cwid, label);
  }

  return entries.map((e): DecidedRow => {
    const s = scholarOf.get(e.cwid);
    const decider = e.decidedByCwid ? scholarOf.get(e.decidedByCwid) : undefined;
    const cues: GrantAttributionCue[] = e.cues.map(({ coPi, ...c }) => {
      if (!coPi) return c;
      const shared = coPi.pmids
        .map((p) => paperOf.get(p))
        .filter((p): p is GrantAttributionPaper => !!p)
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      return {
        ...c,
        coPi: {
          name: coPi.name,
          total: typeof coPi.total === "number" ? coPi.total : coPi.pmids.length,
          papers: shared.slice(0, COPI_PAPERS_SHOWN),
        },
      };
    });
    const sorted = [...cues].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    const reason =
      e.by === "curator"
        ? e.tab === "rejected"
          ? e.rejectionReason
            ? `Curator: ${e.rejectionReason}`
            : "A curator marked it not this person"
          : "A curator confirmed it"
        : e.tab === "unproven"
          ? "Nothing found either way"
          : decidingReason(e.tab === "confirmed" ? "show" : "hide", sorted);
    return {
      grantId: e.grantId,
      reviewId: e.reviewId,
      tab: e.tab,
      by: e.by,
      was: e.was,
      changed: e.changed,
      stillHidden: e.stillHidden,
      when: e.when ? e.when.toISOString() : null,
      decidedByName: e.decidedByCwid
        ? (decider?.preferredName ?? decider?.fullName ?? "a curator")
        : null,
      rejectionReason: e.rejectionReason,
      score: e.score,
      cues: sorted,
      award: e.award,
      reporterName: e.reporterName,
      reason,
      scholar: {
        cwid: e.cwid,
        slug: s?.slug ?? null,
        name: e.name,
        displayName: formatPublishedName(
          s?.preferredName ?? s?.fullName ?? e.cwid,
          s?.postnominal ?? null,
          s?.roleCategory ?? null,
        ),
        degrees: s?.postnominal ?? null,
        title: s?.primaryTitle ?? null,
        department: s?.primaryDepartment ?? null,
        career: doctorate.get(e.cwid) ?? null,
        names: [s?.preferredName, s?.fullName].filter((n): n is string => !!n),
      },
    };
  });
}
