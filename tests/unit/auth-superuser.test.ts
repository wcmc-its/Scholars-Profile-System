import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the two boundaries: the directory (so membership logic runs without an
// LDAP server) and B01's session reader (so these tests stay free of
// next/headers and the real session-server.ts `server-only` import).
vi.mock("@/lib/sources/ldap", () => ({
  openLdap: vi.fn(),
  DEFAULT_SEARCH_BASE: "ou=people,dc=weill,dc=cornell,dc=edu",
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(),
}));

import { getEditSession, isSuperuser } from "@/lib/auth/superuser";
import { openLdap } from "@/lib/sources/ldap";
import { getSession } from "@/lib/auth/session-server";

const GROUP_CN = "ITS:Library:Scholars/superuser-role";
const GROUPS_BASE = "ou=Groups,dc=weill,dc=cornell,dc=edu";

const mockedOpenLdap = vi.mocked(openLdap);
const mockedGetSession = vi.mocked(getSession);

const GROUP_DN = `cn=${GROUP_CN},ou=application security,${GROUPS_BASE}`;

type SearchImpl = (
  base: string,
  options: { scope: string; filter: string; attributes: string[] },
) => Promise<{ searchEntries: unknown[] }>;
type CompareImpl = (dn: string, attr: string, value: string) => Promise<boolean>;

/**
 * A stand-in ldapts client. Membership is a two-step: `search` resolves the group
 * DN by `cn`, then `compare` answers membership at that DN. `compare` defaults to
 * true, so `entries(1)` still reads as "the CWID is a member" and `entries(0)` as
 * "no such group" — both false-y outcomes for authorization.
 */
function fakeClient(search: SearchImpl, compare: CompareImpl = async () => true) {
  return {
    search: vi.fn(search),
    compare: vi.fn(compare),
    unbind: vi.fn(async (): Promise<void> => {}),
  };
}

/** Hand a fake client to the `openLdap` mock, which is typed to return a real Client. */
function asClient(c: ReturnType<typeof fakeClient>) {
  return c as unknown as Awaited<ReturnType<typeof openLdap>>;
}

/** A group-DN resolve result carrying `n` matching group entries. */
function entries(n: number): { searchEntries: unknown[] } {
  return {
    searchEntries: Array.from({ length: n }, () => ({ cn: GROUP_CN, dn: GROUP_DN })),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SCHOLARS_SUPERUSER_GROUP_CN = GROUP_CN;
  delete process.env.SCHOLARS_LDAP_SEARCH_BASE;
  delete process.env.SCHOLARS_SUPERUSER_CWIDS;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("isSuperuser", () => {
  it("is true when the group lists the CWID as a member", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(1))));
    expect(await isSuperuser("abc1234")).toBe(true);
  });

  it("is false when the group cn is not present in the directory", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(0))));
    expect(await isSuperuser("abc1234")).toBe(false);
  });

  it("is false when the group does not list the CWID (compare says no)", async () => {
    const client = fakeClient(
      async () => entries(1),
      async () => false,
    );
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isSuperuser("abc1234")).toBe(false);
  });

  it("resolves the group DN by cn ALONE — no `member` predicate in the search", async () => {
    const client = fakeClient(async () => entries(1));
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isSuperuser("abc1234");
    expect(client.search).toHaveBeenCalledWith(GROUPS_BASE, {
      scope: "sub",
      filter: `(cn=${GROUP_CN})`,
      attributes: ["cn"],
    });
    // Regression guard: a `member` predicate here makes the dynlist overlay
    // expand every dynamic group under ou=Groups — measured 20–30s timeouts.
    const [, options] = client.search.mock.calls[0];
    expect(options.filter).not.toContain("member");
  });

  it("asks the directory to compare `member` at the resolved group DN", async () => {
    const client = fakeClient(async () => entries(1));
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isSuperuser("abc1234");
    expect(client.compare).toHaveBeenCalledWith(
      GROUP_DN,
      "member",
      "uid=abc1234,ou=people,dc=weill,dc=cornell,dc=edu",
    );
  });

  it("fails closed on a CWID that is not DN-safe, before any directory work (injection guard)", async () => {
    const client = fakeClient(async () => entries(1));
    mockedOpenLdap.mockResolvedValue(asClient(client));
    // Membership is an LDAP `compare`, not a filter — an unsafe CWID is rejected
    // outright rather than escaped into a literal that matches nothing.
    expect(await isSuperuser("a*b)(uid=*")).toBe(false);
    expect(await isSuperuser("abc1234,ou=people,dc=x")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("unbinds the connection even when the search throws", async () => {
    const client = fakeClient(async () => {
      throw new Error("search exploded");
    });
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isSuperuser("abc1234")).toBe(false);
    expect(client.unbind).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the directory is unreachable", async () => {
    mockedOpenLdap.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await isSuperuser("abc1234")).toBe(false);
  });

  it("fails closed when the search errors", async () => {
    mockedOpenLdap.mockResolvedValue(
      asClient(
        fakeClient(async () => {
          throw new Error("LDAP timeout");
        }),
      ),
    );
    expect(await isSuperuser("abc1234")).toBe(false);
  });

  it("is false and never touches LDAP when the group cn is unset", async () => {
    delete process.env.SCHOLARS_SUPERUSER_GROUP_CN;
    expect(await isSuperuser("abc1234")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("is false and never touches LDAP for an empty CWID", async () => {
    expect(await isSuperuser("")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  // Interim allowlist (#443) — confers superuser without LDAP while the SPS VPC
  // has no route to the WCM directory.
  describe("SCHOLARS_SUPERUSER_CWIDS allowlist", () => {
    it("is true for a listed CWID without touching LDAP", async () => {
      process.env.SCHOLARS_SUPERUSER_CWIDS = "paa2013,drw2004,mrj4001";
      expect(await isSuperuser("drw2004")).toBe(true);
      expect(mockedOpenLdap).not.toHaveBeenCalled();
    });

    it("matches case-insensitively (assertion CWID casing varies)", async () => {
      process.env.SCHOLARS_SUPERUSER_CWIDS = "paa2013, drw2004 ,MRJ4001";
      expect(await isSuperuser("Mrj4001")).toBe(true);
      expect(await isSuperuser("PAA2013")).toBe(true);
      expect(mockedOpenLdap).not.toHaveBeenCalled();
    });

    it("falls through to the LDAP group check for a CWID not on the list", async () => {
      process.env.SCHOLARS_SUPERUSER_CWIDS = "paa2013";
      mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(1))));
      expect(await isSuperuser("abc1234")).toBe(true);
      expect(mockedOpenLdap).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when unset — behavior is the pure LDAP check", async () => {
      mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(0))));
      expect(await isSuperuser("abc1234")).toBe(false);
      expect(mockedOpenLdap).toHaveBeenCalledTimes(1);
    });

    it("does not grant a listed CWID when the value is blank/whitespace", async () => {
      process.env.SCHOLARS_SUPERUSER_CWIDS = " , ";
      mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(0))));
      expect(await isSuperuser("paa2013")).toBe(false);
    });
  });
});

describe("getEditSession", () => {
  it("is null when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    expect(await getEditSession()).toBeNull();
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("pairs the CWID with isSuperuser=true for a superuser", async () => {
    mockedGetSession.mockResolvedValue({ cwid: "adm1001", iat: 1, exp: 2 });
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(1))));
    expect(await getEditSession()).toEqual({
      cwid: "adm1001",
      isSuperuser: true,
      isCommsSteward: false,
      isDeveloper: false,
      isHonorsCurator: false,
    });
  });

  it("pairs the CWID with isSuperuser=false for a non-superuser", async () => {
    mockedGetSession.mockResolvedValue({ cwid: "usr2002", iat: 1, exp: 2 });
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(0))));
    expect(await getEditSession()).toEqual({
      cwid: "usr2002",
      isSuperuser: false,
      isCommsSteward: false,
      isDeveloper: false,
      isHonorsCurator: false,
    });
  });
});
