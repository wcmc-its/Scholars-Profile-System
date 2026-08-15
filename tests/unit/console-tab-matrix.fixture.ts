/**
 * The INTENDED role × tab matrix, as data — the executable form of
 * `docs/edit-console-ia-spec.md` Part A §3. The prose table there is a
 * rendering of this file, not a parallel copy that can drift.
 *
 * Each row names a viewer shape (session roles + grants) and the exact set of
 * tabs that viewer must see. `console-tab-matrix.test.ts` asserts
 * `TAB_PREDICATES` reproduces every row, then checks monotonicity (I3) across
 * every pairwise combination.
 */
import type { ConsoleTabId, ConsoleGrants } from "@/lib/edit/console-tabs.server";
import type { EditSession } from "@/lib/auth/superuser";

// --- factories -------------------------------------------------------------

export const sess = (over: Partial<EditSession> = {}): EditSession => ({
  cwid: "t000001",
  isSuperuser: false,
  isCommsSteward: false,
  isHonorsCurator: false,
  isDeveloper: false,
  isDataSharingViewer: false,
  ...over,
});

export const grants = (over: Partial<ConsoleGrants> = {}): ConsoleGrants => ({
  ownerUnitCount: 0,
  manageableUnitCount: 0,
  reportableUnitCount: 0,
  viewerCanViewUsage: false,
  ...over,
});

export const ALL_TABS: ConsoleTabId[] = [
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
];

// --- the matrix --------------------------------------------------------

export interface MatrixRow {
  name: string;
  session: EditSession;
  grants: ConsoleGrants;
  expect: ConsoleTabId[];
  /** Which spec gap this row exists to pin, if any — cross-referenced in
   *  Part C of the spec. */
  pins?: string;
}

// Flag-gated tabs (honors, news, administrators, methods, dataQuality,
// dataSharing, cores, matcha) assume their flag is ON — these rows exercise
// role/grant logic, not env config. `console-tab-matrix.test.ts`'s "feature
// flags" block covers the flag-off direction separately, against the real
// `isXTabVisible` functions (this fixture has no flags-off rows to avoid
// encoding today's env state, which isn't this file's job).
export const INTENDED_MATRIX: MatrixRow[] = [
  {
    name: "superuser",
    session: sess({ isSuperuser: true }),
    // `viewerCanViewUsage` isn't re-derived from `isSuperuser` by any predicate
    // here — it's whatever `loadConsoleGrants` got back from `canViewUsage`,
    // which already ORs in the superuser check itself. A hand-built fixture row
    // has to set it explicitly to match what the real loader would return.
    grants: grants({ viewerCanViewUsage: true }),
    expect: ALL_TABS,
  },
  {
    name: "comms_steward",
    session: sess({ isCommsSteward: true }),
    grants: grants(),
    expect: ["profiles", "units", "news", "methods", "reports", "dataQuality", "dataSharing"],
    pins: "Gap 2 — news via isNewsQueueTabVisible, never via a profilesTab piggyback",
  },
  {
    name: "pure honors_curator",
    session: sess({ isHonorsCurator: true }),
    grants: grants(),
    expect: ["honors"],
    pins: "Gap 1 / #1767 — a non-empty tab set means the strip must render on /edit",
  },
  {
    name: "unit Owner (2 owned centers, both reportable, has a UnitAdmin usage grant)",
    session: sess(),
    grants: grants({
      ownerUnitCount: 2,
      manageableUnitCount: 2,
      reportableUnitCount: 2,
      viewerCanViewUsage: true,
    }),
    expect: ["profiles", "units", "administrators", "reports", "dataQuality", "usage"],
    pins: "Gap 3 (D5: administrators for Owners) + Gap 4 (reports/usage everywhere)",
  },
  {
    name: "unit Owner of a department only (0 reportable — reports counts centers, not depts)",
    session: sess(),
    grants: grants({ ownerUnitCount: 1, manageableUnitCount: 1 }),
    expect: ["profiles", "units", "administrators", "dataQuality"],
    pins: "reportableUnitCount vs manageableUnitCount divergence, Part B §4",
  },
  {
    name: "unit Curator (1 manageable center, nothing else)",
    session: sess(),
    grants: grants({ manageableUnitCount: 1, reportableUnitCount: 1 }),
    expect: ["profiles", "units", "reports", "dataQuality"],
    pins: "D5 by-design exclusion — curators never see Administrators (ownerUnitCount stays 0)",
  },
  {
    name: "pure developer",
    session: sess({ isDeveloper: true }),
    grants: grants(),
    expect: ["fundingMatcher", "matcha"],
    pins: "Gap 1b — reachable from the /edit landing page, not only once already there",
  },
  {
    name: "pure data_sharing_viewer",
    session: sess({ isDataSharingViewer: true }),
    grants: grants(),
    expect: ["dataSharing"],
    pins: "2026-08-15 — the role unlocks ONLY the dashboard, no other /edit tab",
  },
  {
    name: "comms_steward + unit Owner (the Gap 4b monotonicity case)",
    session: sess({ isCommsSteward: true }),
    grants: grants({
      ownerUnitCount: 1,
      manageableUnitCount: 1,
      reportableUnitCount: 1,
      viewerCanViewUsage: true,
    }),
    expect: [
      "profiles",
      "units",
      "news",
      "methods",
      "reports",
      "dataQuality",
      "dataSharing",
      "administrators",
      "usage",
    ],
    pins: "Gap 4b — a comms_steward loses Units on /edit/administrators (unitsTab={session.isSuperuser})",
  },
  {
    name: "no roles, no grants",
    session: sess(),
    grants: grants(),
    expect: [],
  },
];
