/**
 * Ad hoc dashboard grants (decision 2026-10-01): a manual Reporting grant
 * carrying `dash:<dashboard>` admits that dashboard's gate
 * (`lib/edit/dashboard-access.ts`). The wildcard `"*"` admits every report
 * and NO dashboard, so an existing "All reports" grant never widens.
 * `@/lib/db` is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ frgFindMany: vi.fn(), unitAdminFindFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      functionalRoleGrant: { findMany: h.frgFindMany },
      unitAdmin: { findFirst: h.unitAdminFindFirst },
    },
    write: {},
  },
}));

import { registryDashboards, registryHasAnyReporting } from "@/lib/auth/functional-role-authz";
import { canViewDashboard } from "@/lib/edit/dashboard-access";
import { dashboardsFromScopes, normalizeScopes } from "@/lib/edit/functional-roles";
import { validScopes } from "@/lib/edit/functional-roles.server";
import { toggleScope } from "@/components/edit/functional-roles-panel";

/** One manual Reporting grant for `ann` with these scopes. */
function grant(scopes: string[]) {
  h.frgFindMany.mockImplementation(async ({ where }: { where: { role: string; cwid: string } }) =>
    where.role === "reporting" && where.cwid === "ann" ? [{ scopes }] : [],
  );
}

const plain = { cwid: "ann", isSuperuser: false, isCommsSteward: false };

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "on");
  vi.stubEnv("EDIT_DATA_QUALITY_DASHBOARD", "on");
  vi.stubEnv("EDIT_DATA_SHARING_DASHBOARD", "on");
  h.unitAdminFindFirst.mockResolvedValue(null);
  grant([]);
});

describe("scope vocabulary", () => {
  it("the wildcard admits no dashboard; unknown dash keys are ignored", () => {
    expect([...dashboardsFromScopes(["*"])]).toEqual([]);
    expect([...dashboardsFromScopes(["dash:coi", "dash:nope", "article-count"])]).toEqual(["coi"]);
  });

  it("normalizing keeps dashboard keys next to the wildcard", () => {
    expect(normalizeScopes(["dash:usage", "article-count", "*"])).toEqual(["*", "dash:usage"]);
    expect(normalizeScopes(["*", "mentored-publications"])).toEqual(["*"]);
  });

  it("picking All reports keeps the picked dashboards", () => {
    expect(toggleScope(["dash:coi", "article-count"], "*")).toEqual(["*", "dash:coi"]);
    expect(toggleScope(["*"], "dash:coi")).toEqual(["*", "dash:coi"]);
    expect(toggleScope(["*"], "article-count")).toEqual(["article-count"]);
  });

  it("the route accepts each dashboard key and rejects an unknown one", () => {
    expect(validScopes("reporting", ["dash:coi", "dash:etl-status"])).toBe(true);
    expect(validScopes("reporting", ["dash:nope"])).toBe(false);
    expect(validScopes("external_affairs", ["dash:coi"])).toBe(false);
  });
});

describe("registry reads", () => {
  it("a dashboards-only grant is not report access (no empty Reports tab)", async () => {
    grant(["dash:coi"]);
    expect(await registryHasAnyReporting("ann")).toBe(false);
    expect([...(await registryDashboards("ann"))]).toEqual(["coi"]);
  });

  it("flag off reads nothing", async () => {
    vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "off");
    grant(["dash:coi"]);
    expect((await registryDashboards("ann")).size).toBe(0);
    expect(h.frgFindMany).not.toHaveBeenCalled();
  });
});

describe("canViewDashboard", () => {
  it("a dash: grant admits exactly that dashboard", async () => {
    grant(["dash:etl-status"]);
    expect(await canViewDashboard(plain, "etl-status")).toBe(true);
    expect(await canViewDashboard(plain, "activity")).toBe(false);
    expect(await canViewDashboard(plain, "usage")).toBe(false);
  });

  it("an All reports grant admits no dashboard", async () => {
    grant(["*"]);
    for (const d of [
      "coi",
      "usage",
      "orcid-coverage",
      "etl-status",
      "activity",
      "data-sharing",
    ] as const) {
      expect(await canViewDashboard(plain, d)).toBe(false);
    }
  });

  it("the dashboard's own flag still wins over a grant", async () => {
    vi.stubEnv("EDIT_DATA_QUALITY_DASHBOARD", "off");
    grant(["dash:coi"]);
    expect(await canViewDashboard(plain, "coi")).toBe(false);
  });

  it("COI by birthright: superuser, observer, content editor; not a steward", async () => {
    expect(await canViewDashboard({ ...plain, isSuperuser: true }, "coi")).toBe(true);
    expect(
      await canViewDashboard({ ...plain, isCommsSteward: true, isObserver: true }, "coi"),
    ).toBe(true);
    expect(
      await canViewDashboard({ ...plain, isCommsSteward: true, isContentEditor: true }, "coi"),
    ).toBe(true);
    expect(await canViewDashboard({ ...plain, isCommsSteward: true }, "coi")).toBe(false);
  });

  it("Usage birthright is unchanged: any org-unit admin", async () => {
    h.unitAdminFindFirst.mockResolvedValue({ cwid: "ann" });
    expect(await canViewDashboard(plain, "usage")).toBe(true);
  });
});
