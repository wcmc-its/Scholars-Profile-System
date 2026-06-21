import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the directory boundary so the membership logic runs without an LDAP
// server, exactly as auth-superuser.test.ts does.
vi.mock("@/lib/sources/ldap", () => ({
  openLdap: vi.fn(),
  DEFAULT_SEARCH_BASE: "ou=people,dc=weill,dc=cornell,dc=edu",
}));

import { isDeveloper, isDevelopmentEnabled } from "@/lib/auth/development";
import { openLdap } from "@/lib/sources/ldap";

const GROUP_CN = "ITS:Library:Scholars/development-role";
const GROUPS_BASE = "ou=Groups,dc=weill,dc=cornell,dc=edu";

const mockedOpenLdap = vi.mocked(openLdap);

type SearchImpl = (
  base: string,
  options: { scope: string; filter: string; attributes: string[] },
) => Promise<{ searchEntries: unknown[] }>;

function fakeClient(search: SearchImpl) {
  return { search: vi.fn(search), unbind: vi.fn(async (): Promise<void> => {}) };
}
function asClient(c: ReturnType<typeof fakeClient>) {
  return c as unknown as Awaited<ReturnType<typeof openLdap>>;
}
function entries(n: number): { searchEntries: unknown[] } {
  return { searchEntries: Array.from({ length: n }, () => ({ cn: GROUP_CN })) };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default to the role ENABLED with a group cn so the LDAP-path tests exercise
  // the directory branch; individual tests override the kill switch / allowlist.
  process.env.DEVELOPMENT_ENABLED = "on";
  process.env.SCHOLARS_DEVELOPMENT_GROUP_CN = GROUP_CN;
  delete process.env.SCHOLARS_DEVELOPMENT_ALLOWLIST;
  delete process.env.SCHOLARS_LDAP_SEARCH_BASE;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("isDevelopmentEnabled", () => {
  it("is true only when DEVELOPMENT_ENABLED is exactly 'on'", () => {
    process.env.DEVELOPMENT_ENABLED = "on";
    expect(isDevelopmentEnabled()).toBe(true);
    process.env.DEVELOPMENT_ENABLED = "off";
    expect(isDevelopmentEnabled()).toBe(false);
    process.env.DEVELOPMENT_ENABLED = "ON";
    expect(isDevelopmentEnabled()).toBe(false);
    delete process.env.DEVELOPMENT_ENABLED;
    expect(isDevelopmentEnabled()).toBe(false);
  });
});

describe("isDeveloper", () => {
  it("short-circuits to false (no LDAP) when the kill switch is off, even with an allowlist", async () => {
    process.env.DEVELOPMENT_ENABLED = "off";
    process.env.SCHOLARS_DEVELOPMENT_ALLOWLIST = "abc1234";
    expect(await isDeveloper("abc1234")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("is true for an allowlisted CWID without touching LDAP", async () => {
    process.env.SCHOLARS_DEVELOPMENT_ALLOWLIST = "paa2013, drw2004 ,MRJ4001";
    expect(await isDeveloper("drw2004")).toBe(true);
    expect(await isDeveloper("Mrj4001")).toBe(true); // case-insensitive
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("is true when the group lists the CWID as a member", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(1))));
    expect(await isDeveloper("abc1234")).toBe(true);
  });

  it("is false when the group does not list the CWID", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient(async () => entries(0))));
    expect(await isDeveloper("abc1234")).toBe(false);
  });

  it("searches ou=Groups for the group cn carrying the member DN, asking for `cn` only", async () => {
    const client = fakeClient(async () => entries(1));
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isDeveloper("abc1234");
    expect(client.search).toHaveBeenCalledWith(GROUPS_BASE, {
      scope: "sub",
      filter: `(&(cn=${GROUP_CN})(member=uid=abc1234,ou=people,dc=weill,dc=cornell,dc=edu))`,
      attributes: ["cn"],
    });
  });

  it("escapes LDAP filter metacharacters in the CWID (injection guard)", async () => {
    const client = fakeClient(async () => entries(0));
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isDeveloper("a*b)(uid=*");
    expect(client.search).toHaveBeenCalledWith(
      GROUPS_BASE,
      expect.objectContaining({
        filter: `(&(cn=${GROUP_CN})(member=uid=a\\2ab\\29\\28uid=\\2a,ou=people,dc=weill,dc=cornell,dc=edu))`,
      }),
    );
  });

  it("is false and never touches LDAP when the group cn is unset (and not allowlisted)", async () => {
    delete process.env.SCHOLARS_DEVELOPMENT_GROUP_CN;
    expect(await isDeveloper("abc1234")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("is false and never touches LDAP for an empty CWID", async () => {
    expect(await isDeveloper("")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("fails closed (and unbinds) when the search throws", async () => {
    const client = fakeClient(async () => {
      throw new Error("LDAP timeout");
    });
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isDeveloper("abc1234")).toBe(false);
    expect(client.unbind).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the directory is unreachable", async () => {
    mockedOpenLdap.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await isDeveloper("abc1234")).toBe(false);
  });
});
