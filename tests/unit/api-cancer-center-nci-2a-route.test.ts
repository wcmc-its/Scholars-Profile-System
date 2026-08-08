/**
 * NCI Table 2A center routes:
 *   GET   /api/edit/center/[code]/nci-2a           — list a cycle's rows
 *   PATCH /api/edit/center/[code]/nci-2a/[awardId]  — reviewer override
 *
 *  - GET: 401 unauthenticated, 404 unknown slug, 403 non-curator; no `cycle`
 *    resolves the latest by `reportingCycle desc`; shapes nested allocations +
 *    computes the derived $ columns (Cancer-Relevant Annual Project DC,
 *    Annual Program Direct Costs).
 *  - PATCH: 400 on an out-of-range percent, allocations not summing to 100, or
 *    an invented program code (never trusted, mirrors the Bedrock module's own
 *    gate); 404 on an award outside this center; 403 non-curator; a successful
 *    percent-only or allocations-only override sets `source: "human"` on
 *    exactly the touched field and writes one audit row
 *    (`cancer_funding_override`).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockExecuteRaw,
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockCenterProgramFindMany,
  mockAwardFindMany,
  mockAwardFindFirst,
  mockAwardFindUnique,
  mockTxAwardUpdate,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockCenterProgramFindMany: vi.fn(),
  mockAwardFindMany: vi.fn(),
  mockAwardFindFirst: vi.fn(),
  mockAwardFindUnique: vi.fn(),
  mockTxAwardUpdate: vi.fn(),
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
      centerProgram: { findMany: mockCenterProgramFindMany },
      cancerCenterFundingAward: {
        findMany: mockAwardFindMany,
        findFirst: mockAwardFindFirst,
        findUnique: mockAwardFindUnique,
      },
    },
    write: { $transaction: mockTransaction },
  },
}));

import { GET } from "@/app/api/edit/center/[code]/nci-2a/route";
import { PATCH } from "@/app/api/edit/center/[code]/nci-2a/[awardId]/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };
const CENTER = { code: "meyer_cancer_center", slug: "meyer-cancer-center" };
const PROGRAMS = [
  { code: "CB", label: "Cancer Biology" },
  { code: "CGE", label: "Cancer Genetics & Epigenetics" },
];

const fakeTx = {
  cancerCenterFundingAward: { update: mockTxAwardUpdate },
  $executeRaw: mockExecuteRaw,
};

function get(url: string): NextRequest {
  return new NextRequest(url, { headers: { "sec-fetch-site": "same-origin" } });
}
function patch(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/center/meyer-cancer-center/nci-2a/award-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(CURATOR);
  mockCenterFindUnique.mockResolvedValue(CENTER);
  mockUnitAdminFindMany.mockResolvedValue([{ entityType: "center", entityId: CENTER.code, role: "curator" }]);
  mockCenterProgramFindMany.mockResolvedValue(PROGRAMS);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockExecuteRaw.mockResolvedValue(1);
  mockTxAwardUpdate.mockResolvedValue({ id: "award-1" });
});

describe("GET /api/edit/center/[code]/nci-2a", () => {
  it("401s when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET(get("http://localhost/x?cycle=osra-2026-07-14"), {
      params: Promise.resolve({ code: "meyer_cancer_center" }),
    });
    expect(res.status).toBe(401);
  });

  it("404s on an unknown center slug", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    const res = await GET(get("http://localhost/x"), { params: Promise.resolve({ code: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("403s a non-curator, non-superuser caller", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await GET(get("http://localhost/x"), { params: Promise.resolve({ code: "meyer_cancer_center" }) });
    expect(res.status).toBe(403);
  });

  it("resolves the latest cycle when none is requested", async () => {
    mockAwardFindFirst.mockResolvedValue({ reportingCycle: "osra-2026-07-14" });
    mockAwardFindMany.mockResolvedValue([]);
    await GET(get("http://localhost/x"), { params: Promise.resolve({ code: "meyer_cancer_center" }) });
    expect(mockAwardFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { reportingCycle: "desc" } }),
    );
    expect(mockAwardFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ reportingCycle: "osra-2026-07-14" }) }),
    );
  });

  it("shapes allocations and computes the derived $ columns", async () => {
    mockAwardFindMany.mockResolvedValue([
      {
        id: "award-1",
        pi: "Test, PI",
        specificFundingSource: "NCI",
        projectNumber: "5 R01 CA000000-01",
        projectTitle: "A cancer project",
        projectStartDate: new Date("2024-01-01T00:00:00Z"),
        projectEndDate: new Date("2028-12-31T00:00:00Z"),
        annualProjectDirectCosts: 200000,
        cancerRelevantPercent: 50,
        cancerRelevantPercentSource: "llm",
        cancerRelevantRationale: "because",
        grantCwid: "abc1234",
        allocations: [{ id: "alloc-1", programCode: "CB", programPercent: 40, source: "membership" }],
      },
    ]);
    const res = await GET(get("http://localhost/x?cycle=osra-2026-07-14"), {
      params: Promise.resolve({ code: "meyer_cancer_center" }),
    });
    const json = await res.json();
    const award = json.awards[0];
    expect(award.cancerRelevantAnnualProjectDc).toBe(100000); // 200000 * 50%
    expect(award.allocations[0].programLabel).toBe("Cancer Biology");
    expect(award.allocations[0].annualProgramDirectCosts).toBe(40000); // 100000 * 40%
  });
});

describe("PATCH /api/edit/center/[code]/nci-2a/[awardId]", () => {
  const params = () => Promise.resolve({ code: "meyer_cancer_center", awardId: "award-1" });
  const EXISTING = {
    id: "award-1",
    cancerRelevantPercent: 50,
    cancerRelevantPercentSource: "llm",
    allocations: [{ programCode: "CB", programPercent: 100, source: "llm" }],
  };

  beforeEach(() => {
    mockAwardFindUnique.mockResolvedValue(EXISTING);
  });

  it("400s an out-of-range percent", async () => {
    const res = await PATCH(patch({ cancerRelevantPercent: 150 }), { params: params() });
    expect(res.status).toBe(400);
  });

  it("400s allocations that don't sum to 100", async () => {
    const res = await PATCH(
      patch({ allocations: [{ programCode: "CB", programPercent: 60 }] }),
      { params: params() },
    );
    expect(res.status).toBe(400);
  });

  it("400s an invented program code — never trusted", async () => {
    const res = await PATCH(
      patch({ allocations: [{ programCode: "NOT_REAL", programPercent: 100 }] }),
      { params: params() },
    );
    expect(res.status).toBe(400);
  });

  it("404s an award that doesn't belong to this center", async () => {
    mockAwardFindUnique.mockResolvedValue(null);
    const res = await PATCH(patch({ cancerRelevantPercent: 80 }), { params: params() });
    expect(res.status).toBe(404);
  });

  it("403s a non-curator", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await PATCH(patch({ cancerRelevantPercent: 80 }), { params: params() });
    expect(res.status).toBe(403);
  });

  it("overrides the percent only — sets source:human, leaves allocations untouched", async () => {
    const res = await PATCH(patch({ cancerRelevantPercent: 80 }), { params: params() });
    expect(res.status).toBe(200);
    const data = mockTxAwardUpdate.mock.calls[0][0].data;
    expect(data.cancerRelevantPercent).toBe(80);
    expect(data.cancerRelevantPercentSource).toBe("human");
    expect(data.allocations).toBeUndefined();
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // one audit row
  });

  it("overrides allocations only — sets source:human on the new rows, leaves percent untouched", async () => {
    const res = await PATCH(
      patch({ allocations: [{ programCode: "CGE", programPercent: 100 }] }),
      { params: params() },
    );
    expect(res.status).toBe(200);
    const data = mockTxAwardUpdate.mock.calls[0][0].data;
    expect(data.cancerRelevantPercent).toBeUndefined();
    expect(data.allocations.create[0]).toMatchObject({ programCode: "CGE", programPercent: 100, source: "human" });
  });

  it("a null programCode (explicit 'no program fits') is allowed through", async () => {
    const res = await PATCH(
      patch({ allocations: [{ programCode: null, programPercent: 100 }] }),
      { params: params() },
    );
    expect(res.status).toBe(200);
  });

  it("403s a non-curator BEFORE validating the body — an invented code must not leak via 400-vs-403", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await PATCH(
      patch({ allocations: [{ programCode: "TOTALLY_MADE_UP", programPercent: 100 }] }),
      { params: params() },
    );
    // 403, not 400 — an unauthorized caller can't use the status code to learn
    // whether a guessed program code is real. The centerProgram lookup that
    // would distinguish them must never run before authz.
    expect(res.status).toBe(403);
    expect(mockCenterProgramFindMany).not.toHaveBeenCalled();
  });

  it("400s a per-row allocation outside [0,100] even when the set still sums to 100", async () => {
    const res = await PATCH(
      patch({
        allocations: [
          { programCode: "CB", programPercent: 150 },
          { programCode: "CGE", programPercent: -50 },
        ],
      }),
      { params: params() },
    );
    expect(res.status).toBe(400);
  });
});
