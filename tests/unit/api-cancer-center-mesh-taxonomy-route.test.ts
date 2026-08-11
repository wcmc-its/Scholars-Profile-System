/**
 * GET /api/edit/cancer-center-mesh-taxonomy — 401 unauthenticated; 200 shapes
 * whatever `buildTaxonomyDetail` returns, built from `loadTaxonomy`. Not
 * center-scoped (no curator-role check) — any authenticated `/edit` session
 * may read it, same as its sibling collab-report route's own posture but
 * without the per-center authz layer since this isn't center data.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetEditSession, mockLoadTaxonomy, mockBuildTaxonomyDetail } = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadTaxonomy: vi.fn(),
  mockBuildTaxonomyDetail: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
  impersonationActive: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => {
    const s = await mockGetEditSession();
    return s ? { cwid: s.cwid, iat: 0, exp: 0 } : null;
  }),
}));
vi.mock("@/lib/db", () => ({ db: { read: { meshDescriptor: { findMany: vi.fn() } } } }));
vi.mock("@/lib/cancer-center-mesh-taxonomy", () => ({
  loadTaxonomy: mockLoadTaxonomy,
  buildTaxonomyDetail: mockBuildTaxonomyDetail,
}));

import { GET } from "@/app/api/edit/cancer-center-mesh-taxonomy/route";

const FIXTURE_DETAIL = [
  {
    code: "BREAST",
    disease: "Breast Cancer",
    anchors: [{ name: "Breast Neoplasms", treeNumber: "C04.588.180" }],
    descendantCount: 12,
    exampleDescendants: ["Breast Neoplasms, Male"],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEditSession.mockResolvedValue({ cwid: "cur001", isSuperuser: false });
  mockLoadTaxonomy.mockResolvedValue({ codeByUi: new Map(), descriptors: [], taxonomy: [] });
  mockBuildTaxonomyDetail.mockReturnValue(FIXTURE_DETAIL);
});

describe("GET /api/edit/cancer-center-mesh-taxonomy", () => {
  it("401s an unauthenticated caller", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("200s with the codes buildTaxonomyDetail returns, for any authenticated /edit session", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, codes: FIXTURE_DETAIL });
  });
});
