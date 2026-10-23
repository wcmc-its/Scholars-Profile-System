/**
 * Report 14 — Grant attribution (#3071). How the weekly check sorted the NIH
 * awards RePORTER matched to scholars by name: run totals over time, the
 * evidence it used, a department roll-up, and the award list by outcome.
 *
 * Reads `grant_attribution_score` (the latest verdict per award, every band),
 * `grant_attribution_run` (one row of totals per run) and the review ledger.
 * Server-only. Filters are in memory: a few thousand rows at most, read by a
 * handful of curators.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { formatPublishedName } from "@/lib/postnominal";

import {
  decidingReason,
  type GrantAttributionAward,
  type GrantAttributionRunTotals,
} from "./grant-attribution-queue";
import { loadAutoConfirmed, loadGrantAttributionRuns } from "./grant-attribution-queue.server";

export const GRANT_ATTRIBUTION_OUTCOMES = ["hide", "show", "recovered", "queue"] as const;
export type GrantAttributionOutcome = (typeof GRANT_ATTRIBUTION_OUTCOMES)[number];

export const OUTCOME_LABEL: Record<GrantAttributionOutcome, string> = {
  hide: "Hidden",
  show: "Shown",
  recovered: "Recovered from hidden",
  queue: "In the queue",
};

/** Rows the award list renders; the count says how many matched. */
export const GRANT_ATTRIBUTION_LIST_CAP = 200;

export type GrantAttributionReportParams = {
  outcome: GrantAttributionOutcome;
  q: string;
  dept: string | null;
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseGrantAttributionParams(
  sp: Record<string, string | string[] | undefined>,
): GrantAttributionReportParams {
  const o = one(sp.outcome);
  const dept = one(sp.dept)?.trim();
  return {
    outcome: (GRANT_ATTRIBUTION_OUTCOMES as readonly string[]).includes(o ?? "")
      ? (o as GrantAttributionOutcome)
      : "hide",
    q: (one(sp.q) ?? "").trim().slice(0, 100),
    dept: dept ? dept.slice(0, 255) : null,
  };
}

export type GrantAttributionReportRow = {
  id: string;
  cwid: string;
  scholarName: string;
  scholarNames: string[];
  department: string | null;
  award: GrantAttributionAward;
  reporterName: string | null;
  band: string;
  why: string;
  /** No review open or decided on it, so "Send to review" applies. */
  requeueable: boolean;
};

export type GrantAttributionDeptRow = {
  name: string;
  scholars: number;
  awards: number;
  show: number;
  hide: number;
  queue: number;
};

export type GrantAttributionReport = {
  runs: GrantAttributionRunTotals[];
  curatorDecisions: number;
  depts: GrantAttributionDeptRow[];
  rows: GrantAttributionReportRow[];
  matched: number;
};

const NO_DEPT = "No department";

type Client = Pick<
  PrismaClient,
  | "grantAttributionScore"
  | "grantAttributionRun"
  | "grantAttributionReview"
  | "scholar"
  | "suppression"
>;

export async function loadGrantAttributionReport(
  client: Client,
  p: GrantAttributionReportParams,
): Promise<GrantAttributionReport> {
  const [runs, scores, reviews, auto] = await Promise.all([
    loadGrantAttributionRuns(client, 10),
    client.grantAttributionScore.findMany({
      select: {
        grantExternalId: true,
        cwid: true,
        band: true,
        cues: true,
        award: true,
        reporterName: true,
      },
    }),
    client.grantAttributionReview.findMany({ select: { grantExternalId: true, status: true } }),
    loadAutoConfirmed(client, { limit: Number.MAX_SAFE_INTEGER }),
  ]);
  const scholars = new Map(
    (
      await client.scholar.findMany({
        where: { cwid: { in: [...new Set(scores.map((s) => s.cwid))] } },
        select: {
          cwid: true,
          preferredName: true,
          fullName: true,
          postnominal: true,
          roleCategory: true,
          primaryDepartment: true,
        },
      })
    ).map((s) => [s.cwid, s]),
  );
  const deptOf = (cwid: string) => scholars.get(cwid)?.primaryDepartment ?? NO_DEPT;
  const reviewOf = new Map(reviews.map((r) => [r.grantExternalId, r.status]));
  const recovered = new Set(auto.items.map((a) => a.id));

  const byDept = new Map<string, GrantAttributionDeptRow & { cwids: Set<string> }>();
  for (const s of scores) {
    const name = deptOf(s.cwid);
    const d = byDept.get(name) ?? {
      name,
      scholars: 0,
      awards: 0,
      show: 0,
      hide: 0,
      queue: 0,
      cwids: new Set(),
    };
    d.cwids.add(s.cwid);
    d.awards++;
    if (s.band === "show" || s.band === "hide" || s.band === "queue") d[s.band]++;
    byDept.set(name, d);
  }
  const depts = [...byDept.values()]
    .map(({ cwids, ...d }) => ({ ...d, scholars: cwids.size }))
    .sort((a, b) => b.awards - a.awards || a.name.localeCompare(b.name));

  const needle = p.q.toLowerCase();
  const matching = scores
    .filter((s) =>
      p.outcome === "recovered" ? recovered.has(s.grantExternalId) : s.band === p.outcome,
    )
    .filter((s) => p.dept === null || deptOf(s.cwid) === p.dept)
    .map((s) => {
      const sch = scholars.get(s.cwid);
      const award = (s.award ?? {}) as Partial<GrantAttributionAward>;
      const status = reviewOf.get(s.grantExternalId);
      const row: GrantAttributionReportRow = {
        id: s.grantExternalId,
        cwid: s.cwid,
        scholarName: formatPublishedName(
          sch?.preferredName ?? sch?.fullName ?? s.cwid,
          sch?.postnominal ?? null,
          sch?.roleCategory ?? null,
        ),
        scholarNames: [sch?.preferredName, sch?.fullName].filter((n): n is string => !!n),
        department: sch?.primaryDepartment ?? null,
        award: {
          title: award.title ?? null,
          awardNumber: award.awardNumber ?? null,
          coreProjectNum: award.coreProjectNum ?? null,
          activityCode: award.activityCode ?? null,
          applId: typeof award.applId === "number" ? award.applId : null,
          startYear: award.startYear ?? null,
          endYear: award.endYear ?? null,
          orgs: Array.isArray(award.orgs) ? award.orgs : [],
          piNames: Array.isArray(award.piNames) ? award.piNames : [],
        },
        reporterName: s.reporterName,
        band: s.band,
        why: decidingReason(
          s.band,
          Array.isArray(s.cues)
            ? (s.cues as Array<{ id: string; weight: number; reason: string }>)
            : [],
        ),
        requeueable: s.band !== "queue" && (status === undefined || status === "withdrawn"),
      };
      return row;
    })
    .filter(
      (r) =>
        needle === "" ||
        [r.scholarName, r.award.title, r.award.awardNumber, r.reporterName, ...r.award.piNames]
          .filter(Boolean)
          .some((x) => x!.toLowerCase().includes(needle)),
    )
    .sort((a, b) => a.scholarName.localeCompare(b.scholarName));

  return {
    runs,
    curatorDecisions: reviews.filter((r) => r.status === "confirmed" || r.status === "rejected")
      .length,
    depts,
    rows: matching.slice(0, GRANT_ATTRIBUTION_LIST_CAP),
    matched: matching.length,
  };
}
