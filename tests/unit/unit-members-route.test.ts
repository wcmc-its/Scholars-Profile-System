/**
 * #974 Phase 2 / #2537 — GET /api/units/[kind]/[code]/members route.
 *
 * Asserts the validation/gate posture (flag-off 404, bad kind/code 400, the
 * `type=`/`method=` validation matrix, kind=center's method rejection) and
 * that valid input forwards (kind, code, filter, page) to the right loader.
 * The OR-within-facet filtering, type-only filtering, pagination, and
 * suppressed/sensitive exclusion are exercised against the real loaders in
 * unit-members-loader.test.ts; here both loaders are mocked so the route's
 * own contract is isolated.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetMembersFiltered, mockGetCenterMembersByType, mockFacetEnabled } = vi.hoisted(
  () => ({
    mockGetMembersFiltered: vi.fn(),
    mockGetCenterMembersByType: vi.fn(),
    mockFacetEnabled: vi.fn(),
  }),
);

vi.mock("@/lib/api/unit-members", () => ({
  getUnitMembersFiltered: (...args: unknown[]) => mockGetMembersFiltered(...args),
}));
vi.mock("@/lib/api/centers", () => ({
  getCenterMembersByType: (...args: unknown[]) => mockGetCenterMembersByType(...args),
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isOrgUnitMethodsFacetEnabled: () => mockFacetEnabled(),
}));

import { GET } from "@/app/api/units/[kind]/[code]/members/route";

function call(kind: string, code: string, query = "") {
  const url = `http://localhost/api/units/${kind}/${code}/members${query}`;
  return GET({ url } as never, {
    params: Promise.resolve({ kind, code }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFacetEnabled.mockReturnValue(true);
  mockGetMembersFiltered.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
  mockGetCenterMembersByType.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
});

describe("GET /api/units/[kind]/[code]/members", () => {
  it("404s when the facet flag is off (no loader called)", async () => {
    mockFacetEnabled.mockReturnValue(false);
    const res = await call("department", "N1140", "?method=sc::A");
    expect(res.status).toBe(404);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
    expect(mockGetCenterMembersByType).not.toHaveBeenCalled();
  });

  it("400s an unknown kind", async () => {
    const res = await call("program", "N1140", "?method=sc::A");
    expect(res.status).toBe(400);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
  });

  it("400s a malformed code", async () => {
    const res = await call("department", "bad code!", "?method=sc::A");
    expect(res.status).toBe(400);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
  });

  it("400s when neither method nor type is supplied (department/division)", async () => {
    const res = await call("department", "N1140");
    expect(res.status).toBe(400);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
  });

  it("400s when the only method key fails the sc::label regex and no type is given", async () => {
    const res = await call("department", "N1140", "?method=not-a-key");
    expect(res.status).toBe(400);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
  });

  it("400s type=All (client-only sentinel, not a server filter)", async () => {
    const res = await call("department", "N1140", "?type=All");
    expect(res.status).toBe(400);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
  });

  it("400s an unrecognized type value", async () => {
    const res = await call("department", "N1140", "?type=Bogus+Category");
    expect(res.status).toBe(400);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
  });

  it("400s a method param on kind=center — centers' method facet lives elsewhere", async () => {
    const res = await call("center", "MEYER", "?method=sc::A&type=Full-time+faculty");
    expect(res.status).toBe(400);
    expect(mockGetCenterMembersByType).not.toHaveBeenCalled();
  });

  it("400s kind=center with no type (method is the only other facet, and it's rejected)", async () => {
    const res = await call("center", "MEYER");
    expect(res.status).toBe(400);
    expect(mockGetCenterMembersByType).not.toHaveBeenCalled();
  });

  it("200s kind=center + a valid type, forwarding code/type/page to getCenterMembersByType", async () => {
    mockGetCenterMembersByType.mockResolvedValue({
      hits: [{ cwid: "abc12345", preferredName: "X" }],
      total: 1,
      page: 0,
      pageSize: 20,
    });
    const res = await call("center", "MEYER", "?type=Full-time+faculty&page=1");
    expect(res.status).toBe(200);
    const [code, roleGroup, page] = mockGetCenterMembersByType.mock.calls[0];
    expect(code).toBe("MEYER");
    expect(roleGroup).toBe("Full-time faculty");
    expect(page).toBe(1);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.hits[0].cwid).toBe("abc12345");
  });

  it("forwards kind/code/valid methods (OR set)/page to the loader; drops invalid keys", async () => {
    mockGetMembersFiltered.mockResolvedValue({
      hits: [{ cwid: "abc12345", preferredName: "X", topMethods: [] }],
      total: 1,
      page: 0,
      pageSize: 20,
    });
    const res = await call(
      "division",
      "N2466",
      "?method=imaging_x::Deep learning&method=imaging_x::Segmentation&method=BAD&page=2",
    );
    expect(res.status).toBe(200);
    const [kind, code, filter, page] = mockGetMembersFiltered.mock.calls[0];
    expect(kind).toBe("division");
    expect(code).toBe("N2466");
    // The two well-formed keys pass; "BAD" is dropped by METHOD_KEY_RE.
    expect(filter.methodKeys).toEqual(["imaging_x::Deep learning", "imaging_x::Segmentation"]);
    expect(filter.roleGroup).toBeUndefined();
    // page is 0-based for the loader (?page=2 → page index 2; route parses raw).
    expect(page).toBe(2);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.hits[0].cwid).toBe("abc12345");
  });

  it("forwards a type-only filter (no methods) to the loader", async () => {
    await call("department", "N1140", "?type=Doctoral+students");
    const [, , filter] = mockGetMembersFiltered.mock.calls[0];
    expect(filter).toEqual({ methodKeys: [], roleGroup: "Doctoral students" });
  });

  it("forwards a combined methods+type filter to the loader", async () => {
    await call("department", "N1140", "?method=sc::A&type=Affiliated+faculty");
    const [, , filter] = mockGetMembersFiltered.mock.calls[0];
    expect(filter).toEqual({ methodKeys: ["sc::A"], roleGroup: "Affiliated faculty" });
  });

  it("defaults page to 0 when absent", async () => {
    await call("department", "N1140", "?method=sc_x::A");
    expect(mockGetMembersFiltered.mock.calls[0][3]).toBe(0);
  });
});
