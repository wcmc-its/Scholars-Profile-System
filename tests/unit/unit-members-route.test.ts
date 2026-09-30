/**
 * #974 Phase 2 / #2537 — GET /api/units/[kind]/[code]/members route.
 *
 * Asserts the validation/gate posture (flag-off 404 for `method=`/`div=` only,
 * bad kind/code 400, the `type=`/`method=`/`sort=`/`q=` validation matrix,
 * kind=center's method rejection) and that valid input forwards (kind, code,
 * filter, page) to the right loader.
 * The OR-within-facet filtering, type-only filtering, pagination, and
 * suppressed/sensitive exclusion are exercised against the real loaders in
 * unit-members-loader.test.ts; here both loaders are mocked so the route's
 * own contract is isolated.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetMembersFiltered, mockGetCenterMembersFiltered, mockFacetEnabled } = vi.hoisted(
  () => ({
    mockGetMembersFiltered: vi.fn(),
    mockGetCenterMembersFiltered: vi.fn(),
    mockFacetEnabled: vi.fn(),
  }),
);

vi.mock("@/lib/api/unit-members", () => ({
  getUnitMembersFiltered: (...args: unknown[]) => mockGetMembersFiltered(...args),
}));
vi.mock("@/lib/api/centers", () => ({
  getCenterMembersFiltered: (...args: unknown[]) => mockGetCenterMembersFiltered(...args),
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
  mockGetCenterMembersFiltered.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
});

describe("GET /api/units/[kind]/[code]/members", () => {
  it("404s when the facet flag is off (no loader called)", async () => {
    mockFacetEnabled.mockReturnValue(false);
    const res = await call("department", "N1140", "?method=sc::A");
    expect(res.status).toBe(404);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
    expect(mockGetCenterMembersFiltered).not.toHaveBeenCalled();
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

  it("200s a bare request (department) — the plain ranked roster, sort defaults to last", async () => {
    const res = await call("department", "N1140");
    expect(res.status).toBe(200);
    const [, , filter] = mockGetMembersFiltered.mock.calls[0];
    expect(filter).toEqual({ methodKeys: [], roleGroup: undefined, sort: "last", q: "" });
  });

  it("drops a method key that fails the sc::label regex (served as the unfiltered roster)", async () => {
    const res = await call("department", "N1140", "?method=not-a-key");
    expect(res.status).toBe(200);
    expect(mockGetMembersFiltered.mock.calls[0][2].methodKeys).toEqual([]);
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
    expect(mockGetCenterMembersFiltered).not.toHaveBeenCalled();
  });

  it("200s kind=center with no type — sort/q only", async () => {
    const res = await call("center", "MEYER", "?q=smith");
    expect(res.status).toBe(200);
    const [code, filter, page] = mockGetCenterMembersFiltered.mock.calls[0];
    expect(code).toBe("MEYER");
    expect(filter).toEqual({ roleGroup: undefined, sort: "last", q: "smith" });
    expect(page).toBe(0);
  });

  it("200s kind=center + a valid type, forwarding code/type/sort/page to getCenterMembersFiltered", async () => {
    mockGetCenterMembersFiltered.mockResolvedValue({
      hits: [{ cwid: "abc12345", preferredName: "X" }],
      total: 1,
      page: 0,
      pageSize: 20,
    });
    const res = await call("center", "MEYER", "?type=Full-time+faculty&sort=grants&page=1");
    expect(res.status).toBe(200);
    const [code, filter, page] = mockGetCenterMembersFiltered.mock.calls[0];
    expect(code).toBe("MEYER");
    expect(filter.roleGroup).toBe("Full-time faculty");
    expect(filter.sort).toBe("grants");
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
    expect(filter).toEqual({
      methodKeys: [],
      roleGroup: "Doctoral students",
      sort: "last",
      q: "",
    });
  });

  it("forwards a combined methods+type filter to the loader", async () => {
    await call("department", "N1140", "?method=sc::A&type=Affiliated+faculty");
    const [, , filter] = mockGetMembersFiltered.mock.calls[0];
    expect(filter).toEqual({
      methodKeys: ["sc::A"],
      roleGroup: "Affiliated faculty",
      sort: "last",
      q: "",
    });
  });

  it("forwards a division-only filter (?div=) for a department (Unit Page v2 Division facet)", async () => {
    const res = await call("department", "N1140", "?div=N1141&div=N1142&div=bad%20code");
    expect(res.status).toBe(200);
    const [, , filter] = mockGetMembersFiltered.mock.calls[0];
    expect(filter).toEqual({
      methodKeys: [],
      roleGroup: undefined,
      divisionCodes: ["N1141", "N1142"],
      sort: "last",
      q: "",
    });
  });

  it("ignores ?div= on a division (no divisionCodes forwarded)", async () => {
    const res = await call("division", "N1141", "?div=N1142");
    expect(res.status).toBe(200);
    expect(mockGetMembersFiltered.mock.calls[0][2].divisionCodes).toBeUndefined();
  });

  it("400s ?div= on kind=center", async () => {
    const res = await call("center", "MEYER", "?type=Full-time+faculty&div=N1141");
    expect(res.status).toBe(400);
    expect(mockGetCenterMembersFiltered).not.toHaveBeenCalled();
  });

  it("defaults page to 0 when absent", async () => {
    await call("department", "N1140", "?method=sc_x::A");
    expect(mockGetMembersFiltered.mock.calls[0][3]).toBe(0);
  });

  // Unit Page v2 roster toolbar.
  it("400s an invalid sort (closed enum), including the Publications tab's own values", async () => {
    for (const bad of ["name-desc", "most_cited", ""]) {
      const res = await call("department", "N1140", `?sort=${bad}`);
      expect(res.status).toBe(400);
    }
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
  });

  it("400s a q longer than 100 chars after trim; accepts exactly 100", async () => {
    const tooLong = await call("department", "N1140", `?q=${"a".repeat(101)}`);
    expect(tooLong.status).toBe(400);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
    const ok = await call("department", "N1140", `?q=${encodeURIComponent(`  ${"a".repeat(100)}  `)}`);
    expect(ok.status).toBe(200);
    expect(mockGetMembersFiltered.mock.calls[0][2].q).toBe("a".repeat(100));
  });

  it.each(["department", "division"])(
    "forwards a sort/q-only request for a %s",
    async (kind) => {
      const res = await call(kind, "N1140", "?sort=pubs&q=%20Jane%20%20Doe%20");
      expect(res.status).toBe(200);
      const [, , filter] = mockGetMembersFiltered.mock.calls[0];
      expect(filter.sort).toBe("pubs");
      expect(filter.q).toBe("Jane Doe");
    },
  );

  it("with the facet flag off: ?method= and ?div= 404, but sort/type/q are still served", async () => {
    mockFacetEnabled.mockReturnValue(false);
    expect((await call("department", "N1140", "?method=sc::A")).status).toBe(404);
    expect((await call("department", "N1140", "?div=N1141")).status).toBe(404);
    expect(mockGetMembersFiltered).not.toHaveBeenCalled();
    expect((await call("department", "N1140", "?sort=grants")).status).toBe(200);
    expect((await call("division", "N1141", "?type=Full-time+faculty")).status).toBe(200);
    expect((await call("center", "MEYER", "?q=doe")).status).toBe(200);
  });

  it("passes the loaders' `topMesh` TOPICS chips through in the JSON (dept ?type=/?div=, center ?type=)", async () => {
    const topMesh = [{ ui: "D000001", label: "Alpha Term" }];
    mockGetMembersFiltered.mockResolvedValue({
      hits: [{ cwid: "tst0001", topMesh }],
      total: 1,
      page: 0,
      pageSize: 20,
    });
    mockGetCenterMembersFiltered.mockResolvedValue({
      hits: [{ cwid: "tst0002", topMesh }],
      total: 1,
      page: 0,
      pageSize: 20,
    });

    const dept = await call("department", "N1140", "?type=Full-time+faculty&div=N1141");
    expect(dept.status).toBe(200);
    expect((await dept.json()).hits[0].topMesh).toEqual(topMesh);

    const center = await call("center", "TESTCTR", "?type=Full-time+faculty");
    expect(center.status).toBe(200);
    expect((await center.json()).hits[0].topMesh).toEqual(topMesh);
  });
});
