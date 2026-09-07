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
 * also serve department/division units, and the core-reports widening
 * (2026-09-06) added CORE facilities as a fourth reportable kind — see
 * `REPORT_NUMBERS_BY_KIND` below for which numbered reports apply to which
 * kind, `ReportableUnitKind` for why the widening is scoped to this suite
 * rather than to `UnitEntityType`, and `loadReportsContext`'s doc comment for
 * the authz thread-through. Reports 1/2/4/5 stay center-only.
 */
import { notFound, redirect } from "next/navigation";

import {
  loadUnitEditContext,
  type UnitEditContextClient,
} from "@/lib/api/unit-edit-context";
import type { UnitEntityType } from "@/lib/api/manual-layer";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { countActiveCenterMembersByCode } from "@/lib/api/center-member-count";
import { loadConfirmedCorePmidsByCore } from "@/lib/api/cores";
import type { EditSession } from "@/lib/auth/superuser";
import {
  authorizeCoreClaim,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";
import {
  loadAllUnitsDirectory,
  loadAllUnitsForFinder,
  loadManageableUnits,
} from "@/lib/edit/manageable-units";

/**
 * The unit kinds the `/edit/reports/*` suite can report on — the three classic
 * org units plus `core`.
 *
 * DELIBERATELY scoped to this suite rather than widening `UnitEntityType`
 * itself. `UnitEntityType` is the three kinds the MANUAL LAYER covers
 * (`lib/api/manual-layer.ts`), and every consumer of it treats a core
 * differently on purpose:
 *   - `loadUnitEditContext` (`lib/api/unit-edit-context.ts`) branches
 *     `department` / `division` / `else`, so a widened `UnitEntityType` would
 *     make `loadUnitEditContext("core", …)` silently read the CENTER table
 *     keyed by a core id — a wrong-table read that type-checks and returns a
 *     null the caller reports as 404/403, with no compile error anywhere.
 *   - `loadUnitFieldOverrides` / `isUnitSuppressed` (`manual-layer.ts`) would
 *     start accepting `entityType: "core"` for `field_override` /
 *     `suppression` rows, neither of which a core ever carries (`Suppression`
 *     excludes cores BY DESIGN — see `loadAllUnitsDirectory`).
 * A core's authz, name lookup, and publication set all resolve through core-
 * specific machinery instead (`getCoreOwnerRole` / `authorizeCoreClaim` /
 * `loadConfirmedCorePmidsByCore`), so the union stays local to the reports
 * modules that actually branch on it.
 */
export type ReportableUnitKind = UnitEntityType | "core";

/** `ReportableUnitKind` minus `core` — the kinds that ARE `UnitEntityType`s,
 *  i.e. the ones the manual-layer/`Suppression`/`loadUnitEditContext` paths
 *  accept. Narrowing helper so those call sites need no cast. */
function isUnitEntityType(kind: ReportableUnitKind): kind is UnitEntityType {
  return kind !== "core";
}

/**
 * What every `/edit/reports/*` page actually consumes from its authz load: the
 * unit's display name. A center/department/division resolves it through the
 * full `loadUnitEditContext` (which `UnitEditContext` structurally satisfies);
 * a core has no `UnitEditContext` equivalent and never will — cores carry no
 * `field_override`, no `Suppression`, no roster, and a leaders LIST rather than
 * a single leader column. Typing the reports gate on what it needs rather than
 * on the center editor's context is what lets both resolve through one
 * function without a fake core "unit context".
 */
export type ReportsContext = { unit: { name: string } };

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
 * 3 and 6 (department/division/core-eligible) pass the resolved kind through.
 *
 * `kind === "core"` takes the core branch below instead: cores have no
 * `UnitEditContext` and no dept→division cascade, so the gate is the SAME pair
 * `/edit/core/[coreId]/review` already enforces — `getCoreOwnerRole` +
 * `authorizeCoreClaim` (superuser / comms_steward / this core's Owner or
 * Curator, 2026-08-26 policy widening decision #6) — reused wholesale rather
 * than re-derived, so a core's Reports access can never drift from its review
 * queue's. Nobody else passes: a grant on a DIFFERENT core, or on any
 * department/division/center, confers nothing here.
 */
export async function loadReportsContext(
  code: string,
  session: EditSession,
  db: UnitEditContextClient & Pick<PrismaClient, "core">,
  kind: ReportableUnitKind = "center",
): Promise<ReportsContext | null> {
  const ctx = isUnitEntityType(kind)
    ? await loadUnitEditContext(kind, code, session, db)
    : await loadCoreReportsContext(code, session, db);
  if (ctx === null) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: code,
      path: "/edit/reports",
      reason: kind === "core" ? "not_core_owner" : "not_curator",
      targetEntityType: kind,
      targetEntityId: code,
    });
  }
  return ctx;
}

/**
 * The `kind === "core"` half of `loadReportsContext`. `null` for a denied
 * actor OR an unknown core id — the same conflation `loadUnitEditContext`
 * already makes for the other three kinds (both render the reports console's
 * visible 403), deliberately NOT the 404/403 split `/edit/core/[coreId]/review`
 * draws: this suite has one code path for a code it cannot resolve, and
 * splitting it here for cores alone would leak "this core id exists" to an
 * actor with no grant on it.
 */
async function loadCoreReportsContext(
  coreId: string,
  session: EditSession,
  db: Pick<PrismaClient, "unitAdmin" | "core">,
): Promise<ReportsContext | null> {
  const coreRole = await getCoreOwnerRole(session, coreId, db as unknown as CoreOwnerLookup);
  if (!authorizeCoreClaim(session, coreRole).ok) return null;
  const core = await db.core.findUnique({ where: { id: coreId }, select: { name: true } });
  return core ? { unit: { name: core.name } } : null;
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
 * department/division/core-eligible set) pass the widened set.
 * `opts.requestedKind` only matters alongside an explicit `requested` code
 * that ISN'T a center — `?center=<code>&kind=department|division|core` — since
 * those kinds have no `resolveReportsCenterCode`-style taxonomy gate to
 * validate against (no `CenterProgram` equivalent exists for them);
 * `loadReportsContext` downstream is what actually 403s/renders-not-found for
 * a bad one, cores included.
 */
export async function resolveNumberedReportCenterCode(
  session: EditSession,
  db: UnitEditContextClient & ReportsDirectoryClient,
  requested: string | undefined,
  opts: { allowedKinds?: readonly ReportableUnitKind[]; requestedKind?: ReportableUnitKind } = {},
): Promise<{ code: string; kind: ReportableUnitKind }> {
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
  // Core liveness (reports 3/6 for a `core` unit) — the two tables
  // `loadConfirmedCorePmidsByCore` reads.
  | "publicationCore"
  | "coreClaim"
  | "orgUnitRoleAssignment"
>;

/** One unit in scope for the Reports index/nav. A `center` must carry a
 *  CenterProgram taxonomy, the same data-driven gate `resolveReportsCenterCode`
 *  already applies to a single unit — `department`/`division`/`core` have no
 *  such taxonomy to gate on (org-unit publications reports plan, 2026-08-16;
 *  core-reports widening, 2026-09-06): reports 3/6 degrade gracefully to an
 *  empty state for a unit with no members/publications rather than erroring,
 *  so any unit the actor can administer is reportable. `centerType` is only
 *  meaningful when `kind === "center"`; null otherwise. */
export type ReportableUnit = {
  code: string;
  kind: ReportableUnitKind;
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
 * `["center"]`, so every existing caller (reports 1/2/4/5) keeps its exact
 * prior behavior with no call-site change. Reports 3/6, `loadConsoleGrants`
 * and the index page pass the widened
 * `["center", "department", "division", "core"]` set — a
 * department/division/core candidate skips the CenterProgram/retirement-
 * suppression machinery below entirely (there's no equivalent taxonomy, and
 * `loadManageableUnits` already excludes a grant whose unit row is gone) and
 * passes straight through.
 *
 * Cores (core-reports widening, 2026-09-06) ride BOTH branches: the global one
 * through `loadAllUnitsDirectory` (which has enumerated cores since
 * cores-as-org-units P5), the actor-scoped one through the `cores` group
 * `loadManageableUnits` already returns from the actor's
 * `UnitAdmin(entityType="core")` grants. Note that 13 of the 14 catalog cores
 * carry ZERO `unit_admin` rows today (staging probe, 2026-09-06: only core 14
 * has any, 4 rows), so for almost every core the actor-scoped branch is empty
 * until an owner/curator grant exists — expected, not a bug; the index renders
 * its normal "no reportable units" path.
 */
export async function loadReportableUnitsForActor(
  session: EditSession,
  db: ReportsDirectoryClient,
  allowedKinds: readonly ReportableUnitKind[] = ["center"],
): Promise<ReportableUnit[]> {
  const isGlobal = session.isSuperuser || session.isCommsSteward;
  const wantsKind = (k: ReportableUnitKind) => allowedKinds.includes(k);

  type Candidate = {
    code: string;
    kind: ReportableUnitKind;
    name: string;
    centerType: "center" | "institute" | null;
  };
  let candidates: Candidate[];
  if (isGlobal) {
    const all = await loadAllUnitsDirectory(db, { includeRetired: session.isSuperuser });
    // `ManageableUnitKind` and `ReportableUnitKind` are the same four values,
    // so no narrowing predicate is needed any more — `allowedKinds` alone
    // decides, and a caller that omits `core` still gets exactly what it did
    // before this widening.
    candidates = all
      .filter((u) => wantsKind(u.kind))
      .map((u) => ({
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
      // The actor's own `UnitAdmin(entityType="core")` grants — owner OR
      // curator, exactly what `loadManageableUnits` already deduped and
      // name-resolved. A core whose catalog row is gone is dropped there.
      ...(wantsKind("core")
        ? manageable.cores.map((u) => ({ code: u.code, kind: "core" as const, name: u.name, centerType: null }))
        : []),
    ];
  }

  if (candidates.length === 0) return [];

  const centerCodes = candidates.filter((c) => c.kind === "center").map((c) => c.code);
  // Suppression covers every kind EXCEPT core (a department/division can be
  // retired too; `Suppression` excludes `entityType="core"` by design —
  // `core-as-org-unit-plan.md`, see `loadAllUnitsDirectory`), so the retirement
  // check below runs across all non-superuser, non-core candidates. Only the
  // CenterProgram taxonomy gate is center-only.
  const suppressibleKinds = allowedKinds.filter(isUnitEntityType);
  const allCandidateCodes = candidates.filter((c) => c.kind !== "core").map((c) => c.code);

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
    isGlobal || allCandidateCodes.length === 0
      ? Promise.resolve(null)
      : db.suppression.findMany({
          where: {
            entityType: { in: suppressibleKinds },
            entityId: { in: allCandidateCodes },
            revokedAt: null,
          },
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
 * `center` gets the full six; `department`/`division`/`core` get only the two
 * kind-generic ones (3 Publications, 6 NIH-funded pubs) — reports 1/2/4/5 read
 * `CenterProgram`/`CenterMembership`-family tables with no department/division/
 * core equivalent (see the plan's "Reports 1 & 2 — considered, dropped").
 * `core` follows the department/division precedent exactly (core-reports
 * widening, 2026-09-06); its reports 3/6 resolve their publication set from
 * confirmed `publication_core` usages rather than from members, since a core
 * has no membership table at all.
 */
export const REPORT_NUMBERS_BY_KIND: Record<ReportableUnitKind, readonly ReportNumber[]> = {
  center: [1, 2, 3, 4, 5, 6],
  department: [3, 6],
  division: [3, 6],
  core: [3, 6],
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
  units: ReadonlyArray<{ code: string; kind: ReportableUnitKind }>,
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
 *
 * A `core` is the one kind that does NOT take that proxy: it has no
 * membership table, so the member proxy would read false for every core.
 * `loadConfirmedCorePmidsByCore` gives the real, already-batched confirmed-
 * usage set instead — the exact thing reports 3/6 read for a core — which
 * makes core liveness exact rather than approximate in both directions.
 */
export async function loadReportLiveness(
  units: ReadonlyArray<{ code: string; kind: ReportableUnitKind }>,
  db: ReportsDirectoryClient,
): Promise<Map<string, ReportLiveness>> {
  const result = new Map<string, ReportLiveness>();
  if (units.length === 0) return result;

  const centerCodes = units.filter((u) => u.kind === "center").map((u) => u.code);
  const coreIds = units.filter((u) => u.kind === "core").map((u) => u.code);
  const [collabRows, fundingRows, activeCenterMembersByCode, nonCenterHasActiveMembers, confirmedPmidsByCore] =
    await Promise.all([
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
      centerCodes.length > 0
        ? countActiveCenterMembersByCode(db, centerCodes)
        : Promise.resolve(new Map<string, number>()),
      loadNonCenterActiveMemberFlags(db, units),
      // A core's reports 3/6 read confirmed `publication_core` usages, not
      // members, so its liveness is the EXACT presence of that set rather than
      // the active-member proxy the other three kinds use — the same two
      // batched queries the report page runs, over every core at once.
      loadConfirmedCorePmidsByCore(coreIds, db),
    ]);

  const collabByCode = new Map(collabRows.map((r) => [r.centerCode, r]));
  const fundingByCode = new Map(fundingRows.map((r) => [r.centerCode, r]));

  for (const unit of units) {
    const { code, kind } = unit;
    const numbers = REPORT_NUMBERS_BY_KIND[kind];
    // A core has no membership at all, so its 3/6 liveness is the exact
    // presence of a confirmed `publication_core` usage set — NOT the
    // active-member proxy, which would read false for every core and paint
    // "0 of 2 live" over a core with hundreds of confirmed usages.
    const hasPublicationSource =
      kind === "core"
        ? (confirmedPmidsByCore.get(code)?.length ?? 0) > 0
        : kind === "center"
          ? (activeCenterMembersByCode.get(code) ?? 0) > 0
          : (nonCenterHasActiveMembers.get(code) ?? false);
    const collab = kind === "center" ? collabByCode.get(code) : undefined;
    const funding = kind === "center" ? fundingByCode.get(code) : undefined;

    const perReport: ReportLiveness["perReport"] = numbers.map((n) => {
      if (n === 1) return { n, live: (collab?._count._all ?? 0) > 0, lastRefreshedAt: collab?._max.lastRefreshedAt ?? null };
      if (n === 2) return { n, live: (funding?._count._all ?? 0) > 0, lastRefreshedAt: funding?._max.lastRefreshedAt ?? null };
      // 3, 4, 5, 6 — proxied by active-membership existence (center/dept/div)
      // or by real confirmed-usage presence (core).
      return { n, live: hasPublicationSource, lastRefreshedAt: null };
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
