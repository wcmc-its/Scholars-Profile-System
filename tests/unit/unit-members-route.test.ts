/**
 * #974 Phase 2 — GET /api/units/[kind]/[code]/members route.
 *
 * Asserts the validation/gate posture (flag-off 404, bad kind/code/no-method 400)
 * and that valid input forwards (kind, code, validated method keys, page) to the
 * loader. The OR-within-facet filtering, pagination, and suppressed/sensitive
 * exclusion are exercised against the real loader in unit-members-loader.test.ts;
 * here the loader is mocked so the route's own contract is isolated.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetMembers, mockFacetEnabled } = vi.hoisted(() => ({
  mockGetMembers: vi.fn(),
  mockFacetEnabled: vi.fn(),
}));

vi.mock("@/lib/api/unit-members", () => ({
  getUnitMembersByMethods: (...args: unknown[]) => mockGetMembers(...args),
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
  mockGetMembers.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
});

describe("GET /api/units/[kind]/[code]/members", () => {
  it("404s when the facet flag is off (loader not called)", async () => {
    mockFacetEnabled.mockReturnValue(false);
    const res = await call("department", "N1140", "?method=sc::A");
    expect(res.status).toBe(404);
    expect(mockGetMembers).not.toHaveBeenCalled();
  });

  it("400s an unknown kind", async () => {
    const res = await call("center", "N1140", "?method=sc::A");
    expect(res.status).toBe(400);
    expect(mockGetMembers).not.toHaveBeenCalled();
  });

  it("400s a malformed code", async () => {
    const res = await call("department", "bad code!", "?method=sc::A");
    expect(res.status).toBe(400);
    expect(mockGetMembers).not.toHaveBeenCalled();
  });

  it("400s when no valid method key is supplied", async () => {
    const res = await call("department", "N1140");
    expect(res.status).toBe(400);
    expect(mockGetMembers).not.toHaveBeenCalled();
  });

  it("400s when the only method key fails the sc::label regex", async () => {
    const res = await call("department", "N1140", "?method=not-a-key");
    expect(res.status).toBe(400);
    expect(mockGetMembers).not.toHaveBeenCalled();
  });

  it("forwards kind/code/valid methods (OR set)/page to the loader; drops invalid keys", async () => {
    mockGetMembers.mockResolvedValue({
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
    const [kind, code, methods, page] = mockGetMembers.mock.calls[0];
    expect(kind).toBe("division");
    expect(code).toBe("N2466");
    // The two well-formed keys pass; "BAD" is dropped by METHOD_KEY_RE.
    expect(methods).toEqual(["imaging_x::Deep learning", "imaging_x::Segmentation"]);
    // page is 0-based for the loader (?page=2 → page index 2; route parses raw).
    expect(page).toBe(2);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.hits[0].cwid).toBe("abc12345");
  });

  it("defaults page to 0 when absent", async () => {
    await call("department", "N1140", "?method=sc_x::A");
    expect(mockGetMembers.mock.calls[0][3]).toBe(0);
  });
});
