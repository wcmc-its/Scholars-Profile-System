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
import { isDataQualityDashboardEnabled } from "@/lib/edit/data-quality";
import { isDataSharingDashboardTabVisible } from "@/lib/edit/data-sharing-dashboard";
import { isCorePagesEnabled } from "@/lib/profile/cores-flags";
import { isMatchaEnabled } from "@/lib/api/matcha";

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
  "dataQuality",
  "dataSharing",
  "activity",
  "usage",
  "etlStatus",
  "cores",
  "fundingMatcher",
  "matcha",
] as const;

export type ConsoleTabId = (typeof CONSOLE_TAB_IDS)[number];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Everything DB-derived that visibility depends on. Loaded once per request. */
export interface ConsoleGrants {
  /** `loadOwnerManagedUnitScope(...).length` — role: "owner" grants only, per
   *  D5. Feeds `administrators`. */
  ownerUnitCount: number;
  /** `loadManageableUnits(...).total` — owner OR curator, any of the four unit
   *  kinds. Feeds `profiles` / `units` / `dataQuality`. */
  manageableUnitCount: number;
  /** `loadReportableUnitsForActor(...).length` — for a non-global viewer this
   *  counts CENTERS only (departments/divisions/cores don't carry reports), so
   *  it can be 0 even when `manageableUnitCount` isn't. Feeds `reports`. */
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
  // Owner-scoped Cores index is a deliberately deferred gap, self-documented
  // in `app/edit/core/page.tsx`'s own comment — when it lands, it lands here.
  cores: (s) => s.isSuperuser && isCorePagesEnabled(),

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

  // No single `isDataQualityTabVisible`-shaped function bundles the grant
  // escape hatch — `isDataQualityDashboardEnabled` is the flag primitive
  // `/edit/units` already reuses inline; this mirrors that, not a new read.
  dataQuality: (s, g) =>
    isDataQualityDashboardEnabled() && (s.isSuperuser || s.isCommsSteward || g.manageableUnitCount > 0),

  // No per-unit data-sharing concept exists (by design — no unit-scoped
  // variant of this dashboard has been decided; unlike Data Quality this
  // isn't cited to a spec doc yet, see Part B).
  dataSharing: (s) => isDataSharingDashboardTabVisible(s),

  // Gap 4 (usage half): any UnitAdmin grant, from any page. `canViewUsage`
  // already ORs in `isSuperuser`.
  usage: (_s, g) => g.viewerCanViewUsage,

  // Gap 1b: developers get these from the `/edit` landing page too, because
  // visibility no longer depends on which page you're standing on.
  fundingMatcher: (s) => s.isSuperuser || s.isDeveloper === true,
  matcha: (s) => (s.isSuperuser || s.isDeveloper === true) && isMatchaEnabled(),
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
      loadReportableUnitsForActor(session, db),
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
