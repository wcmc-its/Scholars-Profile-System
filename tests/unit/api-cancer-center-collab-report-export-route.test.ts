/**
 * GET /api/edit/center/[code]/collab-report/export[?cwid=] — same authz gate
 * as the parent `/collab-report` route (401/404/403), then a CSV of
 * post-cutoff Academic Article authorship per candidate with full citation
 * detail (title, journal, year, publication type, impact score/
 * justification, synopsis) and the taxonomy "why": matched or not, which
 * term(s)/topic(s). `matchedTopics`/`matchedUis`/`loadCancerTaxonomy` are
 * mocked here — their own correctness is covered by `cancer-taxonomy.test.ts`;
 * this test is about the route's CSV shape, filename, and scoping (`?cwid=`
 * vs. whole report).
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
  mockLoadCancerTaxonomy,
  mockMatchedTopics,
  mockMatchedUis,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockCandidateFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockAuthorFindMany: vi.fn(),
  mockLoadCancerTaxonomy: vi.fn(),
  mockMatchedTopics: vi.fn(),
  mockMatchedUis: vi.fn(),
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
      cancerTaxonomyDescriptor: { findMany: vi.fn() },
      meshDescriptor: { findMany: vi.fn() },
    },
  },
}));
vi.mock("@/lib/cancer-taxonomy", () => ({
  loadCancerTaxonomy: mockLoadCancerTaxonomy,
  matchedTopics: mockMatchedTopics,
  matchedUis: mockMatchedUis,
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
    {
      pmid: "111",
      cwid: "c1",
      publication: {
        title: "A Study of Breast Neoplasms",
        journal: "J Oncol",
        publicationType: "Academic Article",
        year: 2020,
        meshTerms: [{ ui: "D001943" }],
        impactScore: 4.2,
        impactJustification: "Cited widely",
        synopsis: "Found a thing.",
      },
    },
    {
      pmid: "222",
      cwid: "c1",
      publication: {
        title: "Unrelated Work",
        journal: "J Misc",
        publicationType: "Academic Article",
        year: 2021,
        meshTerms: [],
        impactScore: null,
        impactJustification: null,
        synopsis: null,
      },
    },
  ]);
  mockLoadCancerTaxonomy.mockResolvedValue({
    topicsByUi: new Map([["D001943", ["breast"]]]),
    nameByUi: new Map([["D001943", "Breast Neoplasms"]]),
  });
  mockMatchedTopics.mockImplementation((uis: string[]) => (uis.includes("D001943") ? ["breast"] : []));
  mockMatchedUis.mockImplementation((uis: string[]) => uis.filter((u) => u === "D001943"));
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

  it("200s a CSV with one row per paper, full citation detail + the match reasoning", async () => {
    const res = await GET(get("http://localhost/x"), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="meyer_cancer_center-cancer-relevance-full.csv"');
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "cwid,surname,given_name,pmid,article_title,journal_title,publication_type,year,is_cancer_related,matched_terms,matched_topics,impact_score,impact_justification,synopsis",
    );
    expect(lines).toContain(
      "c1,Lovelace,Ada,111,A Study of Breast Neoplasms,J Oncol,Academic Article,2020,yes,Breast Neoplasms,breast,4.2,Cited widely,Found a thing.",
    );
    expect(lines).toContain("c1,Lovelace,Ada,222,Unrelated Work,J Misc,Academic Article,2021,no,,,,,");
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
