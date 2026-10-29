// @vitest-environment node
/**
 * The Cores director functional role (`core_director`): Owner of every core,
 * current and future, plus the all-cores report roll-up.
 *
 *   - `isCoreDirector` reads ONLY a manual `core_director` registry row, only
 *     with `FUNCTIONAL_ROLES_AUTHZ` "on", and fails closed;
 *   - `getEffectiveEditSession` resolves it for the EFFECTIVE cwid, so "View
 *     as" carries the target's verdict, never the real user's;
 *   - the gates read the session flag: `getCoreOwnerRole` / `getFlatUnitRole`
 *     answer "owner" for any core, `canViewAllCores` admits the holder, and the
 *     unit listings enumerate every core.
 *
 * `@/lib/db`, the LDAP compare and the session reader are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  frgFindMany: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: { functionalRoleGrant: { findMany: h.frgFindMany } },
    write: {},
  },
}));
vi.mock("@/lib/auth/ldap-group", () => ({
  isGroupMember: vi.fn().mockResolvedValue(false),
  groupMembersAmong: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.getSession }));

import { isCoreDirector } from "@/lib/auth/core-director";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import type { EditSession } from "@/lib/auth/superuser";
import { loadOwnerManagedUnitScope, type OwnerScopeClient } from "@/lib/edit/administrators";
import {
  authorizeCoreClaim,
  canGrant,
  getCoreOwnerRole,
  getFlatUnitRole,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";
import { canViewAllCores } from "@/lib/edit/core-report-common";
import { loadManageableUnits, type ManageableUnitsClient } from "@/lib/edit/manageable-units";
import { NOW, sessionAs } from "@/tests/util/session-as";

type GrantRow = { role: string; cwid: string; scopes: string[]; source?: string };

/** The registry; `findMany({ where: { role, cwid, source } })` filters it the
 *  way MySQL would. A row with no `source` is "manual". */
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

const DIRECTOR = "dir0001";
const DIRECTOR_ROW: GrantRow = { role: "core_director", cwid: DIRECTOR, scopes: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "on");
  vi.stubEnv("SCHOLARS_SUPERUSER_CWIDS", "");
  registry([DIRECTOR_ROW]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isCoreDirector", () => {
  it("a manual core_director row admits the holder (cwid matched case-insensitively)", async () => {
    expect(await isCoreDirector(DIRECTOR)).toBe(true);
    expect(await isCoreDirector(DIRECTOR.toUpperCase())).toBe(true);
    expect(h.frgFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: "core_director", cwid: DIRECTOR, source: "manual" },
      }),
    );
  });

  it("nobody else, and no other role's grant, makes a director", async () => {
    registry([
      DIRECTOR_ROW,
      { role: "reporting", cwid: "rep0001", scopes: ["*"] },
      { role: "external_affairs", cwid: "ea00001", scopes: ["communications"] },
    ]);
    expect(await isCoreDirector("rep0001")).toBe(false);
    expect(await isCoreDirector("ea00001")).toBe(false);
    expect(await isCoreDirector("")).toBe(false);
  });

  it("an imported (non-manual) row admits nobody", async () => {
    registry([{ ...DIRECTOR_ROW, source: "allowlist" }]);
    expect(await isCoreDirector(DIRECTOR)).toBe(false);
  });

  it("flag off: grants nothing and never reads the registry", async () => {
    vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "off");
    expect(await isCoreDirector(DIRECTOR)).toBe(false);
    vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "");
    expect(await isCoreDirector(DIRECTOR)).toBe(false);
    expect(h.frgFindMany).not.toHaveBeenCalled();
  });

  it("a failed read fails closed", async () => {
    h.frgFindMany.mockRejectedValue(new Error("table missing"));
    expect(await isCoreDirector(DIRECTOR)).toBe(false);
  });
});

describe("getEffectiveEditSession: the director verdict follows the EFFECTIVE cwid", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    vi.stubEnv("IMPERSONATION_ENABLED", "true");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a director signed in as themselves is a director", async () => {
    h.getSession.mockResolvedValue({ cwid: DIRECTOR, iat: NOW, exp: NOW + 3600 });
    expect((await getEffectiveEditSession())?.isCoreDirector).toBe(true);
  });

  it("viewing as a director carries the TARGET's verdict", async () => {
    h.getSession.mockResolvedValue(sessionAs(DIRECTOR));
    const s = await getEffectiveEditSession();
    expect(s?.cwid).toBe(DIRECTOR);
    expect(s?.isCoreDirector).toBe(true);
  });

  it("a director viewing as a non-director loses it for the duration", async () => {
    h.getSession.mockResolvedValue({ ...sessionAs("schol001"), cwid: DIRECTOR });
    const s = await getEffectiveEditSession();
    expect(s?.cwid).toBe("schol001");
    expect(s?.isCoreDirector).toBe(false);
  });

  it("flag off: nobody is a director, even the holder", async () => {
    vi.stubEnv("FUNCTIONAL_ROLES_AUTHZ", "off");
    h.getSession.mockResolvedValue({ cwid: DIRECTOR, iat: NOW, exp: NOW + 3600 });
    expect((await getEffectiveEditSession())?.isCoreDirector).toBe(false);
  });
});

const DIRECTOR_SESSION: EditSession = {
  cwid: DIRECTOR,
  isSuperuser: false,
  isCommsSteward: false,
  isCoreDirector: true,
};
const PLAIN: EditSession = { cwid: "usr0001", isSuperuser: false, isCommsSteward: false };
const SUPER: EditSession = { cwid: "sup0001", isSuperuser: true, isCommsSteward: false };
const STEWARD: EditSession = { cwid: "stw0001", isSuperuser: false, isCommsSteward: true };

function coreLookup(role: "owner" | "curator" | null) {
  const findUnique = vi.fn(async () => (role ? { role } : null));
  return { lookup: { unitAdmin: { findUnique } } as CoreOwnerLookup, findUnique };
}

describe("core ownership gates", () => {
  it("getCoreOwnerRole: a director owns ANY core, with no per-core row and no lookup", async () => {
    const { lookup, findUnique } = coreLookup(null);
    expect(await getCoreOwnerRole(DIRECTOR_SESSION, "2", lookup)).toBe("owner");
    expect(await getCoreOwnerRole(DIRECTOR_SESSION, "a-core-added-tomorrow", lookup)).toBe("owner");
    expect(findUnique).not.toHaveBeenCalled();
    // ...which every core-gated caller turns into an allow, and an owner may
    // grant on the core (`/api/edit/grant`'s core branch reads getFlatUnitRole).
    expect(authorizeCoreClaim(DIRECTOR_SESSION, "owner").ok).toBe(true);
    expect(
      canGrant(
        DIRECTOR_SESSION,
        await getFlatUnitRole(DIRECTOR_SESSION, "core", "2", lookup),
        "owner",
      ).ok,
    ).toBe(true);
  });

  it("a curator row does not narrow a director", async () => {
    const { lookup } = coreLookup("curator");
    expect(await getCoreOwnerRole(DIRECTOR_SESSION, "2", lookup)).toBe("owner");
  });

  it("non-directors are unchanged: the unit_admin row decides", async () => {
    expect(await getCoreOwnerRole(PLAIN, "2", coreLookup(null).lookup)).toBe("none");
    expect(await getCoreOwnerRole(PLAIN, "2", coreLookup("curator").lookup)).toBe("curator");
    expect(
      await getCoreOwnerRole({ ...PLAIN, isCoreDirector: false }, "2", coreLookup(null).lookup),
    ).toBe("none");
  });

  it("the role is about cores only: an institution still needs its own row", async () => {
    expect(
      await getFlatUnitRole(DIRECTOR_SESSION, "institution", "WCM", coreLookup(null).lookup),
    ).toBe("none");
  });

  it("canViewAllCores: superuser or director; not a steward, not a plain user", () => {
    expect(canViewAllCores(SUPER)).toBe(true);
    expect(canViewAllCores(DIRECTOR_SESSION)).toBe(true);
    expect(canViewAllCores(STEWARD)).toBe(false);
    expect(canViewAllCores(PLAIN)).toBe(false);
    expect(canViewAllCores({ ...PLAIN, isCoreDirector: false })).toBe(false);
  });
});

describe("unit listings enumerate every core for a director", () => {
  const CORES = [
    { id: "1", name: "Flow Cytometry" },
    { id: "2", name: "Genomics" },
  ];

  function unitsClient(grants: Array<{ entityType: string; entityId: string; role: string }>) {
    return {
      unitAdmin: { findMany: vi.fn(async () => grants) },
      department: { findMany: vi.fn(async () => []) },
      division: { findMany: vi.fn(async () => []) },
      center: { findMany: vi.fn(async () => []) },
      core: {
        findMany: vi.fn(async (args: { where?: { id: { in: string[] } } }) =>
          args.where ? CORES.filter((c) => args.where!.id.in.includes(c.id)) : CORES,
        ),
      },
    };
  }

  it("loadManageableUnits({ allCores }): every core as Owner, overriding a curator grant", async () => {
    const client = unitsClient([{ entityType: "core", entityId: "2", role: "curator" }]);
    const units = await loadManageableUnits(DIRECTOR, client as unknown as ManageableUnitsClient, {
      allCores: true,
    });
    expect(units.cores.map((u) => [u.code, u.role, u.href])).toEqual([
      ["1", "owner", "/edit/core/1"],
      ["2", "owner", "/edit/core/2"],
    ]);
    expect(units.total).toBe(2);
  });

  it("loadManageableUnits without allCores is unchanged (no extra core read)", async () => {
    const client = unitsClient([]);
    const units = await loadManageableUnits("usr0001", client as unknown as ManageableUnitsClient);
    expect(units.total).toBe(0);
    expect(client.core.findMany).not.toHaveBeenCalled();
  });

  it("loadOwnerManagedUnitScope: a director's scope is every core id", async () => {
    const client = {
      unitAdmin: { findMany: vi.fn(async () => []) },
      division: { findMany: vi.fn(async () => []) },
      core: { findMany: vi.fn(async () => CORES.map((c) => ({ id: c.id }))) },
    };
    expect(
      (
        await loadOwnerManagedUnitScope(DIRECTOR_SESSION, client as unknown as OwnerScopeClient)
      ).sort(),
    ).toEqual(["1", "2"]);
    expect(await loadOwnerManagedUnitScope(PLAIN, client as unknown as OwnerScopeClient)).toEqual(
      [],
    );
  });
});
