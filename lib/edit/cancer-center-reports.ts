/**
 * Shared server-side plumbing for the `/edit/reports/*` console — the
 * top-level home for what used to be the `?attr=reports` / `?attr=nci-2a`
 * tabs buried inside `/edit/center/[code]` (unit-curation-edit-ui-spec.md).
 * Both the unit-code resolution and the authorization gate live here so the
 * index page and its six numbered report pages can't drift from each other,
 * or from the per-unit editor surface they're replacing.
 *
 * Center-only through 2026-08-14. The org-unit publications reports plan
 * (2026-08-16) widened reports 3 (Publications) and 6 (NIH-funded pubs) to
 * also serve department/division units — see `REPORT_NUMBERS_BY_KIND` below
 * for which numbered reports apply to which kind, and `loadReportsContext`'s
 * doc comment for the authz thread-through. Reports 1/2/4/5 stay center-only.
 */
import { notFound, redirect } from "next/navigation";

import {
  loadUnitEditContext,
  type UnitEditContext,
  type UnitEditContextClient,
} from "@/lib/api/unit-edit-context";
import type { UnitEntityType } from "@/lib/api/manual-layer";
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
  // `loadAllUnitsForFinder` below reads `db.core` too now that cores are a
  // fourth `ManageableUnitKind` (cores-as-org-units P5) — intersected locally
  // rather than widening `UnitEditContextClient` itself (out of scope here).
  db: UnitEditContextClient & Pick<PrismaClient, "core">,
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
 * The SAME role gate `/edit/center/[code]` (or `/edit/department/[code]` /
 * `/edit/division/[code]`) enforces — superuser, comms_steward (global
 * content-editor parity, comms-steward-profile-editing-spec.md §3b), or a
 * unit Owner/Curator of this unit — reused wholesale via `loadUnitEditContext`
 * rather than re-derived, so the Reports console can never drift from the
 * per-unit editor's authz. `null` = denied (and logged); the caller renders
 * the same visible 403 the old `?attr=reports` / `?attr=nci-2a` tabs sat
 * behind.
 *
 * `kind` defaults to `"center"` — org-unit publications reports plan
 * (2026-08-16): reports 1/2/4/5 never pass it (center-only, unchanged), so
 * every existing call site keeps resolving exactly as it always has. Reports
 * 3 and 6 (department/division-eligible) pass the resolved kind through.
 */
export async function loadReportsContext(
  code: string,
  session: EditSession,
  db: UnitEditContextClient,
  kind: UnitEntityType = "center",
): Promise<UnitEditContext | null> {
  const ctx = await loadUnitEditContext(kind, code, session, db);
  if (ctx === null) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: code,
      path: "/edit/reports",
      reason: "not_curator",
      targetEntityType: kind,
      targetEntityId: code,
    });
  }
  return ctx;
}

/**
 * Unit resolution for one of the six numbered report pages
 * (`/edit/reports/{1..6}`) — actor-scoped, unlike `resolveReportsCenterCode`'s
 * own default-pick (see `loadReportableUnitsForActor`'s doc comment for the
 * hazard). An explicit `?center=` still resolves the same way it always has
 * (validated against ANY reportable unit org-wide, not just the actor's
 * own — `loadReportsContext` is the real per-actor gate, so this never needed
 * actor-scoping). Without one: exactly one reportable unit resolves straight
 * to it (today's existing behavior, unchanged); zero or more than one
 * redirects to the index (`/edit/reports`), the only surface that can show a
 * 404 or a picker correctly — a numbered report page has no picker of its
 * own to fall back on.
 *
 * `opts.allowedKinds` (org-unit publications reports plan, 2026-08-16)
 * defaults to `["center"]` — reports 1/2/4/5 call with no third argument at
 * all, so their resolution is byte-for-byte unchanged. Reports 3 and 6 (the
 * department/division-eligible pair) pass the widened set. `opts.requestedKind`
 * only matters alongside an explicit `requested` code that ISN'T a center —
 * `?center=<code>&kind=department` — since a department/division code has no
 * `resolveReportsCenterCode`-style taxonomy gate to validate against (no
 * `CenterProgram` equivalent exists for those kinds); `loadReportsContext`
 * downstream is what actually 403s/renders-not-found for a bad one.
 */
export async function resolveNumberedReportCenterCode(
  session: EditSession,
  db: UnitEditContextClient & ReportsDirectoryClient,
  requested: string | undefined,
  opts: { allowedKinds?: readonly UnitEntityType[]; requestedKind?: UnitEntityType } = {},
): Promise<{ code: string; kind: UnitEntityType }> {
  const allowedKinds = opts.allowedKinds ?? ["center"];
  if (requested) {
    const kind = opts.requestedKind ?? "center";
    if (kind === "center") return { code: await resolveReportsCenterCode(db, requested), kind: "center" };
    return { code: requested, kind };
  }
  const units = await loadReportableUnitsForActor(session, db, allowedKinds);
  if (units.length === 1) return { code: units[0].code, kind: units[0].kind };
  redirect("/edit/reports");
}

/** The narrow Prisma surface the reportable-units + liveness queries read. */
export type ReportsDirectoryClient = Pick<
  PrismaClient,
  | "department"
  | "division"
  | "center"
  | "core"
  | "suppression"
  | "scholar"
  | "centerMembership"
  | "unitAdmin"
  | "centerProgram"
  | "centerCollabCandidate"
  | "cancerCenterFundingAward"

  | "orgUnitRoleAssignment"
>;

/** One unit in scope for the Reports index/nav. A `center` must carry a
 *  CenterProgram taxonomy, the same data-driven gate `resolveReportsCenterCode`
 *  already applies to a single unit — `department`/`division` have no such
 *  taxonomy to gate on (org-unit publications reports plan, 2026-08-16):
 *  reports 3/6 degrade gracefully to an empty state for a unit with no
 *  members/publications rather than erroring, so any unit the actor can
 *  administer is reportable. `centerType` is only meaningful when
 *  `kind === "center"`; null otherwise. */
export type ReportableUnit = {
  code: string;
  kind: UnitEntityType;
  name: string;
  centerType: "center" | "institute" | null;
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
 *
 * `allowedKinds` (org-unit publications reports plan, 2026-08-16) defaults to
 * `["center"]`, so every existing caller (`loadConsoleGrants`, reports 1/2/4/5)
 * keeps its exact prior behavior with no call-site change. Reports 3/6 and the
 * index page pass the widened `["center", "department", "division"]` set — a
 * department/division candidate skips the CenterProgram/retirement-suppression
 * machinery below entirely (there's no equivalent taxonomy, and `loadManageableUnits`
 * already excludes a grant whose unit row is gone) and passes straight through.
 */
export async function loadReportableUnitsForActor(
  session: EditSession,
  db: ReportsDirectoryClient,
  allowedKinds: readonly UnitEntityType[] = ["center"],
): Promise<ReportableUnit[]> {
  const isGlobal = session.isSuperuser || session.isCommsSteward;
  const wantsKind = (k: UnitEntityType) => allowedKinds.includes(k);

  type Candidate = { code: string; kind: UnitEntityType; name: string; centerType: "center" | "institute" | null };
  let candidates: Candidate[];
  if (isGlobal) {
    const all = await loadAllUnitsDirectory(db, { includeRetired: session.isSuperuser });
    // `core` is a `ManageableUnitKind` but not a `UnitEntityType` (cores-as-
    // org-units is out of scope for this report suite) — excluded via this
    // type predicate so `u.kind` narrows to `UnitEntityType` with no cast.
    const isReportableKind = (u: (typeof all)[number]): u is (typeof all)[number] & { kind: UnitEntityType } =>
      u.kind !== "core" && wantsKind(u.kind);
    candidates = all.filter(isReportableKind).map((u) => ({
      code: u.code,
      kind: u.kind,
      name: u.name,
      centerType: u.kind === "center" ? u.centerType : null,
    }));
  } else {
    const manageable = await loadManageableUnits(session.cwid, db);
    candidates = [
      ...(wantsKind("center")
        ? manageable.centers.map((u) => ({ code: u.code, kind: "center" as const, name: u.name, centerType: null }))
        : []),
      ...(wantsKind("department")
        ? manageable.departments.map((u) => ({
            code: u.code,
            kind: "department" as const,
            name: u.name,
            centerType: null,
          }))
        : []),
      ...(wantsKind("division")
        ? manageable.divisions.map((u) => ({ code: u.code, kind: "division" as const, name: u.name, centerType: null }))
        : []),
    ];
  }

  if (candidates.length === 0) return [];

  const centerCodes = candidates.filter((c) => c.kind === "center").map((c) => c.code);
  // Suppression covers every kind (a department/division can be retired too),
  // so the retirement check below runs across ALL non-superuser candidates,
  // not just centers — only the CenterProgram taxonomy gate is center-only.
  const allCandidateCodes = candidates.map((c) => c.code);

  const [programRows, centerTypeRows, retiredCodes] = await Promise.all([
    centerCodes.length > 0
      ? db.centerProgram.findMany({
          where: { centerCode: { in: centerCodes } },
          select: { centerCode: true },
          distinct: ["centerCode"],
        })
      : Promise.resolve([]),
    // `loadManageableUnits`'s thin shape carries no `centerType` — only fetch it
    // when we didn't already get it for free from `loadAllUnitsDirectory`.
    !isGlobal && centerCodes.length > 0
      ? db.center.findMany({ where: { code: { in: centerCodes } }, select: { code: true, centerType: true } })
      : Promise.resolve(null),
    // Only the per-grant branch needs this — `loadAllUnitsDirectory` above
    // already excluded retired units at the source for everyone but a
    // superuser.
    isGlobal
      ? Promise.resolve(null)
      : db.suppression.findMany({
          where: { entityType: { in: [...allowedKinds] }, entityId: { in: allCandidateCodes }, revokedAt: null },
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
    // Center: gated on the CenterProgram taxonomy, unchanged. Department/
    // division: no equivalent gate — pass straight through.
    .filter((c) => c.kind !== "center" || codesWithPrograms.has(c.code))
    .filter((c) => !retiredSet?.has(c.code))
    .map((c) => ({
      code: c.code,
      kind: c.kind,
      name: c.name,
      centerType:
        c.kind !== "center" ? null : centerTypeByCode ? (centerTypeByCode.get(c.code) ?? "center") : (c.centerType ?? "center"),
    }));
}

export type ReportNumber = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Which numbered reports apply to a unit of this kind — the single source of
 * truth `loadReportLiveness` and `app/edit/reports/page.tsx`'s catalog both
 * key off, so a unit never shows a report card it can't produce output for
 * (org-unit publications reports plan, 2026-08-16, "Report catalog by kind").
 * `center` gets the full six; `department`/`division` get only the two
 * kind-generic ones (3 Publications, 6 NIH-funded pubs) — reports 1/2/4/5 read
 * `CenterProgram`/`CenterMembership`-family tables with no department/division
 * equivalent (see the plan's "Reports 1 & 2 — considered, dropped").
 */
export const REPORT_NUMBERS_BY_KIND: Record<UnitEntityType, readonly ReportNumber[]> = {
  center: [1, 2, 3, 4, 5, 6],
  department: [3, 6],
  division: [3, 6],
};

/** Size of the full (center) report catalog — six numbered reports. Kept as a
 *  named export since `app/edit/reports/page.tsx` still needs a default
 *  `totalCount` fallback; department/division totals are 2, not this. */
export const REPORT_CATALOG_SIZE = REPORT_NUMBERS_BY_KIND.center.length;

/** Per-unit liveness, both aggregated (2a/1a's "N of M"/"Last refreshed"
 *  columns) and per-report (1a's inline band rows, each report showing its
 *  own live/refreshed state). `perReport` only carries the entries
 *  `REPORT_NUMBERS_BY_KIND[kind]` lists — a department's `perReport` has
 *  exactly 2 entries (3, 6), never a padded-out 6 with 4 fake "not live"
 *  rows for reports it can never produce. */
export type ReportLiveness = {
  perReport: ReadonlyArray<{ n: ReportNumber; live: boolean; lastRefreshedAt: Date | null }>;
  liveCount: number;
  totalCount: number;
  lastRefreshedAt: Date | null;
};

/** Batched "has ≥1 active member" flag for department/division codes — the
 *  same proxy `loadReportLiveness` already uses for a center's reports 3-5,
 *  extended to the two kinds that have no `CenterMembership`-style table of
 *  their own. Mirrors `lib/api/data-quality.ts`'s own `scholar.groupBy(by:
 *  ["deptCode"|"divCode"])` batched-count pattern. A department's membership
 *  is `Scholar.deptCode` outright (no manual-roster union to consider); a
 *  division's is approximated the same way — this UNDER-counts a division
 *  whose roster comes ONLY from a manual `DivisionMembership` row with no
 *  matching LDAP `divCode` (unlike `loadDivisionMemberCwids`'s real report-3/6
 *  membership resolution, which does union both). Acceptable for a liveness
 *  PROXY (false negative here just means the badge under-promises; the report
 *  page itself still resolves membership correctly) — not acceptable if this
 *  ever became the real report data. */
async function loadNonCenterActiveMemberFlags(
  db: ReportsDirectoryClient,
  units: ReadonlyArray<{ code: string; kind: UnitEntityType }>,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const deptCodes = units.filter((u) => u.kind === "department").map((u) => u.code);
  const divCodes = units.filter((u) => u.kind === "division").map((u) => u.code);
  if (deptCodes.length === 0 && divCodes.length === 0) return result;

  const [deptGroups, divGroups] = await Promise.all([
    deptCodes.length > 0
      ? db.scholar.groupBy({
          by: ["deptCode"],
          where: { deptCode: { in: deptCodes }, deletedAt: null, status: "active" },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    divCodes.length > 0
      ? db.scholar.groupBy({
          by: ["divCode"],
          where: { divCode: { in: divCodes }, deletedAt: null, status: "active" },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);
  for (const g of deptGroups) if (g.deptCode) result.set(g.deptCode, (g._count?._all ?? 0) > 0);
  for (const g of divGroups) if (g.divCode) result.set(g.divCode, (g._count?._all ?? 0) > 0);
  return result;
}

/**
 * Batched liveness for a set of units — one groupBy per signal, never N+1.
 * "Live" means real data exists, not just that the route works (reports 3-6
 * all run real queries today; the catalog used to call them "coming soon",
 * which was stale — see `app/edit/reports/page.tsx`).
 *
 * Reports 1 (`CenterCollabCandidate`) and 2 (`CancerCenterFundingAward`) each
 * have their own table keyed by `centerCode`, so their liveness is an exact
 * row-count — center units only, per `REPORT_NUMBERS_BY_KIND`. Reports 3-6
 * (Publications / Grants / Clinical Trials / NIH-funded pubs) are all derived
 * live-on-read from a unit's active members, with no dedicated table of their
 * own to count.
 *
 * ponytail: reports 3-6's liveness is proxied by "this unit has ≥1 active
 * member" (`countActiveCenterMembersByCode` for centers — the same canonical
 * active-member definition `AllUnitsDirectory`'s scholar counts use, joined
 * through `Scholar.deletedAt`/`status`, not a raw `CenterMembership`
 * date-range check; `loadNonCenterActiveMemberFlags` for department/division)
 * rather than re-running each report's own member→publication/grant/trial
 * join for every unit in the index (that would be 4 more derived, per-unit-
 * expensive queries). A unit with active members but zero indexed
 * publications/grants/trials/NIH-links over-counts as "live" here — false
 * positive, not false negative. Upgrade path: once any one of those reports
 * gets its own batched cross-unit aggregation (mirroring this function's
 * shape), swap its proxy bit for the real count.
 */
export async function loadReportLiveness(
  units: ReadonlyArray<{ code: string; kind: UnitEntityType }>,
  db: ReportsDirectoryClient,
): Promise<Map<string, ReportLiveness>> {
  const result = new Map<string, ReportLiveness>();
  if (units.length === 0) return result;

  const centerCodes = units.filter((u) => u.kind === "center").map((u) => u.code);
  const [collabRows, fundingRows, activeCenterMembersByCode, nonCenterHasActiveMembers] = await Promise.all([
    centerCodes.length > 0
      ? db.centerCollabCandidate.groupBy({
          by: ["centerCode"],
          where: { centerCode: { in: centerCodes } },
          _count: { _all: true },
          _max: { lastRefreshedAt: true },
        })
      : Promise.resolve([]),
    centerCodes.length > 0
      ? db.cancerCenterFundingAward.groupBy({
          by: ["centerCode"],
          where: { centerCode: { in: centerCodes } },
          _count: { _all: true },
          _max: { lastRefreshedAt: true },
        })
      : Promise.resolve([]),
    centerCodes.length > 0 ? countActiveCenterMembersByCode(db, centerCodes) : Promise.resolve(new Map<string, number>()),
    loadNonCenterActiveMemberFlags(db, units),
  ]);

  const collabByCode = new Map(collabRows.map((r) => [r.centerCode, r]));
  const fundingByCode = new Map(fundingRows.map((r) => [r.centerCode, r]));

  for (const unit of units) {
    const { code, kind } = unit;
    const numbers = REPORT_NUMBERS_BY_KIND[kind];
    const hasActiveMembers =
      kind === "center" ? (activeCenterMembersByCode.get(code) ?? 0) > 0 : (nonCenterHasActiveMembers.get(code) ?? false);
    const collab = kind === "center" ? collabByCode.get(code) : undefined;
    const funding = kind === "center" ? fundingByCode.get(code) : undefined;

    const perReport: ReportLiveness["perReport"] = numbers.map((n) => {
      if (n === 1) return { n, live: (collab?._count._all ?? 0) > 0, lastRefreshedAt: collab?._max.lastRefreshedAt ?? null };
      if (n === 2) return { n, live: (funding?._count._all ?? 0) > 0, lastRefreshedAt: funding?._max.lastRefreshedAt ?? null };
      // 3, 4, 5, 6 — all proxied by active-membership existence.
      return { n, live: hasActiveMembers, lastRefreshedAt: null };
    });

    const lastRefreshedAt =
      perReport
        .map((r) => r.lastRefreshedAt)
        .filter((d): d is Date => d != null)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    result.set(code, {
      perReport,
      liveCount: perReport.filter((r) => r.live).length,
      totalCount: numbers.length,
      lastRefreshedAt,
    });
  }

  return result;
}
