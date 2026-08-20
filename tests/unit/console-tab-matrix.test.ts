/**
 * The executable form of `docs/edit-console-ia-spec.md` Part A — the intended
 * role × tab matrix (§3) and the three invariants it's built on (I1–I3).
 *
 * This is a NEW test surface for the proposed `console-tabs.server.ts`
 * predicates; it does not touch `tests/unit/admin-subnav.test.tsx`, which
 * still documents the SHIPPED (and in four places, buggy) `AdminSubnav`
 * behavior. Once the loader is wired into the nav (Part B, "why kill the
 * contract"), `admin-subnav.test.tsx`'s Gap-3 pin — administratorsTab={0} +
 * superuserSurfaces={false} asserting the tab is absent — gets deleted, and
 * this file becomes the regression harness for that migration.
 *
 * Every flag this suite touches is restored via `vi.unstubAllEnvs()` in
 * `afterEach` — no manual `process.env` backup/restore.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONSOLE_TAB_IDS,
  TAB_PREDICATES,
  type ConsoleTabId,
  type ConsoleGrants,
} from "@/lib/edit/console-tabs.server";
import { ALL_TABS, INTENDED_MATRIX, type MatrixRow } from "./console-tab-matrix.fixture";
import type { EditSession } from "@/lib/auth/superuser";

const ALL_FLAGS_ON: Record<string, string> = {
  HONORS_APPROVAL_QUEUE: "on",
  NEWS_APPROVAL_QUEUE: "on",
  SELF_EDIT_ADMINISTRATORS_TAB: "on",
  COMMS_STEWARD_ENABLED: "on",
  EDIT_DATA_QUALITY_DASHBOARD: "on",
  EDIT_DATA_SHARING_DASHBOARD: "on",
  CORE_PAGES: "on",
  MATCHA: "on",
  GRANT_MATCHA: "on",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function visibleTabs(session: EditSession, grants: ConsoleGrants): Set<ConsoleTabId> {
  Object.entries(ALL_FLAGS_ON).forEach(([k, v]) => vi.stubEnv(k, v));
  return new Set(CONSOLE_TAB_IDS.filter((id) => TAB_PREDICATES[id](session, grants)));
}

// --- 1. Matrix conformance -------------------------------------------------

describe("intended role × tab matrix (all flags on)", () => {
  it.each(INTENDED_MATRIX.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    const actual = visibleTabs(row.session, row.grants);
    // Exact set equality: extra tabs are as much a failure as missing ones.
    expect([...actual].sort()).toEqual([...row.expect].sort());
  });

  it("every tab id appears in at least one row's expectations", () => {
    // Guards against adding a tab whose predicate no fixture row exercises —
    // an unspecified tab is exactly how the News piggyback shipped unnoticed.
    const covered = new Set(INTENDED_MATRIX.flatMap((r) => r.expect));
    expect([...covered].sort()).toEqual([...ALL_TABS].sort());
    expect([...covered].sort()).toEqual([...CONSOLE_TAB_IDS].sort());
  });
});

// --- 2. Monotonicity property (I3) -----------------------------------------

function mergeSessions(a: EditSession, b: EditSession): EditSession {
  return {
    cwid: a.cwid,
    isSuperuser: a.isSuperuser || b.isSuperuser,
    isCommsSteward: a.isCommsSteward || b.isCommsSteward,
    isHonorsCurator: a.isHonorsCurator === true || b.isHonorsCurator === true,
    isDeveloper: a.isDeveloper === true || b.isDeveloper === true,
    isDataSharingViewer: a.isDataSharingViewer === true || b.isDataSharingViewer === true,
  };
}

function mergeGrants(a: ConsoleGrants, b: ConsoleGrants): ConsoleGrants {
  return {
    ownerUnitCount: a.ownerUnitCount + b.ownerUnitCount,
    manageableUnitCount: a.manageableUnitCount + b.manageableUnitCount,
    reportableUnitCount: a.reportableUnitCount + b.reportableUnitCount,
    viewerCanViewUsage: a.viewerCanViewUsage || b.viewerCanViewUsage,
  };
}

describe("invariant I3 — adding roles/grants never removes a tab", () => {
  const pairs: Array<[MatrixRow, MatrixRow]> = INTENDED_MATRIX.flatMap((a) =>
    INTENDED_MATRIX.map((b) => [a, b] as [MatrixRow, MatrixRow]),
  );

  it.each(pairs.map(([a, b]) => [`${a.name} + ${b.name}`, a, b] as const))(
    "%s",
    (_name, a, b) => {
      const merged = visibleTabs(mergeSessions(a.session, b.session), mergeGrants(a.grants, b.grants));
      const expectedAtLeast = new Set([...a.expect, ...b.expect]);
      for (const tab of expectedAtLeast) {
        expect(merged.has(tab), `merged viewer lost "${tab}"`).toBe(true);
      }
    },
  );
});

// --- 3. Flags only ever subtract their own tab ------------------------------

describe("feature flags", () => {
  // A flag may gate more than one tab: GRANT_MATCHA layers on top of MATCHA
  // (the Grant Matcha page seeds the Matcha spine), so MATCHA off takes the
  // `grantMatcha` tab down with `matcha` — exactly as the page's own
  // `notFound()` gate does.
  const flagToTabs: Array<[string, ConsoleTabId[]]> = [
    ["HONORS_APPROVAL_QUEUE", ["honors"]],
    ["NEWS_APPROVAL_QUEUE", ["news"]],
    ["SELF_EDIT_ADMINISTRATORS_TAB", ["administrators"]],
    ["COMMS_STEWARD_ENABLED", ["methods"]],
    ["EDIT_DATA_QUALITY_DASHBOARD", ["coi"]],
    ["EDIT_DATA_SHARING_DASHBOARD", ["dataSharing"]],
    ["CORE_PAGES", ["cores"]],
    ["MATCHA", ["matcha", "grantMatcha"]],
    ["GRANT_MATCHA", ["grantMatcha"]],
  ];

  it.each(flagToTabs)("flag %s off hides only %s", (flagKey, tabs) => {
    const superuser = INTENDED_MATRIX[0];
    const on = visibleTabs(superuser.session, superuser.grants);

    Object.entries(ALL_FLAGS_ON).forEach(([k, v]) => vi.stubEnv(k, v));
    vi.stubEnv(flagKey, "off");
    const off = new Set(
      CONSOLE_TAB_IDS.filter((id) => TAB_PREDICATES[id](superuser.session, superuser.grants)),
    );

    for (const tab of tabs) expect(off.has(tab), `"${tab}" still visible`).toBe(false);
    expect([...off, ...tabs].sort()).toEqual([...on].sort());
  });
});
