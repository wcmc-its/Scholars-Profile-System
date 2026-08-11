/**
 * GET /api/edit/center/[code]/collab-report/export[?cwid=] — same authz gate
 * as the parent `/collab-report` route (401/404/403), then a CSV of
 * post-cutoff Academic Article authorship per candidate with the taxonomy
 * "why": matched or not, which code(s)/disease(s). `matchedCodes`/
 * `loadTaxonomy` are mocked here — their own correctness is covered by
 * `cancer-center-mesh-taxonomy.test.ts`; this test is about the route's CSV
 * shape, filename, and scoping (`?cwid=` vs. whole report).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockCandidateFindMany,
  mockScholarFindMany,
  mockAuthorFindMany,
  mockLoadTaxonomy,
  mockMatchedCodes,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockCandidateFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockAuthorFindMany: vi.fn(),
  mockLoadTaxonomy: vi.fn(),
  mockMatchedCodes: vi.fn(),
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
      publicationAuthor: { findMany: mockAuthorFindMany },
      meshDescriptor: { findMany: vi.fn() },
    },
  },
}));
vi.mock("@/lib/cancer-center-mesh-taxonomy", () => ({
  loadTaxonomy: mockLoadTaxonomy,
  matchedCodes: mockMatchedCodes,
  diseaseByCode: (taxonomy: Array<{ code: string; disease: string }>) =>
    new Map(taxonomy.map((t) => [t.code, t.disease])),
}));

import { GET } from "@/app/api/edit/center/[code]/collab-report/export/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };
const CENTER = { code: "meyer_cancer_center" };

function get(url: string): NextRequest {
  return new NextRequest(url, { headers: { "sec-fetch-site": "same-origin" } });
}

function params(): { params: Promise<{ code: string }> } {
  return { params: Promise.resolve({ code: CENTER.code }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEditSession.mockResolvedValue(CURATOR);
  mockCenterFindUnique.mockResolvedValue(CENTER);
  mockUnitAdminFindMany.mockResolvedValue([{ entityType: "center", entityId: CENTER.code, role: "curator" }]);
  mockCandidateFindMany.mockResolvedValue([{ cwid: "c1" }]);
  mockScholarFindMany.mockResolvedValue([{ cwid: "c1", preferredName: "Ada Lovelace" }]);
  mockAuthorFindMany.mockResolvedValue([
    { pmid: "111", cwid: "c1", publication: { year: 2020, publicationType: "Academic Article", meshTerms: [{ ui: "D001943" }] } },
    { pmid: "222", cwid: "c1", publication: { year: 2021, publicationType: "Academic Article", meshTerms: [] } },
  ]);
  mockLoadTaxonomy.mockResolvedValue({
    codeByUi: new Map(),
    descriptors: [],
    taxonomy: [{ code: "BREAST", disease: "Breast Cancer", nlm_descriptor: "Breast Neoplasms", note: "" }],
  });
  mockMatchedCodes.mockImplementation((uis: string[]) => (uis.includes("D001943") ? ["BREAST"] : []));
});

describe("GET /api/edit/center/[code]/collab-report/export", () => {
  it("401s an unauthenticated caller", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET(get("http://localhost/x"), params());
    expect(res.status).toBe(401);
  });

  it("404s an unknown center slug", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    const res = await GET(get("http://localhost/x"), params());
    expect(res.status).toBe(404);
  });

  it("403s a non-curator, non-superuser caller", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await GET(get("http://localhost/x"), params());
    expect(res.status).toBe(403);
  });

  it("200s a CSV with one row per paper, each carrying the match reasoning", async () => {
    const res = await GET(get("http://localhost/x"), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="meyer_cancer_center-cancer-relevance-full.csv"');
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "cwid,surname,given_name,pmid,year,publication_type,is_cancer_related,matched_codes,matched_diseases",
    );
    expect(lines).toContain("c1,Lovelace,Ada,111,2020,Academic Article,yes,BREAST,Breast Cancer");
    expect(lines).toContain("c1,Lovelace,Ada,222,2021,Academic Article,no,,");
  });

  it("scopes to one candidate and uses the per-person filename when ?cwid= is given", async () => {
    const res = await GET(get("http://localhost/x?cwid=c1"), params());
    expect(mockCandidateFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { centerCode: CENTER.code, cwid: "c1" } }),
    );
    expect(res.headers.get("Content-Disposition")).toContain('filename="meyer_cancer_center-c1-cancer-relevance.csv"');
  });

  it("returns just the header row when the center has no candidates", async () => {
    mockCandidateFindMany.mockResolvedValue([]);
    const res = await GET(get("http://localhost/x"), params());
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });
});
