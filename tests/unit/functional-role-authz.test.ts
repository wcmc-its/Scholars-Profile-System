/**
 * The `FUNCTIONAL_ROLES_AUTHZ` cutover (`lib/auth/functional-role-authz.ts`)
 * and the three gates that OR it in: `isCommsSteward`, `isDeveloper`, and the
 * report gate (`loadReportScopesForCwid` / `hasAnyReportAccess`).
 *
 * The rule under test is ADDITIVE ONLY: with the flag off nothing reads the
 * registry; with it on, a registry grant can admit someone, and every
 * existing path (allowlist, ED group, `report_access`) still admits exactly
 * who it admitted before. `@/lib/db` and the LDAP compare are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  frgFindMany: vi.fn(),
  reportAccessFindMany: vi.fn(),
  isGroupMember: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      functionalRoleGrant: { findMany: h.frgFindMany },
      reportAccess: { findMany: h.reportAccessFindMany },
    },
    write: {},
  },
}));
vi.mock("@/lib/auth/ldap-group", () => ({ isGroupMember: h.isGroupMember }));

import {
  isFunctionalRolesAuthzEnabled,
  registryAdmitsExternalAffairs,
  registryHasAnyReporting,
  registryReportScopes,
} from "@/lib/auth/functional-role-authz";
import { isCommsSteward } from "@/lib/auth/comms-steward";
import { isDeveloper } from "@/lib/auth/development";
import { hasAnyReportAccess, loadReportScopesForCwid } from "@/lib/edit/report-access";

type GrantRow = { role: string; cwid: string; scopes: string[]; source?: string };

/** The registry as a list; `findMany({ where: { role, cwid, source? } })`
 *  filters it the way MySQL would. A row with no `source` is "manual". */
function registry(rows: GrantRow[]) {
  h.frgFindMany.mockImplementation(
    async ({ where }: { where: { role: string; cwid: string; source?: string } }) =>
      rows
        .filter(
          (r) =>
            r.role === where.role &&
            r.cwid === where.cwid &&
            (where.source === undefined || (r.source ?? "manual") === where.source),
        )
        .map((r) => ({ scopes: r.scopes })),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  registry([]);
  h.reportAccessFindMany.mockResolvedValue([]);
  h.isGroupMember.mockResolvedValue(false);
  // The roles themselves are enabled (as in both deployed envs); the group cns
  // are set, and the allowlists are empty, as deployed.
  vi.stubEnv("COMMS_STEWARD_ENABLED", "on");
  vi.stubEnv("DEVELOPMENT_ENABLED", "on");
  vi.stubEnv("SCHOLARS_COMMS_STEWARD_GROUP_CN", "comms-group");
  vi.stubEnv("SCHOLARS_DEVELOPMENT_GROUP_CN", "dev-group");
  vi.stubEnv("SCHOLARS_COMMS_STEWARD_ALLOWLIST", "");
  vi.stubEnv("SCHOLARS_DEVELOPMENT_ALLOWLIST", "");
  vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "");
});

const EA_COMMS: GrantRow = {
  role: "external_affairs",
  cwid: "fake001",
  scopes: ["communications"],
};
const EA_DEV: GrantRow = { role: "external_affairs", cwid: "fake002", scopes: ["development"] };
const EA_BOTH: GrantRow = {
  role: "external_affairs",
  cwid: "fake003",
  scopes: ["communications", "development"],
};

describe("FUNCTIONAL_ROLES_AUTHZ off (the default in every env)", () => {
  it("the flag must be exactly 'on'", () => {
    expect(isFunctionalRolesAuthzEnabled()).toBe(false);
    vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "true");
    expect(isFunctionalRolesAuthzEnabled()).toBe(false);
    vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "on");
    expect(isFunctionalRolesAuthzEnabled()).toBe(true);
  });

  it("no gate reads the registry, and a registry grant admits nobody", async () => {
    registry([EA_COMMS, EA_DEV, { role: "reporting", cwid: "fake004", scopes: ["*"] }]);
    expect(await isCommsSteward("fake001")).toBe(false);
    expect(await isDeveloper("fake002")).toBe(false);
    expect([...(await loadReportScopesForCwid("fake004", "article-count"))]).toEqual([]);
    expect(await hasAnyReportAccess("fake004")).toBe(false);
    expect(await registryAdmitsExternalAffairs("fake001", "communications")).toBe(false);
    expect(h.frgFindMany).not.toHaveBeenCalled();
  });
});

describe("FUNCTIONAL_ROLES_AUTHZ on: External Affairs", () => {
  beforeEach(() => {
    vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "on");
    registry([EA_COMMS, EA_DEV, EA_BOTH]);
  });

  it("Communications admits isCommsSteward only; Development admits isDeveloper only", async () => {
    expect(await isCommsSteward("fake001")).toBe(true);
    expect(await isDeveloper("fake001")).toBe(false);
    expect(await isCommsSteward("fake002")).toBe(false);
    expect(await isDeveloper("fake002")).toBe(true);
    expect(await isCommsSteward("fake003")).toBe(true);
    expect(await isDeveloper("fake003")).toBe(true);
  });

  it("a registry admit short-circuits the directory compare", async () => {
    expect(await isCommsSteward("fake001")).toBe(true);
    expect(h.isGroupMember).not.toHaveBeenCalled();
  });

  it("the cwid is matched case-insensitively (the registry stores lowercase)", async () => {
    expect(await isCommsSteward("FAKE001")).toBe(true);
    expect(h.frgFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: "external_affairs", cwid: "fake001", source: "manual" },
      }),
    );
  });

  it("additive: ED group members and allowlisted people keep access with no registry row", async () => {
    h.isGroupMember.mockImplementation(async (cn: string, cwid: string) =>
      cn === "comms-group" ? cwid === "grp0001" : cwid === "grp0002",
    );
    vi.stubEnv("SCHOLARS_COMMS_STEWARD_ALLOWLIST", "alw0001");
    vi.stubEnv("SCHOLARS_DEVELOPMENT_ALLOWLIST", "alw0002");
    expect(await isCommsSteward("grp0001")).toBe(true);
    expect(await isDeveloper("grp0002")).toBe(true);
    expect(await isCommsSteward("alw0001")).toBe(true);
    expect(await isDeveloper("alw0002")).toBe(true);
    expect(await isCommsSteward("nobody1")).toBe(false);
  });

  it("the role's own kill switch still wins over a registry grant", async () => {
    vi.stubEnv("COMMS_STEWARD_ENABLED", "off");
    vi.stubEnv("DEVELOPMENT_ENABLED", "off");
    expect(await isCommsSteward("fake001")).toBe(false);
    expect(await isDeveloper("fake002")).toBe(false);
    expect(h.frgFindMany).not.toHaveBeenCalled();
  });

  it("a registry grant admits even with the group cn unset", async () => {
    vi.stubEnv("SCHOLARS_COMMS_STEWARD_GROUP_CN", "");
    expect(await isCommsSteward("fake001")).toBe(true);
  });

  it("fail-closed: a failed registry read admits nobody, and the group path still runs", async () => {
    h.frgFindMany.mockRejectedValue(new Error("Table 'functional_role_grant' doesn't exist"));
    h.isGroupMember.mockResolvedValue(true);
    expect(await registryAdmitsExternalAffairs("fake001", "communications")).toBe(false);
    // The directory still decides; the failure never blocks an existing path.
    expect(await isCommsSteward("fake001")).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("functional_role_authz_read_failed"),
    );
  });

  it("a Reporting grant never confers an External Affairs function", async () => {
    registry([{ role: "reporting", cwid: "fake005", scopes: ["*"] }]);
    expect(await isCommsSteward("fake005")).toBe(false);
    expect(await isDeveloper("fake005")).toBe(false);
  });
});

describe("FUNCTIONAL_ROLES_AUTHZ on: Reporting", () => {
  beforeEach(() => {
    vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "on");
  });

  it("per scope: a sub-scope admits its bucket on its own report only", async () => {
    registry([{ role: "reporting", cwid: "fake006", scopes: ["mentored-publications:md"] }]);
    expect([...(await loadReportScopesForCwid("fake006", "mentored-publications"))]).toEqual([
      "md",
    ]);
    expect([...(await loadReportScopesForCwid("fake006", "article-count"))]).toEqual([]);
    expect(await hasAnyReportAccess("fake006")).toBe(true);
  });

  it("the wildcard or a bare report key admits the whole report", async () => {
    registry([
      { role: "reporting", cwid: "fake007", scopes: ["*"] },
      { role: "reporting", cwid: "fake008", scopes: ["article-count"] },
    ]);
    expect([...(await loadReportScopesForCwid("fake007", "high-impact-publications"))]).toEqual(["*"]);
    expect([...(await registryReportScopes("fake008", "article-count"))]).toEqual(["*"]);
    expect([...(await registryReportScopes("fake008", "high-impact-publications"))]).toEqual([]);
  });

  it("additive: report_access rows still count, and the registry only adds to them", async () => {
    h.reportAccessFindMany.mockResolvedValue([{ scopeKey: "ecr" }]);
    registry([{ role: "reporting", cwid: "fake009", scopes: ["mentored-publications:md"] }]);
    expect([...(await loadReportScopesForCwid("fake009", "mentored-publications"))].sort()).toEqual(
      ["ecr", "md"],
    );
    // A report_access holder with no registry row keeps exactly their scopes.
    registry([]);
    expect([...(await loadReportScopesForCwid("fake009", "mentored-publications"))]).toEqual([
      "ecr",
    ]);
    h.reportAccessFindMany.mockResolvedValue([{ cwid: "fake009" }]);
    expect(await hasAnyReportAccess("fake009")).toBe(true);
  });

  it("an External Affairs grant does not open reports", async () => {
    registry([EA_BOTH]);
    expect(await registryHasAnyReporting("fake003")).toBe(false);
    expect([...(await loadReportScopesForCwid("fake003", "article-count"))]).toEqual([]);
  });

  it("fail-closed: a failed registry read leaves the report_access verdict as it was", async () => {
    h.reportAccessFindMany.mockResolvedValue([{ scopeKey: "*" }]);
    h.frgFindMany.mockRejectedValue(new Error("down"));
    expect([...(await loadReportScopesForCwid("fake010", "article-count"))]).toEqual(["*"]);
    h.reportAccessFindMany.mockResolvedValue([]);
    expect(await hasAnyReportAccess("fake010")).toBe(false);
  });
});

describe("FUNCTIONAL_ROLES_AUTHZ on: imported rows never admit", () => {
  // An imported row mirrors a source (report_access, an allowlist) that is
  // reconciled only when a superuser re-runs the import. If it admitted, a
  // revoke at the source would not take effect until then.
  beforeEach(() => {
    vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "on");
  });

  it("the gate query asks for manual rows only", async () => {
    await registryHasAnyReporting("fake011");
    expect(h.frgFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: "reporting", cwid: "fake011", source: "manual" } }),
    );
  });

  it("a report_access revoke takes effect with a stale imported Reporting row left behind", async () => {
    // The Reports popover deleted the report_access row; the import has not
    // re-run, so the imported mirror row is still there.
    h.reportAccessFindMany.mockResolvedValue([]);
    registry([
      { role: "reporting", cwid: "fake012", scopes: ["article-count"], source: "report_access" },
    ]);
    expect([...(await loadReportScopesForCwid("fake012", "article-count"))]).toEqual([]);
    expect(await hasAnyReportAccess("fake012")).toBe(false);
    expect([...(await registryReportScopes("fake012", "article-count"))]).toEqual([]);
  });

  it("an allowlist removal takes effect with a stale imported External Affairs row left behind", async () => {
    // Allowlists are empty (beforeEach) and the directory says no; only the
    // imported "allowlist" mirror row remains.
    registry([
      {
        role: "external_affairs",
        cwid: "fake013",
        scopes: ["communications", "development"],
        source: "allowlist",
      },
    ]);
    expect(await isCommsSteward("fake013")).toBe(false);
    expect(await isDeveloper("fake013")).toBe(false);
  });

  it("a manual row beside an imported one still admits, from its own scopes only", async () => {
    registry([
      { role: "reporting", cwid: "fake014", scopes: ["*"], source: "report_access" },
      {
        role: "reporting",
        cwid: "fake014",
        scopes: ["mentored-publications:md"],
        source: "manual",
      },
    ]);
    expect([...(await loadReportScopesForCwid("fake014", "mentored-publications"))]).toEqual([
      "md",
    ]);
    expect([...(await loadReportScopesForCwid("fake014", "article-count"))]).toEqual([]);
  });
});
