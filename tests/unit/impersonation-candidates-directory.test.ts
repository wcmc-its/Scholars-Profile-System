/**
 * GET /api/impersonation/candidates — directory name search. A global-role
 * holder with no Scholar row (and no enumerable LDAP group) is found by
 * searching ED by name and asking `resolveGlobalRole` about each hit. The
 * directory is fail-soft: an LDAP failure still returns the scholar results.
 * Fake CWIDs and names only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  scholarFindMany,
  unitAdminFindMany,
  searchDirectory,
  resolveGlobalRole,
  superusersAmong,
  proxyFindMany,
  fetchByCwid,
} = vi.hoisted(() => ({
    proxyFindMany: vi.fn(),
    fetchByCwid: vi.fn(),
    scholarFindMany: vi.fn(),
    unitAdminFindMany: vi.fn(),
    searchDirectory: vi.fn(),
    resolveGlobalRole: vi.fn(),
    superusersAmong: vi.fn(),
  }));

vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => ({ cwid: "su001", iat: 0, exp: 0 })),
}));
vi.mock("@/lib/auth/effective-identity", () => ({ canImpersonate: vi.fn(async () => true) }));
vi.mock("@/lib/auth/superuser", () => ({ superusersAmong }));
vi.mock("@/lib/auth/comms-steward", () => ({ listCommsStewardCwids: () => [] }));
vi.mock("@/lib/auth/global-roles", () => ({ resolveGlobalRole }));
vi.mock("@/lib/sources/ldap", () => ({
  searchDirectoryPeopleByName: searchDirectory,
  fetchDirectoryPeopleByCwid: fetchByCwid,
}));
vi.mock("@/lib/db", () => {
  const none = { findMany: vi.fn(async () => []) };
  return {
    db: {
      read: {
        scholar: { findMany: scholarFindMany },
        unitAdmin: { findMany: unitAdminFindMany },
        department: none,
        division: none,
        center: none,
        core: none,
        stewardDirectory: none,
        scholarProxy: { findMany: proxyFindMany },
      },
    },
  };
});

import { GET } from "@/app/api/impersonation/candidates/route";

const get = (qs: string) =>
  GET(new NextRequest(`http://localhost/api/impersonation/candidates?${qs}`));

function edPerson(cwid: string, first: string, last: string) {
  return {
    cwid,
    name: `${last}, ${first}`,
    title: null,
    dept: null,
    firstName: first,
    lastName: last,
    email: null,
  };
}

const SCHOLAR = {
  cwid: "sch0001",
  preferredName: "Pat Example",
  slug: "pat-example",
  department: { name: "Medicine" },
  division: null,
};

beforeEach(() => {
  vi.stubEnv("IMPERSONATION_ENABLED", "true");
  // The scholar pass returns SCHOLAR for a name search; the profile check for
  // ED hits (`cwid: { in }`) finds only the cwids that have a Scholar row.
  scholarFindMany.mockReset().mockImplementation(async (args: { where: { cwid?: unknown } }) => {
    const inList = (args.where.cwid as { in?: string[] } | undefined)?.in;
    if (inList) return inList.filter((c) => c === "sch0001").map((cwid) => ({ cwid }));
    return [SCHOLAR];
  });
  unitAdminFindMany.mockReset().mockResolvedValue([]);
  searchDirectory.mockReset().mockResolvedValue([]);
  resolveGlobalRole.mockReset().mockResolvedValue(null);
  superusersAmong.mockReset().mockResolvedValue(new Set<string>());
  proxyFindMany.mockReset().mockResolvedValue([]);
  fetchByCwid.mockReset().mockResolvedValue([]);
});

describe("candidates route — directory name search", () => {
  it("includes an ED-only global-role holder found by name, labelled with the role", async () => {
    searchDirectory.mockResolvedValue([
      edPerson("glb0001", "Pat", "Curatorson"),
      edPerson("nob0002", "Pat", "Nobody"),
    ]);
    resolveGlobalRole.mockImplementation(async (c: string) =>
      c === "glb0001" ? "honors_curator" : null,
    );

    const rows = await (await get("q=pat")).json();

    expect(searchDirectory).toHaveBeenCalledWith("pat", expect.any(Number));
    expect(rows).toEqual([
      expect.objectContaining({ cwid: "sch0001", role: "scholar" }),
      {
        cwid: "glb0001",
        preferredName: "Pat Curatorson",
        slug: null,
        role: "honors_curator",
        unitKind: null,
        unit: null,
      },
    ]);
    // A directory hit with no role is not offered.
    expect(rows.some((r: { cwid: string }) => r.cwid === "nob0002")).toBe(false);
  });

  it("does not role-check a directory hit that has a Scholar row", async () => {
    searchDirectory.mockResolvedValue([
      edPerson("sch0001", "Pat", "Example"),
      edPerson("glb0001", "Pat", "Curatorson"),
    ]);
    resolveGlobalRole.mockResolvedValue("observer");

    await get("q=pat");

    expect(resolveGlobalRole.mock.calls.map((c) => c[0])).toEqual(["glb0001"]);
  });

  it("drops a superuser global-role holder (R2)", async () => {
    searchDirectory.mockResolvedValue([edPerson("glb0001", "Pat", "Curatorson")]);
    resolveGlobalRole.mockResolvedValue("development");
    superusersAmong.mockImplementation(
      async (cwids: string[]) => new Set(cwids.filter((c) => c === "glb0001")),
    );

    const rows = await (await get("q=pat")).json();

    expect(rows.map((r: { cwid: string }) => r.cwid)).toEqual(["sch0001"]);
  });

  it("finds a profile-less unit admin by directory name when granteeName is empty", async () => {
    searchDirectory.mockResolvedValue([edPerson("adm0001", "Pat", "Admin")]);
    unitAdminFindMany.mockResolvedValue([
      { cwid: "adm0001", granteeName: null, entityType: "department", entityId: "D1", role: "curator" },
    ]);

    const rows = await (await get("q=pat")).json();

    const where = unitAdminFindMany.mock.calls.at(-1)![0].where;
    expect(where.OR).toContainEqual({ cwid: { in: ["adm0001"] } });
    expect(rows).toContainEqual(
      expect.objectContaining({ cwid: "adm0001", preferredName: "Pat Admin", role: "curator" }),
    );
  });

  it("an LDAP failure still returns the scholar results", async () => {
    searchDirectory.mockRejectedValue(new Error("SCHOLARS_LDAP_URL is not set"));

    const res = await get("q=pat");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([expect.objectContaining({ cwid: "sch0001" })]);
    expect(resolveGlobalRole).not.toHaveBeenCalled();
  });

  it("a hung directory search is abandoned and the scholar results still return", async () => {
    vi.useFakeTimers();
    try {
      searchDirectory.mockReturnValue(new Promise(() => {}));
      const pending = get("q=pat");
      await vi.advanceTimersByTimeAsync(5_000);
      const rows = await (await pending).json();
      expect(rows).toEqual([expect.objectContaining({ cwid: "sch0001" })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not search the directory for a CWID-shaped query", async () => {
    await get("q=abc1234");
    expect(searchDirectory).not.toHaveBeenCalled();
  });

  it("offers global-role holders only under the People (all) view", async () => {
    searchDirectory.mockResolvedValue([edPerson("glb0001", "Pat", "Curatorson")]);
    resolveGlobalRole.mockResolvedValue("observer");

    const rows = await (await get("kind=unit&q=pat")).json();

    expect(resolveGlobalRole).not.toHaveBeenCalled();
    expect(rows.some((r: { cwid: string }) => r.cwid === "glb0001")).toBe(false);
  });
});

describe("candidates route — proxy editors", () => {
  it("finds a profile-less proxy editor by directory name, labelled proxy", async () => {
    searchDirectory.mockResolvedValueOnce([edPerson("prx0001", "Pat", "Proxy")]);
    proxyFindMany.mockResolvedValueOnce([{ proxyCwid: "prx0001" }]);
    const rows = await (await get("kind=all&q=proxy")).json();
    const hit = rows.find((r: { cwid: string }) => r.cwid === "prx0001");
    expect(hit).toMatchObject({ role: "proxy", slug: null });
    expect(hit.preferredName).not.toBe("prx0001");
  });

  it("finds a proxy editor by exact CWID and resolves their name from the directory", async () => {
    scholarFindMany.mockResolvedValue([]);
    proxyFindMany.mockResolvedValueOnce([{ proxyCwid: "prx0001" }]);
    fetchByCwid.mockResolvedValueOnce([edPerson("prx0001", "Pat", "Proxy")]);
    const rows = await (await get("kind=all&q=prx0001")).json();
    expect(proxyFindMany.mock.calls[0][0].where).toEqual({ proxyCwid: { in: ["prx0001"] } });
    expect(rows).toEqual([expect.objectContaining({ cwid: "prx0001", role: "proxy" })]);
    expect(rows[0].preferredName).toMatch(/Pat/);
  });

  it("drops a superuser proxy (R2)", async () => {
    scholarFindMany.mockResolvedValue([]);
    proxyFindMany.mockResolvedValueOnce([{ proxyCwid: "prx0001" }]);
    superusersAmong.mockResolvedValue(new Set(["prx0001"]));
    const rows = await (await get("kind=all&q=prx0001")).json();
    expect(rows).toEqual([]);
  });
});
