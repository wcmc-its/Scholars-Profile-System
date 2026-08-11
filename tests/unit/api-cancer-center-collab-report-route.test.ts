/**
 * GET /api/edit/center/[code]/collab-report — 401 unauthenticated, 404 unknown
 * slug, 403 non-curator (same authz gate as its sibling nci-2a route); 200
 * shapes precomputed rows joined with Scholar and derives `generatedAt` as
 * the max `lastRefreshedAt` across rows.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetEditSession, mockCenterFindUnique, mockUnitAdminFindMany, mockCandidateFindMany, mockScholarFindMany } =
  vi.hoisted(() => ({
    mockGetEditSession: vi.fn(),
    mockCenterFindUnique: vi.fn(),
    mockUnitAdminFindMany: vi.fn(),
    mockCandidateFindMany: vi.fn(),
    mockScholarFindMany: vi.fn(),
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
      center: { findUnique: mockCenterFindUnique },
      unitAdmin: { findMany: mockUnitAdminFindMany },
      centerCollabCandidate: { findMany: mockCandidateFindMany },
      scholar: { findMany: mockScholarFindMany },
    },
  },
}));

import { GET } from "@/app/api/edit/center/[code]/collab-report/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };
const CENTER = { code: "meyer_cancer_center" };

function get(): NextRequest {
  return new NextRequest("http://localhost/x", { headers: { "sec-fetch-site": "same-origin" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEditSession.mockResolvedValue(CURATOR);
  mockCenterFindUnique.mockResolvedValue(CENTER);
  mockUnitAdminFindMany.mockResolvedValue([{ entityType: "center", entityId: CENTER.code, role: "curator" }]);
  mockCandidateFindMany.mockResolvedValue([]);
  mockScholarFindMany.mockResolvedValue([]);
});

describe("GET /api/edit/center/[code]/collab-report", () => {
  it("401s when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET(get(), { params: Promise.resolve({ code: "meyer_cancer_center" }) });
    expect(res.status).toBe(401);
  });

  it("404s on an unknown center code", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    const res = await GET(get(), { params: Promise.resolve({ code: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("403s a non-curator, non-superuser caller", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await GET(get(), { params: Promise.resolve({ code: "meyer_cancer_center" }) });
    expect(res.status).toBe(403);
  });

  it("200s with an empty rows array and null generatedAt when nothing is precomputed yet", async () => {
    const res = await GET(get(), { params: Promise.resolve({ code: "meyer_cancer_center" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, generatedAt: null, rows: [] });
  });

  it("joins Scholar for display fields and derives generatedAt as the max lastRefreshedAt", async () => {
    mockCandidateFindMany.mockResolvedValue([
      {
        centerCode: "meyer_cancer_center",
        cwid: "c1",
        totalPapersPostCutoff: 10,
        collaborationsWithCenter: 3,
        cancerRelatedPapers: 4,
        isCurrentMember: false,
        currentProgramCode: null,
        lastRefreshedAt: new Date("2026-08-01T00:00:00Z"),
      },
      {
        centerCode: "meyer_cancer_center",
        cwid: "c2",
        totalPapersPostCutoff: 5,
        collaborationsWithCenter: 0,
        cancerRelatedPapers: 2,
        isCurrentMember: true,
        currentProgramCode: "P1",
        lastRefreshedAt: new Date("2026-08-10T00:00:00Z"), // the later run
      },
    ]);
    mockScholarFindMany.mockResolvedValue([{ cwid: "c1", preferredName: "Jane Q. Public", primaryDepartment: "Medicine" }]);
    const res = await GET(get(), { params: Promise.resolve({ code: "meyer_cancer_center" }) });
    const body = await res.json();
    expect(body.generatedAt).toBe("2026-08-10T00:00:00.000Z");
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({ cwid: "c1", surname: "Public", givenName: "Jane Q.", primaryDepartment: "Medicine" });
    // c2 has no matching Scholar row (excluded from the mocked findMany) — falls back to the cwid, empty department.
    expect(body.rows[1]).toMatchObject({ cwid: "c2", surname: "c2", givenName: "", primaryDepartment: "" });
  });
});
