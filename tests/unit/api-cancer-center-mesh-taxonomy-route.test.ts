/**
 * GET /api/edit/cancer-center-mesh-taxonomy — 401 unauthenticated; 200 shapes
 * whatever `buildTopicDetail` returns, built from `loadCancerTaxonomy`. Not
 * center-scoped (no curator-role check) — any authenticated `/edit` session
 * may read it, same as its sibling collab-report route's own posture but
 * without the per-center authz layer since this isn't center data.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetEditSession, mockLoadCancerTaxonomy, mockBuildTopicDetail } = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadCancerTaxonomy: vi.fn(),
  mockBuildTopicDetail: vi.fn(),
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
vi.mock("@/lib/db", () => ({
  db: { read: { cancerTaxonomyDescriptor: { findMany: vi.fn() }, meshDescriptor: { findMany: vi.fn() } } },
}));
vi.mock("@/lib/cancer-taxonomy", () => ({
  loadCancerTaxonomy: mockLoadCancerTaxonomy,
  buildTopicDetail: mockBuildTopicDetail,
}));

import { GET } from "@/app/api/edit/cancer-center-mesh-taxonomy/route";

const FIXTURE_DETAIL = [
  { topic: "breast", descriptorCount: 12, exampleDescriptors: ["Breast Neoplasms", "Breast Neoplasms, Male"] },
  { topic: "unassigned", descriptorCount: 3, exampleDescriptors: ["Some Other Descriptor"] },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEditSession.mockResolvedValue({ cwid: "cur001", isSuperuser: false });
  mockLoadCancerTaxonomy.mockResolvedValue({ topicsByUi: new Map(), nameByUi: new Map() });
  mockBuildTopicDetail.mockReturnValue(FIXTURE_DETAIL);
});

describe("GET /api/edit/cancer-center-mesh-taxonomy", () => {
  it("401s an unauthenticated caller", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("200s with the topics buildTopicDetail returns, for any authenticated /edit session", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, topics: FIXTURE_DETAIL });
  });
});
