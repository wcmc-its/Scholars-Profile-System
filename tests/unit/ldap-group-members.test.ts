import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sources/ldap", () => ({
  openLdap: vi.fn(),
  DEFAULT_SEARCH_BASE: "ou=people,dc=weill,dc=cornell,dc=edu",
}));

import { listGroupMemberCwids, parseMemberUrl } from "@/lib/auth/ldap-group";
import { openLdap } from "@/lib/sources/ldap";

const PEOPLE = "ou=people,dc=weill,dc=cornell,dc=edu";
const url = (cwid: string) => `ldap:///uid=${cwid},${PEOPLE}??base?(objectClass=*)`;

describe("parseMemberUrl", () => {
  it("reads dn, scope and filter from the add-member.sh shape", () => {
    expect(parseMemberUrl(url("abc1234"))).toEqual({
      dn: `uid=abc1234,${PEOPLE}`,
      scope: "base",
      filter: "(objectClass=*)",
    });
  });
  it("reads a rule-based URL with an encoded filter", () => {
    expect(parseMemberUrl(`ldap:///${PEOPLE}??sub?(ou%3DLibrary)`)).toEqual({
      dn: PEOPLE,
      scope: "sub",
      filter: "(ou=Library)",
    });
  });
  it("rejects what isn't an LDAP URL", () => {
    expect(parseMemberUrl("uid=abc1234")).toBeNull();
    expect(parseMemberUrl("ldap:///")).toBeNull();
  });
});

describe("listGroupMemberCwids", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses uid URLs, runs rule-based ones, one connection, unreadable group = null", async () => {
    const search = vi.fn(async (base: string, opts: { filter: string }) => {
      if (opts.filter === "(cn=g1)")
        return { searchEntries: [{ memberURL: [url("Bbb2"), url("aaa1"), url("bad cwid!")] }] };
      if (opts.filter === "(cn=g2)")
        return { searchEntries: [{ memberURL: `ldap:///${PEOPLE}??sub?(ou=Library)` }] };
      if (opts.filter === "(cn=g3)") throw new Error("timeout");
      if (base === PEOPLE) return { searchEntries: [{ weillCornellEduCWID: "ccc3" }] };
      return { searchEntries: [] };
    });
    const unbind = vi.fn(async () => {});
    vi.mocked(openLdap).mockResolvedValue({ search, unbind } as never);
    const got = await listGroupMemberCwids(["g1", "g2", "g3", "g4"], () => {});
    expect(got.get("g1")).toEqual(["aaa1", "bbb2"]);
    expect(got.get("g2")).toEqual(["ccc3"]);
    expect(got.get("g3")).toBeNull();
    expect(got.get("g4")).toBeNull();
    expect(openLdap).toHaveBeenCalledTimes(1);
    expect(unbind).toHaveBeenCalledTimes(1);
  });

  it("directory down: every group unknown", async () => {
    vi.mocked(openLdap).mockRejectedValue(new Error("down"));
    const got = await listGroupMemberCwids(["g1"], () => {});
    expect(got.get("g1")).toBeNull();
  });
});
