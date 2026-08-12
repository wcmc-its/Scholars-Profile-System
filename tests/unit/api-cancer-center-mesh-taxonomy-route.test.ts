/**
 * GET /api/edit/cancer-center-mesh-taxonomy — 401 unauthenticated; 200 shapes
 * whatever `buildTopicDetail` returns, built from `loadCancerTaxonomy`, plus
 * the summary figures (`totalRelevant`/`ruleCount`/`meshRelease`) the
 * redesigned modal's header/footer surface. `ruleCount` re-parses the REAL
 * `docs/cancer-taxonomy-ruleset.csv` (not mocked — a live file read, same as
 * the route itself), so this test computes its expected value the same way
 * rather than hand-typing a row count that would silently go stale exactly
 * like the design mockup's own hardcoded "164" did. Not center-scoped (no
 * curator-role check) — any authenticated `/edit` session may read it, same
 * as its sibling collab-report route's own posture but without the
 * per-center authz layer since this isn't center data.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { parseCsv } from "@/lib/csv";

const { mockGetEditSession, mockLoadCancerTaxonomy, mockBuildTopicDetail, mockEtlRunFindFirst } = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadCancerTaxonomy: vi.fn(),
  mockBuildTopicDetail: vi.fn(),
  mockEtlRunFindFirst: vi.fn(),
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
  db: {
    read: {
      cancerTaxonomyDescriptor: { findMany: vi.fn() },
      meshDescriptor: { findMany: vi.fn() },
      etlRun: { findFirst: mockEtlRunFindFirst },
    },
  },
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
const FIXTURE_LOOKUP = { topicsByUi: new Map([["D001943", ["breast"]], ["D999999", []]]), nameByUi: new Map() };

const REAL_RULE_COUNT = parseCsv(
  readFileSync(path.join(process.cwd(), "docs/cancer-taxonomy-ruleset.csv"), "utf8"),
).length;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEditSession.mockResolvedValue({ cwid: "cur001", isSuperuser: false });
  mockLoadCancerTaxonomy.mockResolvedValue(FIXTURE_LOOKUP);
  mockBuildTopicDetail.mockReturnValue(FIXTURE_DETAIL);
  mockEtlRunFindFirst.mockResolvedValue({ manifestTaxonomyVersion: "mesh2026:abc123def456" });
});

describe("GET /api/edit/cancer-center-mesh-taxonomy", () => {
  it("401s an unauthenticated caller", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("200s with the topics buildTopicDetail returns plus the live summary figures", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      topics: FIXTURE_DETAIL,
      totalRelevant: FIXTURE_LOOKUP.topicsByUi.size,
      ruleCount: REAL_RULE_COUNT,
      meshRelease: "MeSH 2026",
    });
  });

  it("omits meshRelease when no successful CancerTaxonomy EtlRun exists yet", async () => {
    mockEtlRunFindFirst.mockResolvedValue(null);
    const res = await GET();
    const body = await res.json();
    expect(body.meshRelease).toBeNull();
  });

  it("queries the CancerTaxonomy EtlRun source for the most recent success, not any run", async () => {
    await GET();
    expect(mockEtlRunFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source: "CancerTaxonomy", status: "success" } }),
    );
  });
});
