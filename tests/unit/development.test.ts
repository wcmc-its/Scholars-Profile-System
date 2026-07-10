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

const GROUP_DN = `cn=${GROUP_CN},ou=application security,${GROUPS_BASE}`;

type SearchImpl = (
  base: string,
  options: { scope: string; filter: string; attributes: string[] },
) => Promise<{ searchEntries: unknown[] }>;
type CompareImpl = (dn: string, attr: string, value: string) => Promise<boolean>;

/**
 * The membership check is a two-step: resolve the group DN by `cn`, then an LDAP
 * `compare` at that DN. Defaults mirror the live directory — the group resolves,
 * and `compare` decides membership.
 */
function fakeClient(opts: { search?: SearchImpl; compare?: CompareImpl } = {}) {
  return {
    search: vi.fn(opts.search ?? (async () => groupFound())),
    compare: vi.fn(opts.compare ?? (async () => true)),
    unbind: vi.fn(async (): Promise<void> => {}),
  };
}
function asClient(c: ReturnType<typeof fakeClient>) {
  return c as unknown as Awaited<ReturnType<typeof openLdap>>;
}
/** The group-DN resolve step's result: found (1 entry) or not (0). */
function groupFound(): { searchEntries: unknown[] } {
  return { searchEntries: [{ cn: GROUP_CN, dn: GROUP_DN }] };
}
function groupMissing(): { searchEntries: unknown[] } {
  return { searchEntries: [] };
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
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient({ compare: async () => true })));
    expect(await isDeveloper("abc1234")).toBe(true);
  });

  it("is false when the group does not list the CWID", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient({ compare: async () => false })));
    expect(await isDeveloper("abc1234")).toBe(false);
  });

  it("resolves the group DN by cn ALONE — no `member` predicate in the search", async () => {
    const client = fakeClient();
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isDeveloper("abc1234");
    expect(client.search).toHaveBeenCalledWith(GROUPS_BASE, {
      scope: "sub",
      filter: `(cn=${GROUP_CN})`,
      attributes: ["cn"],
    });
    // Regression guard: a `member` predicate in a subtree search forces the
    // dynlist overlay to expand every dynamic group under ou=Groups, which
    // timed out (20–30s) against the live directory.
    const [, options] = client.search.mock.calls[0];
    expect(options.filter).not.toContain("member");
  });

  it("asks the directory to compare `member` at the resolved group DN", async () => {
    const client = fakeClient();
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isDeveloper("abc1234");
    expect(client.compare).toHaveBeenCalledWith(
      GROUP_DN,
      "member",
      "uid=abc1234,ou=people,dc=weill,dc=cornell,dc=edu",
    );
  });

  it("fails closed on a CWID that is not DN-safe, before any directory work (injection guard)", async () => {
    const client = fakeClient();
    mockedOpenLdap.mockResolvedValue(asClient(client));
    // The membership question is an LDAP `compare`, not a filter, so escaping is
    // the wrong tool — an unsafe CWID is rejected outright instead.
    expect(await isDeveloper("a*b)(uid=*")).toBe(false);
    expect(await isDeveloper("abc1234,ou=people,dc=x")).toBe(false);
    expect(client.compare).not.toHaveBeenCalled();
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("fails closed when the group cn is not present in the directory", async () => {
    const client = fakeClient({ search: async () => groupMissing() });
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isDeveloper("abc1234")).toBe(false);
    expect(client.compare).not.toHaveBeenCalled();
    expect(client.unbind).toHaveBeenCalledTimes(1);
  });

  it("fails closed (and unbinds) when the compare throws", async () => {
    const client = fakeClient({
      compare: async () => {
        throw new Error("LDAP timeout");
      },
    });
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isDeveloper("abc1234")).toBe(false);
    expect(client.unbind).toHaveBeenCalledTimes(1);
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
    const client = fakeClient({
      search: async () => {
        throw new Error("LDAP timeout");
      },
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
