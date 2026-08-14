/**
 * Shared server-side plumbing for the `/edit/reports/*` console — the
 * top-level home for what used to be the `?attr=reports` / `?attr=nci-2a`
 * tabs buried inside `/edit/center/[code]` (unit-curation-edit-ui-spec.md).
 * Both the center-code resolution and the authorization gate live here so
 * the index page and its five numbered report pages can't drift from each
 * other, or from the per-unit editor surface they're replacing.
 */
import { notFound, redirect } from "next/navigation";

import {
  loadUnitEditContext,
  type UnitEditContext,
  type UnitEditContextClient,
} from "@/lib/api/unit-edit-context";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { countActiveCenterMembersByCode } from "@/lib/api/center-member-count";
import type { EditSession } from "@/lib/auth/superuser";
import { logEditDenial } from "@/lib/edit/authz";
import {
  loadAllUnitsDirectory,
  loadAllUnitsForFinder,
  loadManageableUnits,
} from "@/lib/edit/manageable-units";

/**
 * Resolve "the" Cancer Center's unit `code` server-side instead of hardcoding
 * a literal — `?center=` addresses a second center once one exists.
 *
 * `Center` is not synonymous with "Cancer Center": the org chart carries
 * ~8-11 `kind: "center"` units (`loadAllUnitsForFinder`'s own doc comment),
 * most of them unrelated to this report suite. Filtering to `kind ===
 * "center"` alone and defaulting to the alphabetically-first one (a real bug,
 * caught 2026-08-12) picked whichever center's NAME sorted first — almost
 * never the actual Cancer Center — which then 404'd/empty-stated every report
 * that reads Cancer-Center-only data (NCI Table 2A's "No import cycle found
 * yet", the collab-report's empty roster, etc.).
 *
 * The correct scope is the SAME one every report's underlying data already
 * requires and the old per-center "Reports"/"NCI Table 2A" rail tabs were
 * always gated on: a center with a `CenterProgram` taxonomy (#552) — data-
 * driven, not a hardcoded center check, matching the posture documented
 * throughout `lib/edit/cancer-center-funding-generator.ts` and
 * `lib/center-collaboration/*`. `notFound()` — never a silent fallback — when
 * no center has a program taxonomy at all, or the requested code doesn't
 * resolve to one that does.
 */
export async function resolveReportsCenterCode(
  db: UnitEditContextClient,
  requested: string | undefined,
): Promise<string> {
  const [centers, programRows] = await Promise.all([
    loadAllUnitsForFinder(db).then((units) => units.filter((u) => u.kind === "center")),
    db.centerProgram.findMany({ select: { centerCode: true }, distinct: ["centerCode"] }),
  ]);
  const codesWithPrograms = new Set(programRows.map((p) => p.centerCode));
  const reportableCenters = centers.filter((c) => codesWithPrograms.has(c.code));
  const code = requested
    ? reportableCenters.find((c) => c.code === requested)?.code
    : reportableCenters[0]?.code;
  if (!code) notFound();
  return code;
}

/**
 * The SAME role gate `/edit/center/[code]` enforces — superuser, comms_steward
 * (global content-editor parity, comms-steward-profile-editing-spec.md §3b),
 * or a unit Owner/Curator of this center — reused wholesale via
 * `loadUnitEditContext` rather than re-derived, so the Reports console can
 * never drift from the per-unit editor's authz. `null` = denied (and logged);
 * the caller renders the same visible 403 the old `?attr=reports` /
 * `?attr=nci-2a` tabs sat behind.
 */
export async function loadReportsContext(
  code: string,
  session: EditSession,
  db: UnitEditContextClient,
): Promise<UnitEditContext | null> {
  const ctx = await loadUnitEditContext("center", code, session, db);
  if (ctx === null) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: code,
      path: "/edit/reports",
      reason: "not_curator",
      targetEntityType: "center",
      targetEntityId: code,
    });
  }
  return ctx;
}

/**
 * Center-code resolution for one of the five numbered report pages
 * (`/edit/reports/{1..5}`) — actor-scoped, unlike `resolveReportsCenterCode`'s
 * own default-pick (see `loadReportableUnitsForActor`'s doc comment for the
 * hazard). An explicit `?center=` still resolves the same way it always has
 * (validated against ANY reportable center org-wide, not just the actor's
 * own — `loadReportsContext` is the real per-actor gate, so this never needed
 * actor-scoping). Without one: exactly one reportable unit resolves straight
 * to it (today's existing behavior, unchanged); zero or more than one
 * redirects to the index (`/edit/reports`), the only surface that can show a
 * 404 or a picker correctly — a numbered report page has no picker of its
 * own to fall back on.
 */
export async function resolveNumberedReportCenterCode(
  session: EditSession,
  db: UnitEditContextClient & ReportsDirectoryClient,
  requested: string | undefined,
): Promise<string> {
  if (requested) return resolveReportsCenterCode(db, requested);
  const units = await loadReportableUnitsForActor(session, db);
  if (units.length === 1) return units[0].code;
  redirect("/edit/reports");
}

/** The narrow Prisma surface the reportable-units + liveness queries read. */
export type ReportsDirectoryClient = Pick<
  PrismaClient,
  | "department"
  | "division"
  | "center"
  | "suppression"
  | "scholar"
  | "centerMembership"
  | "unitAdmin"
  | "centerProgram"
  | "centerCollabCandidate"
  | "cancerCenterFundingAward"
>;

/** One unit in scope for the Reports index/nav — a center or institute with a
 *  CenterProgram taxonomy, the same data-driven gate `resolveReportsCenterCode`
 *  already applies to a single unit. */
export type ReportableUnit = {
  code: string;
  name: string;
  centerType: "center" | "institute";
};

/**
 * Every unit this actor's Reports index should show: org-wide for a
 * superuser/comms_steward (mirrors `loadAllUnitsDirectory`'s own audience),
 * scoped to the actor's own `UnitAdmin` grants otherwise (`loadManageableUnits`)
 * — the same actor-scoping `/edit/units` already draws between its "your
 * units" and "every unit" sections, just filtered down to units with a
 * `CenterProgram` taxonomy (2a/1a/3a, Reports IA redesign 2026-08-14).
 *
 * `resolveReportsCenterCode`'s own default-pick does NOT scope to the actor —
 * fine while exactly one center ever qualified, but once a second reportable
 * unit exists, a non-superuser Curator of unit A could silently default-
 * resolve to unit B (then 403 from `loadReportsContext` instead of landing on
 * their own unit). The index page uses this function first to decide whether
 * that single-unit shortcut even applies before falling through to it.
 *
 * Retirement mirrors `loadUnitEditContext`'s own retired-unit gate exactly —
 * superuser-only bypass, comms_steward included in the exclusion (caught in
 * review): the `isGlobal`/`loadAllUnitsDirectory` branch passes
 * `includeRetired: session.isSuperuser`, not `isGlobal`, so a comms_steward
 * never sees a retired unit here even though they take the "global" path.
 * `loadManageableUnits` (the per-grant branch) has no retirement filter of
 * its own, so that branch runs one more batched `suppression` query — without
 * it, a non-superuser Curator would see a retired unit's live report counts
 * in the index and then 403 on every link into it (dead-end + a metadata leak
 * `loadUnitEditContext` is specifically designed to prevent).
 */
export async function loadReportableUnitsForActor(
  session: EditSession,
  db: ReportsDirectoryClient,
): Promise<ReportableUnit[]> {
  const isGlobal = session.isSuperuser || session.isCommsSteward;
  const candidates: Array<{ code: string; name: string; centerType: "center" | "institute" | null }> =
    isGlobal
      ? (await loadAllUnitsDirectory(db, { includeRetired: session.isSuperuser }))
          .filter((u) => u.kind === "center")
          .map((u) => ({ code: u.code, name: u.name, centerType: u.centerType }))
      : (await loadManageableUnits(session.cwid, db)).centers.map((u) => ({
          code: u.code,
          name: u.name,
          centerType: null,
        }));

  if (candidates.length === 0) return [];

  const codes = candidates.map((c) => c.code);
  const [programRows, centerTypeRows, retiredCodes] = await Promise.all([
    db.centerProgram.findMany({
      where: { centerCode: { in: codes } },
      select: { centerCode: true },
      distinct: ["centerCode"],
    }),
    // `loadManageableUnits`'s thin shape carries no `centerType` — only fetch it
    // when we didn't already get it for free from `loadAllUnitsDirectory`.
    isGlobal
      ? Promise.resolve(null)
      : db.center.findMany({ where: { code: { in: codes } }, select: { code: true, centerType: true } }),
    // Only the per-grant branch needs this — `loadAllUnitsDirectory` above
    // already excluded retired units at the source for everyone but a
    // superuser.
    isGlobal
      ? Promise.resolve(null)
      : db.suppression.findMany({
          where: { entityType: "center", entityId: { in: codes }, revokedAt: null },
          select: { entityId: true },
        }),
  ]);

  const codesWithPrograms = new Set(programRows.map((p) => p.centerCode));
  const centerTypeByCode = centerTypeRows
    ? new Map(
        centerTypeRows.map((r) => [r.code, r.centerType === "institute" ? ("institute" as const) : ("center" as const)]),
      )
    : null;
  const retiredSet = retiredCodes ? new Set(retiredCodes.map((r) => r.entityId)) : null;

  return candidates
    .filter((c) => codesWithPrograms.has(c.code))
    .filter((c) => !retiredSet?.has(c.code))
    .map((c) => ({
      code: c.code,
      name: c.name,
      centerType: centerTypeByCode ? (centerTypeByCode.get(c.code) ?? "center") : (c.centerType ?? "center"),
    }));
}

/** Fixed report catalog size (Reports IA redesign 2026-08-14, Decision 4) — the
 *  five numbered reports at `/edit/reports/{1..5}`, same list for every unit;
 *  "live" varies per unit, the catalog itself does not. */
export const REPORT_CATALOG_SIZE = 5;

/** Per-unit liveness, both aggregated (2a/1a's "N of 5"/"Last refreshed"
 *  columns) and per-report (1a's inline band rows, each report showing its
 *  own live/refreshed state). */
export type ReportLiveness = {
  perReport: ReadonlyArray<{ n: 1 | 2 | 3 | 4 | 5; live: boolean; lastRefreshedAt: Date | null }>;
  liveCount: number;
  totalCount: number;
  lastRefreshedAt: Date | null;
};

/**
 * Batched liveness for a set of center codes — one groupBy per signal, never
 * N+1. "Live" means real data exists, not just that the route works (reports
 * 3-5 all run real queries today; the catalog used to call them "coming soon",
 * which was stale — see `app/edit/reports/page.tsx`).
 *
 * Reports 1 (`CenterCollabCandidate`) and 2 (`CancerCenterFundingAward`) each
 * have their own table keyed by `centerCode`, so their liveness is an exact
 * row-count. Reports 3-5 (Publications / Grants / Clinical Trials) are all
 * derived live-on-read from a center's active members, with no dedicated
 * table of their own to count.
 *
 * ponytail: reports 3-5's liveness is proxied by "this unit has ≥1 active
 * member" (`countActiveCenterMembersByCode` — the same canonical active-
 * member definition `AllUnitsDirectory`'s scholar counts use, joined through
 * `Scholar.deletedAt`/`status`, not a raw `CenterMembership` date-range check)
 * rather than re-running each report's own member→publication/grant/trial
 * join for every unit in the index (that would be 3 more derived, per-unit-
 * expensive queries). A unit with active members but zero indexed
 * publications/grants/trials over-counts as "live" here — false positive, not
 * false negative. Upgrade path: once any one of those three reports gets its
 * own batched cross-unit aggregation (mirroring this function's shape), swap
 * its proxy bit for the real count.
 */
export async function loadReportLiveness(
  codes: string[],
  db: ReportsDirectoryClient,
): Promise<Map<string, ReportLiveness>> {
  const result = new Map<string, ReportLiveness>();
  if (codes.length === 0) return result;

  const [collabRows, fundingRows, activeMembersByCode] = await Promise.all([
    db.centerCollabCandidate.groupBy({
      by: ["centerCode"],
      where: { centerCode: { in: codes } },
      _count: { _all: true },
      _max: { lastRefreshedAt: true },
    }),
    db.cancerCenterFundingAward.groupBy({
      by: ["centerCode"],
      where: { centerCode: { in: codes } },
      _count: { _all: true },
      _max: { lastRefreshedAt: true },
    }),
    countActiveCenterMembersByCode(db, codes),
  ]);

  const collabByCode = new Map(collabRows.map((r) => [r.centerCode, r]));
  const fundingByCode = new Map(fundingRows.map((r) => [r.centerCode, r]));

  for (const code of codes) {
    const collab = collabByCode.get(code);
    const funding = fundingByCode.get(code);
    const hasActiveMembers = (activeMembersByCode.get(code) ?? 0) > 0;

    const perReport: ReportLiveness["perReport"] = [
      { n: 1, live: (collab?._count._all ?? 0) > 0, lastRefreshedAt: collab?._max.lastRefreshedAt ?? null },
      { n: 2, live: (funding?._count._all ?? 0) > 0, lastRefreshedAt: funding?._max.lastRefreshedAt ?? null },
      { n: 3, live: hasActiveMembers, lastRefreshedAt: null },
      { n: 4, live: hasActiveMembers, lastRefreshedAt: null },
      { n: 5, live: hasActiveMembers, lastRefreshedAt: null },
    ];

    const lastRefreshedAt =
      perReport
        .map((r) => r.lastRefreshedAt)
        .filter((d): d is Date => d != null)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    result.set(code, {
      perReport,
      liveCount: perReport.filter((r) => r.live).length,
      totalCount: REPORT_CATALOG_SIZE,
      lastRefreshedAt,
    });
  }

  return result;
}
