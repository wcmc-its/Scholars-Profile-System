/**
 * The `/edit/research-security` gate: feature flag, birthright
 * (`lib/edit/dashboard-access.ts`), the page/route form `canViewDashboard`,
 * and the URL parameters. `@/lib/db` is mocked.
 *
 * The dashboard is sensitive: every case that is not "flag on AND (superuser
 * OR research_security_viewer OR an explicit dash:research-security grant)"
 * must be denied.
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

import {
  canViewDashboard,
  dashboardBirthright,
  dashboardBlocked,
  dashboardVisible,
  isDashboardFlagOn,
} from "@/lib/edit/dashboard-access";
import {
  DEFAULT_DATE_FROM,
  LIST_COUNTRY,
  LIST_HOUSE,
  LIST_USUAL,
  campusName,
  filterSummary,
  isResearchSecurityDashboardEnabled,
  listCodesFor,
  parseResearchSecurityParams,
  researchSecurityQuery,
  withKnownCategory,
} from "@/lib/edit/research-security-dashboard";

const plain = { cwid: "ann", isSuperuser: false, isCommsSteward: false };
const D = "research-security" as const;

function grant(scopes: string[]) {
  h.frgFindMany.mockImplementation(async ({ where }: { where: { role: string; cwid: string } }) =>
    where.role === "reporting" && where.cwid === "ann" ? [{ scopes }] : [],
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "on");
  vi.stubEnv("EDIT_RESEARCH_SECURITY_DASHBOARD", "on");
  h.unitAdminFindFirst.mockResolvedValue(null);
  grant([]);
});

describe("isResearchSecurityDashboardEnabled", () => {
  it("is true only when EDIT_RESEARCH_SECURITY_DASHBOARD is exactly 'on'", () => {
    expect(isResearchSecurityDashboardEnabled()).toBe(true);
    for (const v of ["off", "ON", "true", ""]) {
      vi.stubEnv("EDIT_RESEARCH_SECURITY_DASHBOARD", v);
      expect(isResearchSecurityDashboardEnabled()).toBe(false);
      expect(isDashboardFlagOn(D)).toBe(false);
    }
  });
});

describe("birthright", () => {
  it("admits a superuser and a research_security_viewer", () => {
    expect(dashboardBirthright({ ...plain, isSuperuser: true }, D, false)).toBe(true);
    expect(dashboardBirthright({ ...plain, isResearchSecurityViewer: true }, D, false)).toBe(true);
  });

  it.each([
    ["no role", plain],
    ["comms_steward", { ...plain, isCommsSteward: true }],
    ["observer (synthetic steward)", { ...plain, isCommsSteward: true, isObserver: true }],
    ["content editor", { ...plain, isCommsSteward: true, isContentEditor: true }],
    ["data_sharing_viewer", { ...plain, isDataSharingViewer: true }],
    ["viewer flag false", { ...plain, isResearchSecurityViewer: false }],
  ])("denies %s", (_label, session) => {
    expect(dashboardBirthright(session, D, true)).toBe(false);
  });
});

describe("canViewDashboard (pages, export)", () => {
  it("allowed with the role and the flag on", async () => {
    expect(await canViewDashboard({ ...plain, isResearchSecurityViewer: true }, D)).toBe(true);
    expect(await canViewDashboard({ ...plain, isSuperuser: true }, D)).toBe(true);
  });

  it("denied without the role", async () => {
    expect(await canViewDashboard(plain, D)).toBe(false);
    expect(await canViewDashboard({ ...plain, isCommsSteward: true, isObserver: true }, D)).toBe(false);
  });

  it("denied for everyone while the flag is off, superuser included", async () => {
    vi.stubEnv("EDIT_RESEARCH_SECURITY_DASHBOARD", "off");
    grant(["dash:research-security"]);
    expect(await canViewDashboard({ ...plain, isSuperuser: true }, D)).toBe(false);
    expect(await canViewDashboard({ ...plain, isResearchSecurityViewer: true }, D)).toBe(false);
    expect(await canViewDashboard(plain, D)).toBe(false);
  });

  it("an All reports grant, or another dashboard's grant, does not admit it", async () => {
    grant(["*", "dash:data-sharing", "dash:coi"]);
    expect(await canViewDashboard(plain, D)).toBe(false);
  });

  it("an explicit dash:research-security grant does not admit it either: the role is the only way in", async () => {
    grant(["dash:research-security"]);
    expect(await canViewDashboard(plain, D)).toBe(false);
    expect(dashboardVisible(plain, D, { viewerCanViewUsage: true, dashboards: new Set([D]) })).toBe(false);
  });

  // "View as" started by an observer or content editor: the session is the
  // impersonated person's (cwid "ann"), marked by getEffectiveEditSession.
  describe("a non-superuser View as overlay", () => {
    const borrowed = { ...plain, sensitiveDashboardsBlocked: true };

    it("is denied even when the impersonated person holds dash:research-security", async () => {
      grant(["dash:research-security"]);
      expect(await canViewDashboard(borrowed, D)).toBe(false);
      expect(await canViewDashboard({ ...borrowed, isCommsSteward: true, isObserver: true }, D)).toBe(false);
    });

    it("is denied even if a viewer verdict were to slip through", async () => {
      expect(await canViewDashboard({ ...borrowed, isResearchSecurityViewer: true }, D)).toBe(false);
      expect(dashboardBirthright({ ...borrowed, isResearchSecurityViewer: true }, D, false)).toBe(true);
    });

    it("shows no tab, with the grant loaded", () => {
      const g = { viewerCanViewUsage: true, dashboards: new Set([D]) };
      expect(dashboardVisible(borrowed, D, g)).toBe(false);
    });

    it("leaves the other dashboards as they were", async () => {
      grant(["dash:activity"]);
      expect(await canViewDashboard(borrowed, "activity")).toBe(true);
      for (const d of ["activity", "usage", "etl-status", "orcid-coverage", "coi", "data-sharing"] as const)
        expect(dashboardBlocked(borrowed, d)).toBe(false);
      expect(dashboardBlocked(borrowed, D)).toBe(true);
      expect(dashboardBlocked(plain, D)).toBe(false);
    });
  });

  it("the tab form agrees", () => {
    const g = { viewerCanViewUsage: true, dashboards: new Set<never>() };
    expect(dashboardVisible({ ...plain, isResearchSecurityViewer: true }, D, g)).toBe(true);
    expect(dashboardVisible({ ...plain, isCommsSteward: true }, D, g)).toBe(false);
  });
});

describe("parseResearchSecurityParams", () => {
  it("defaults: By entity, both campuses, the entity lists, 2021-01-01 onward", () => {
    expect(parseResearchSecurityParams({})).toEqual({
      view: "entity",
      page: 1,
      filters: {
        campus: "both",
        list: "entities",
        category: undefined,
        dateFrom: DEFAULT_DATE_FROM,
        dateTo: undefined,
        excludeConsortia: false,
      },
    });
    expect(DEFAULT_DATE_FROM).toBe("2021-01-01");
  });

  it("reads valid values", () => {
    const p = parseResearchSecurityParams({
      view: "unattributed",
      page: "3",
      campus: "ithaca",
      list: LIST_COUNTRY,
      category: "Country",
      from: "2023-07-01",
      to: "2024-06-30",
      consortia: "exclude",
    });
    expect(p.view).toBe("unattributed");
    expect(p.page).toBe(3);
    expect(p.filters).toEqual({
      campus: "ithaca",
      list: LIST_COUNTRY,
      category: "Country",
      dateFrom: "2023-07-01",
      dateTo: "2024-06-30",
      excludeConsortia: true,
    });
  });

  it("an invalid value falls back to its default, never an error", () => {
    const p = parseResearchSecurityParams({
      view: "nope",
      page: "-2",
      campus: "mars",
      list: "everything",
      from: "2024-13-45",
      to: "yesterday",
      consortia: "yes",
    });
    expect(p).toEqual(parseResearchSecurityParams({}));
  });

  it("round-trips through the query string, leaving defaults out", () => {
    expect(researchSecurityQuery(parseResearchSecurityParams({}))).toBe("");
    const p = parseResearchSecurityParams({ view: "paper", list: LIST_COUNTRY, page: "2" });
    const q = researchSecurityQuery(p);
    expect(q).toBe("?view=paper&list=country-of-concern&page=2");
    expect(parseResearchSecurityParams(Object.fromEntries(new URLSearchParams(q)))).toEqual(p);
  });
});

describe("a category that the selected list does not have", () => {
  // The scenario: list = House nominations, category = a CAS category; the
  // List is switched to Country of concern and the form submits both.
  const stale = parseResearchSecurityParams({ list: LIST_COUNTRY, category: "CAS institute" }).filters;

  it("is dropped, so it is never applied while the dropdown reads All categories", () => {
    expect(stale.category).toBe("CAS institute");
    const f = withKnownCategory(stale, ["Country"]);
    expect(f.category).toBeUndefined();
    expect(f.list).toBe(LIST_COUNTRY);
    // The links and the export are built from the checked filters.
    expect(researchSecurityQuery({ filters: f })).toBe("?list=country-of-concern");
  });

  it("a category the list has is kept, and no category stays none", () => {
    expect(withKnownCategory(stale, ["CAS institute", "Country"])).toBe(stale);
    const none = parseResearchSecurityParams({}).filters;
    expect(withKnownCategory(none, [])).toBe(none);
  });

  it("the summary line names every filter that changes a count", () => {
    expect(filterSummary(parseResearchSecurityParams({}).filters)).toEqual([
      "WCM and Cornell University",
      "Listed entities (House nominations and usual suspects)",
      "all categories",
      "published 2021-01-01 (default) to present",
      "50+ author consortia included",
    ]);
    expect(
      filterSummary(
        parseResearchSecurityParams({
          campus: "ithaca",
          list: LIST_HOUSE,
          category: "CAS institute",
          from: "2023-01-01",
          to: "2023-12-31",
          consortia: "exclude",
        }).filters,
      ),
    ).toEqual([
      "Cornell University",
      "House Section 1286 nominations",
      "category: CAS institute",
      "published 2023-01-01 to 2023-12-31",
      "50+ author consortia excluded",
    ]);
  });

  it("a person row with no campus says so", () => {
    expect(campusName("wcm")).toBe("Weill Cornell Medicine");
    expect(campusName("ithaca")).toBe("Cornell University");
    expect(campusName("unknown")).toBe("Campus not assigned");
  });
});

describe("the list filter keeps country of concern in its own tier", () => {
  it("the default reads the two entity lists and never the country list", () => {
    expect(listCodesFor("entities")).toEqual([LIST_HOUSE, LIST_USUAL]);
  });

  it("country of concern is read only when it is the list selected, and alone", () => {
    expect(listCodesFor(LIST_COUNTRY)).toEqual([LIST_COUNTRY]);
    expect(listCodesFor(LIST_HOUSE)).toEqual([LIST_HOUSE]);
  });
});
