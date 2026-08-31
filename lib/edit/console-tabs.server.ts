/**
 * Single source of truth for console tab visibility — the proposed replacement
 * for `deriveConsoleTabs` + the per-page "OR your own grant signal onto the
 * baseline" contract (`lib/edit/console-tabs.ts` §2a/§2b,
 * `docs/edit-console-ia-spec.md` Part B).
 *
 * NOT YET WIRED into `AdminSubnav` / `ConsoleShell` / any page. This module is
 * the executable form of Part A's intended matrix — `TAB_PREDICATES` below IS
 * the normative role × tab table, checked against
 * `tests/unit/console-tab-matrix.fixture.ts` by
 * `tests/unit/console-tab-matrix.test.ts`. Migrating the shipped nav onto it
 * (deleting `deriveConsoleTabs`, the `ConsoleShell` merge props, and the
 * per-page OR-ing) is a separate, auth-adjacent change gated on an explicit go
 * (`2026-08-14-edit-console-ia-handoff.md`, decision 3).
 *
 * Invariants enforced by construction:
 *
 *   I1 — Location-independence. A predicate is a pure function of
 *        (session, grants). No page input affects visibility.
 *   I2 — Nav/page parity. Each tab's visibility comes from ONE named predicate
 *        in `TAB_PREDICATES`; `assertTabAdmits` below is the page's gate too —
 *        one predicate, two callers, so nav-shows/page-404s and
 *        page-admits/nav-hides both become unrepresentable.
 *   I3 — Monotonicity. Every predicate is a disjunction of role/grant signals
 *        — no replace semantics, no ANDing a role in as a second gate. Adding
 *        a role can never remove a tab.
 */
import { cache } from "react";
import { notFound } from "next/navigation";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { UnitEntityType } from "@/lib/api/manual-layer";
import type { EditSession } from "@/lib/auth/superuser";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import {
  isAdministratorsTabVisible,
  loadOwnerManagedUnitScope,
} from "@/lib/edit/administrators";
import { loadManageableUnits } from "@/lib/edit/manageable-units";
import { canViewUsage } from "@/lib/edit/usage-access";
import { loadReportableUnitsForActor } from "@/lib/edit/cancer-center-reports";
import { isNewsQueueTabVisible } from "@/lib/edit/news-queue";
import { isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { isDataSharingDashboardTabVisible } from "@/lib/edit/data-sharing-dashboard";
import { isDataQualityDashboardEnabled } from "@/lib/edit/data-quality";
import { isCorePagesEnabled } from "@/lib/profile/cores-flags";
import { isMatchaEnabled } from "@/lib/api/matcha";
import { isGrantMatchaEnabled } from "@/lib/edit/grant-recs";
import { isOrgUnitRoleConsoleTabVisible } from "@/lib/edit/org-unit-role-flags";

// ---------------------------------------------------------------------------
// Tab ids — one per `AdminSubnavActive` entry in `admin-subnav.tsx`, minus
// "self" (that's `active`, not a tab).
// ---------------------------------------------------------------------------

export const CONSOLE_TAB_IDS = [
  "profiles",
  "units",
  "slugRequests",
  "honors",
  "news",
  "slugs",
  "administrators",
  "methods",
  "reports",
  "coi",
  "dataSharing",
  "activity",
  "usage",
  "etlStatus",
  "cores",
  "matcha",
  "grantMatcha",
  "roleVocabulary",
] as const;

export type ConsoleTabId = (typeof CONSOLE_TAB_IDS)[number];

/** Kinds `loadReportableUnitsForActor` should count for the `reports` tab —
 *  same widened set reports 3/6 and `/edit/reports` itself pass (org-unit
 *  publications reports plan, 2026-08-16). `core` is deliberately excluded:
 *  no reportable-unit kind exists for it yet. */
const REPORTABLE_KINDS: readonly UnitEntityType[] = ["center", "department", "division"];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Everything DB-derived that visibility depends on. Loaded once per request. */
export interface ConsoleGrants {
  /** `loadOwnerManagedUnitScope(...).length` — role: "owner" grants only, per
   *  D5. Feeds `administrators`. */
  ownerUnitCount: number;
  /** `loadManageableUnits(...).total` — owner OR curator, any of the four unit
   *  kinds. Feeds `profiles` / `units`. */
  manageableUnitCount: number;
  /** `loadReportableUnitsForActor(..., REPORTABLE_KINDS).length` — center,
   *  department, and division all carry reports (org-unit publications
   *  reports plan, 2026-08-16: reports 3/6 are kind-generic); only `core`
   *  doesn't, so for a non-global viewer this can still be 0 while
   *  `manageableUnitCount` isn't (a core-only grant). Feeds `reports`. */
  reportableUnitCount: number;
  /** `canViewUsage(...)` — any `UnitAdmin` grant holder, either role. Already
   *  ORs in `isSuperuser`. Feeds `usage`. */
  viewerCanViewUsage: boolean;
}

export type TabPredicate = (session: EditSession, grants: ConsoleGrants) => boolean;

// ---------------------------------------------------------------------------
// The predicates — the entire IA, in one screenful. Each delegates to the
// SAME bundled `isXTabVisible` function the corresponding page/queue module
// already exports where one exists (flag + role together) — nothing here
// re-reads an env var a sibling module already owns. `administrators` is the
// one gap that had no such function; `isAdministratorsTabVisible` (added
// alongside `isAdministratorsTabEnabled`) fills it, mirroring its siblings.
// ---------------------------------------------------------------------------

export const TAB_PREDICATES: Record<ConsoleTabId, TabPredicate> = {
  profiles: (s, g) => s.isSuperuser || s.isCommsSteward || g.manageableUnitCount > 0,
  units: (s, g) => s.isSuperuser || s.isCommsSteward || g.manageableUnitCount > 0,

  slugRequests: (s) => s.isSuperuser,
  slugs: (s) => s.isSuperuser,
  activity: (s) => s.isSuperuser,
  etlStatus: (s) => s.isSuperuser,
  // 2026-08-26 policy widening (decision #6): a comms_steward gets full
  // curator-parity on cores (content, leaders/roster, the claim queue —
  // `authorizeCoreClaim`), so the Cores tab is steward-visible too (I2 nav/
  // page parity with `/edit/core` and `/edit/core/[coreId]`'s own gates).
  // Owner-scoped Cores index is still a deliberately deferred gap,
  // self-documented in `app/edit/core/page.tsx`'s own comment.
  cores: (s) => (s.isSuperuser || s.isCommsSteward) && isCorePagesEnabled(),

  // Gap 1: the curator signal now lives in the one gate that matters — no
  // separate `app/edit/page.tsx` `showConsoleNav` check to forget it in.
  honors: (s) => isHonorsQueueTabVisible(s),

  // Gap 2: `isNewsQueueTabVisible` was already correct and already exported —
  // it was just never called. This predicate finally calls it.
  news: (s) => isNewsQueueTabVisible(s),

  // Gap 3 / D5: superusers and unit Owners. Curators are excluded because
  // `ownerUnitCount` counts `role: "owner"` grants only.
  administrators: (s, g) => isAdministratorsTabVisible(s, g.ownerUnitCount),

  methods: (s) => isMethodsTabVisible(s),

  // Gap 4 (reports half): a reportable unit surfaces the tab everywhere,
  // including `/edit/units` and `/edit/administrators`.
  reports: (s, g) => s.isSuperuser || s.isCommsSteward || g.reportableUnitCount > 0,

  // COI review — superuser-only, no comms_steward/unit-admin escape hatch at
  // all (unlike `profiles`/`units`/`reports`). Split out of the merged
  // Profiles page specifically so this stays the one tab a unit admin can
  // never earn, on-screen or via a crafted query param — see
  // `app/edit/coi/page.tsx`.
  coi: (s) => s.isSuperuser && isDataQualityDashboardEnabled(),

  // No per-unit data-sharing concept exists (by design — no unit-scoped
  // variant of this dashboard has been decided; unlike Data Quality this
  // isn't cited to a spec doc yet, see Part B).
  dataSharing: (s) => isDataSharingDashboardTabVisible(s),

  // Gap 4 (usage half): any UnitAdmin grant, from any page. `canViewUsage`
  // already ORs in `isSuperuser`.
  usage: (_s, g) => g.viewerCanViewUsage,

  // Gap 1b: developers get these from the `/edit` landing page too, because
  // visibility no longer depends on which page you're standing on.
  matcha: (s) => (s.isSuperuser || s.isDeveloper === true) && isMatchaEnabled(),
  // GRANT_MATCHA depends on MATCHA (the Matcha spine is what it seeds), so the
  // tab needs BOTH flags — mirroring the page's own `notFound()` gate
  // (`app/edit/grant-matcha/page.tsx`). Same audience as `matcha`.
  grantMatcha: (s) =>
    (s.isSuperuser || s.isDeveloper === true) && isMatchaEnabled() && isGrantMatchaEnabled(),

  // #2542 Phase 3 — the `OrgUnitRole` vocabulary editor. Delegates entirely to
  // the bundled `isXTabVisible` (flag + role together), per the convention
  // above: nothing here re-reads `ORG_UNIT_ROLE_CONSOLE` on its own.
  roleVocabulary: (s) => isOrgUnitRoleConsoleTabVisible(s),
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * One round of grant reads per request, shared by every page/layout via
 * `cache()`. `loadOwnerManagedUnitScope` is skipped for a superuser per its
 * own doc comment ("superuser callers should not invoke this"); the other
 * three still run a real query for a superuser/comms_steward even though the
 * predicates that consume them short-circuit on role first and never look at
 * the count.
 *
 * ponytail: unconditional fan-out, not role-short-circuited — four call sites
 * (soon to be ~14) share one `cache()`'d read per request either way, and this
 * loader isn't wired into anything live yet. Skip the remaining three reads
 * for a global viewer if this ever sits in front of something latency-
 * sensitive.
 */
export const loadConsoleGrants = cache(
  async (session: EditSession, db: PrismaClient): Promise<ConsoleGrants> => {
    const [ownerScope, units, reportable, usage] = await Promise.all([
      session.isSuperuser ? Promise.resolve([]) : loadOwnerManagedUnitScope(session, db),
      loadManageableUnits(session.cwid, db),
      loadReportableUnitsForActor(session, db, REPORTABLE_KINDS),
      canViewUsage(session, db),
    ]);
    return {
      ownerUnitCount: ownerScope.length,
      manageableUnitCount: units.total,
      reportableUnitCount: reportable.length,
      viewerCanViewUsage: usage,
    };
  },
);

export type ConsoleTabState = Record<ConsoleTabId, boolean>;

export const loadConsoleTabs = cache(
  async (session: EditSession, db: PrismaClient): Promise<ConsoleTabState> => {
    const grants = await loadConsoleGrants(session, db);
    return Object.fromEntries(
      CONSOLE_TAB_IDS.map((id) => [id, TAB_PREDICATES[id](session, grants)]),
    ) as ConsoleTabState;
  },
);

/**
 * I2 in one helper: a page calls this instead of hand-rolling its own authz-
 * for-nav check. If the tab wouldn't render in the strip, the page 404s; if
 * the page renders, the tab shows. Not yet called by any page (see the module
 * doc comment) — pending counts and page content still resolve separately.
 */
export async function assertTabAdmits(
  tab: ConsoleTabId,
  session: EditSession,
  db: PrismaClient,
): Promise<ConsoleTabState> {
  const state = await loadConsoleTabs(session, db);
  if (!state[tab]) notFound();
  return state;
}
