/**
 * `lib/auth/honors-curator.ts` — the #1762 approval role.
 *
 * Mirrors tests/unit/development.test.ts, which covers the same two-step
 * (resolve group DN by cn, then LDAP `compare`) for the sibling role. The
 * allowlist cases have no counterpart here: this role deliberately ships without
 * one — see the module docblock.
 *
 * Every case below is a fail-closed case. This role can publish an honor onto any
 * of ~8,700 public profiles, so a directory problem must never *grant* it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/sources/ldap", () => ({
  openLdap: vi.fn(),
  DEFAULT_SEARCH_BASE: "ou=people,dc=weill,dc=cornell,dc=edu",
}));

import { isHonorsCurator, isHonorsCuratorEnabled } from "@/lib/auth/honors-curator";
import { openLdap } from "@/lib/sources/ldap";

// The real cn, verified in the directory by an in-VPC probe on 2026-07-17.
const GROUP_CN = "ITS:Library:Scholars/honors-curator-role";
const GROUPS_BASE = "ou=Groups,dc=weill,dc=cornell,dc=edu";
const GROUP_DN = `cn=${GROUP_CN},ou=application security,${GROUPS_BASE}`;

const mockedOpenLdap = vi.mocked(openLdap);

type SearchImpl = (
  base: string,
  options: { scope: string; filter: string; attributes: string[] },
) => Promise<{ searchEntries: unknown[] }>;
type CompareImpl = (dn: string, attr: string, value: string) => Promise<boolean>;

function fakeClient(opts: { search?: SearchImpl; compare?: CompareImpl } = {}) {
  return {
    search: vi.fn(opts.search ?? (async () => ({ searchEntries: [{ cn: GROUP_CN, dn: GROUP_DN }] }))),
    compare: vi.fn(opts.compare ?? (async () => true)),
    unbind: vi.fn(async (): Promise<void> => {}),
  };
}
function asClient(c: ReturnType<typeof fakeClient>) {
  return c as unknown as Awaited<ReturnType<typeof openLdap>>;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.HONORS_CURATOR_ENABLED = "on";
  process.env.SCHOLARS_HONORS_CURATOR_GROUP_CN = GROUP_CN;
  delete process.env.SCHOLARS_LDAP_SEARCH_BASE;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("isHonorsCuratorEnabled", () => {
  it("is true only when HONORS_CURATOR_ENABLED is exactly 'on'", () => {
    expect(isHonorsCuratorEnabled()).toBe(true);
    process.env.HONORS_CURATOR_ENABLED = "off";
    expect(isHonorsCuratorEnabled()).toBe(false);
    process.env.HONORS_CURATOR_ENABLED = "ON";
    expect(isHonorsCuratorEnabled()).toBe(false);
    delete process.env.HONORS_CURATOR_ENABLED;
    expect(isHonorsCuratorEnabled()).toBe(false);
  });
});

describe("isHonorsCurator", () => {
  it("short-circuits to false (no LDAP) when the kill switch is off", async () => {
    process.env.HONORS_CURATOR_ENABLED = "off";
    expect(await isHonorsCurator("abc1234")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("is true when the group lists the CWID as a member", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient({ compare: async () => true })));
    expect(await isHonorsCurator("abc1234")).toBe(true);
  });

  it("is false when the group does not list the CWID", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient({ compare: async () => false })));
    expect(await isHonorsCurator("abc1234")).toBe(false);
  });

  it("resolves the group DN by cn ALONE — no `member` predicate in the search", async () => {
    const client = fakeClient();
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isHonorsCurator("abc1234");
    expect(client.search).toHaveBeenCalledWith(GROUPS_BASE, {
      scope: "sub",
      filter: `(cn=${GROUP_CN})`,
      attributes: ["cn"],
    });
    // Regression guard, same as the development role's: a `member` predicate here
    // makes the dynlist overlay expand every dynamic group under ou=Groups, which
    // timed out at 20–30s against the live directory.
    const [, options] = client.search.mock.calls[0];
    expect(options.filter).not.toContain("member");
  });

  it("asks the directory to compare `member` at the resolved group DN", async () => {
    const client = fakeClient();
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isHonorsCurator("abc1234");
    expect(client.compare).toHaveBeenCalledWith(
      GROUP_DN,
      "member",
      "uid=abc1234,ou=people,dc=weill,dc=cornell,dc=edu",
    );
  });

  it("fails closed on a CWID that is not DN-safe, before any directory work", async () => {
    const client = fakeClient();
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isHonorsCurator("a*b)(uid=*")).toBe(false);
    expect(await isHonorsCurator("abc1234,ou=people,dc=x")).toBe(false);
    expect(client.compare).not.toHaveBeenCalled();
  });

  it("is dormant, not broken, when the group cn is unset", async () => {
    delete process.env.SCHOLARS_HONORS_CURATOR_GROUP_CN;
    expect(await isHonorsCurator("abc1234")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("is false and never touches LDAP for an empty CWID", async () => {
    expect(await isHonorsCurator("")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("fails closed when the group cn is not present in the directory", async () => {
    const client = fakeClient({ search: async () => ({ searchEntries: [] }) });
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isHonorsCurator("abc1234")).toBe(false);
    expect(client.compare).not.toHaveBeenCalled();
  });

  it("fails closed when the directory is unreachable", async () => {
    mockedOpenLdap.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await isHonorsCurator("abc1234")).toBe(false);
  });

  it("fails closed (and unbinds) when the compare throws", async () => {
    const client = fakeClient({
      compare: async () => {
        throw new Error("LDAP timeout");
      },
    });
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isHonorsCurator("abc1234")).toBe(false);
    expect(client.unbind).toHaveBeenCalledTimes(1);
  });
});
