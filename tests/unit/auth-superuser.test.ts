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

const GROUP_DN = "cn=scholars-admins,ou=groups,dc=weill,dc=cornell,dc=edu";
const PEOPLE_BASE = "ou=people,dc=weill,dc=cornell,dc=edu";

const mockedOpenLdap = vi.mocked(openLdap);
const mockedGetSession = vi.mocked(getSession);

type SearchImpl = (
  base: string,
  options: { scope: string; filter: string; attributes: string[] },
) => Promise<{ searchEntries: unknown[] }>;

/** A stand-in ldapts client whose membership `search` is scripted per test. */
function fakeClient(search: SearchImpl) {
  return { search: vi.fn(search), unbind: vi.fn(async (): Promise<void> => {}) };
}

/** Hand a fake client to the `openLdap` mock, which is typed to return a real Client. */
function asClient(c: ReturnType<typeof fakeClient>) {
  return c as unknown as Awaited<ReturnType<typeof openLdap>>;
}

/** A search result carrying `n` matching person entries. */
function entries(n: number): { searchEntries: unknown[] } {
  return { searchEntries: Array.from({ length: n }, (_, i) => ({ dn: `dn-${i}` })) };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SCHOLARS_ADMIN_GROUP_DN = GROUP_DN;
  delete process.env.SCHOLARS_LDAP_SEARCH_BASE;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("isSuperuser", () => {
  it("is true when the membership search returns an entry", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(1))));
    expect(await isSuperuser("abc1234")).toBe(true);
  });

  it("is false when the membership search returns no entry", async () => {
    // Covers both a non-member and a CWID with no directory entry — the
    // single `(&(uid=...)(memberOf=...))` filter yields nothing for either.
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(0))));
    expect(await isSuperuser("abc1234")).toBe(false);
  });

  it("queries the people base with a memberOf filter, asking for `dn` only", async () => {
    const client = fakeClient(async () => entries(1));
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isSuperuser("abc1234");
    expect(client.search).toHaveBeenCalledWith(PEOPLE_BASE, {
      scope: "sub",
      filter: `(&(uid=abc1234)(memberOf=${GROUP_DN}))`,
      attributes: ["dn"],
    });
  });

  it("escapes LDAP filter metacharacters in the CWID (injection guard)", async () => {
    const client = fakeClient(async () => entries(0));
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isSuperuser("a*b)(uid=*");
    expect(client.search).toHaveBeenCalledWith(
      PEOPLE_BASE,
      expect.objectContaining({
        filter: `(&(uid=a\\2ab\\29\\28uid=\\2a)(memberOf=${GROUP_DN}))`,
      }),
    );
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

  it("is false and never touches LDAP when the group DN is unset", async () => {
    delete process.env.SCHOLARS_ADMIN_GROUP_DN;
    expect(await isSuperuser("abc1234")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("is false and never touches LDAP for an empty CWID", async () => {
    expect(await isSuperuser("")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });
});

describe("getEditSession", () => {
  it("is null when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    expect(await getEditSession()).toBeNull();
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("pairs the CWID with isSuperuser=true for an admin", async () => {
    mockedGetSession.mockResolvedValue({ cwid: "adm1001", iat: 1, exp: 2 });
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(1))));
    expect(await getEditSession()).toEqual({ cwid: "adm1001", isSuperuser: true });
  });

  it("pairs the CWID with isSuperuser=false for a non-admin", async () => {
    mockedGetSession.mockResolvedValue({ cwid: "usr2002", iat: 1, exp: 2 });
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(0))));
    expect(await getEditSession()).toEqual({ cwid: "usr2002", isSuperuser: false });
  });
});
