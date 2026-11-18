/**
 * `lib/auth/research-security-viewer.ts` — the research security dashboard viewer role.
 *
 * Mirrors tests/unit/data-sharing-viewer.test.ts, which covers the same shape
 * (kill switch + group-DN resolve + LDAP `compare`, no allowlist) for the
 * sibling role this one is modelled on.
 *
 * Every case below is a fail-closed case. This role can unlock a dashboard
 * of sensitive per-person screening results, so a directory problem must never *grant* it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/sources/ldap", () => ({
  openLdap: vi.fn(),
  DEFAULT_SEARCH_BASE: "ou=people,dc=weill,dc=cornell,dc=edu",
}));

import { isResearchSecurityViewer, isResearchSecurityViewerEnabled } from "@/lib/auth/research-security-viewer";
import { openLdap } from "@/lib/sources/ldap";

// The real cn — see cdk/lib/app-stack.ts's SCHOLARS_RESEARCH_SECURITY_VIEWER_GROUP_CN.
const GROUP_CN = "ITS:Library:Scholars/research-security-viewer-role";
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
  process.env.RESEARCH_SECURITY_VIEWER_ENABLED = "on";
  process.env.SCHOLARS_RESEARCH_SECURITY_VIEWER_GROUP_CN = GROUP_CN;
  delete process.env.SCHOLARS_LDAP_SEARCH_BASE;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("isResearchSecurityViewerEnabled", () => {
  it("is true only when RESEARCH_SECURITY_VIEWER_ENABLED is exactly 'on'", () => {
    expect(isResearchSecurityViewerEnabled()).toBe(true);
    process.env.RESEARCH_SECURITY_VIEWER_ENABLED = "off";
    expect(isResearchSecurityViewerEnabled()).toBe(false);
    process.env.RESEARCH_SECURITY_VIEWER_ENABLED = "ON";
    expect(isResearchSecurityViewerEnabled()).toBe(false);
    delete process.env.RESEARCH_SECURITY_VIEWER_ENABLED;
    expect(isResearchSecurityViewerEnabled()).toBe(false);
  });
});

describe("isResearchSecurityViewer", () => {
  it("short-circuits to false (no LDAP) when the kill switch is off", async () => {
    process.env.RESEARCH_SECURITY_VIEWER_ENABLED = "off";
    expect(await isResearchSecurityViewer("abc1234")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("is true when the group lists the CWID as a member", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient({ compare: async () => true })));
    expect(await isResearchSecurityViewer("abc1234")).toBe(true);
  });

  it("is false when the group does not list the CWID", async () => {
    mockedOpenLdap.mockResolvedValue(asClient(fakeClient({ compare: async () => false })));
    expect(await isResearchSecurityViewer("abc1234")).toBe(false);
  });

  it("resolves the group DN by cn ALONE — no `member` predicate in the search", async () => {
    const client = fakeClient();
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isResearchSecurityViewer("abc1234");
    expect(client.search).toHaveBeenCalledWith(GROUPS_BASE, {
      scope: "sub",
      filter: `(cn=${GROUP_CN})`,
      attributes: ["cn"],
    });
    // Regression guard, same as every sibling role's: a `member` predicate here
    // makes the dynlist overlay expand every dynamic group under ou=Groups, which
    // timed out at 20–30s against the live directory.
    const [, options] = client.search.mock.calls[0];
    expect(options.filter).not.toContain("member");
  });

  it("asks the directory to compare `member` at the resolved group DN", async () => {
    const client = fakeClient();
    mockedOpenLdap.mockResolvedValue(asClient(client));
    await isResearchSecurityViewer("abc1234");
    expect(client.compare).toHaveBeenCalledWith(
      GROUP_DN,
      "member",
      "uid=abc1234,ou=people,dc=weill,dc=cornell,dc=edu",
    );
  });

  it("fails closed on a CWID that is not DN-safe, before any directory work", async () => {
    const client = fakeClient();
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isResearchSecurityViewer("a*b)(uid=*")).toBe(false);
    expect(await isResearchSecurityViewer("abc1234,ou=people,dc=x")).toBe(false);
    expect(client.compare).not.toHaveBeenCalled();
  });

  it("is dormant, not broken, when the group cn is unset (e.g. before the ED group exists)", async () => {
    delete process.env.SCHOLARS_RESEARCH_SECURITY_VIEWER_GROUP_CN;
    expect(await isResearchSecurityViewer("abc1234")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("is false and never touches LDAP for an empty CWID", async () => {
    expect(await isResearchSecurityViewer("")).toBe(false);
    expect(mockedOpenLdap).not.toHaveBeenCalled();
  });

  it("fails closed when the group cn is not present in the directory (e.g. an empty group)", async () => {
    const client = fakeClient({ search: async () => ({ searchEntries: [] }) });
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isResearchSecurityViewer("abc1234")).toBe(false);
    expect(client.compare).not.toHaveBeenCalled();
  });

  it("fails closed when the directory is unreachable", async () => {
    mockedOpenLdap.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await isResearchSecurityViewer("abc1234")).toBe(false);
  });

  it("fails closed (and unbinds) when the compare throws", async () => {
    const client = fakeClient({
      compare: async () => {
        throw new Error("LDAP timeout");
      },
    });
    mockedOpenLdap.mockResolvedValue(asClient(client));
    expect(await isResearchSecurityViewer("abc1234")).toBe(false);
    expect(client.unbind).toHaveBeenCalledTimes(1);
  });
});
