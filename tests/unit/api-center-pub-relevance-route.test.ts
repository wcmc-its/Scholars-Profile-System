/**
 * PATCH /api/edit/center/[code]/pub-relevance/[pmid] — report 17's review write.
 *  - 401 unauthenticated, 404 unknown center, 403 non-curator BEFORE the body
 *    is validated;
 *  - 400 on an empty body, a non-boolean `relevant`, a non-string or over-long
 *    `reason`;
 *  - 404 on a publication the ETL has not decided for this center;
 *  - confirm, flip and note-only writes all make the row `source: "human"`,
 *    stamp the reviewer, and write one `pub_relevance_review` audit row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockExecuteRaw,
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockRelevanceFindUnique,
  mockTxRelevanceUpdate,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockRelevanceFindUnique: vi.fn(),
  mockTxRelevanceUpdate: vi.fn(),
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
      centerPublicationRelevance: { findUnique: mockRelevanceFindUnique },
    },
    write: { $transaction: mockTransaction },
  },
}));

import { PATCH } from "@/app/api/edit/center/[code]/pub-relevance/[pmid]/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };
const CENTER = { code: "example_center" };
const EXISTING = {
  relevant: true,
  reason: "This is cancer relevant. It studies melanoma.",
  source: "llm",
};

const fakeTx = {
  centerPublicationRelevance: { update: mockTxRelevanceUpdate },
  $executeRaw: mockExecuteRaw,
};

function patch(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/center/example_center/pub-relevance/1000001", {
    method: "PATCH",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}
const params = () => Promise.resolve({ code: "example_center", pmid: "1000001" });
const auditValues = () => mockExecuteRaw.mock.calls[0].slice(1).map(String);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(CURATOR);
  mockCenterFindUnique.mockResolvedValue(CENTER);
  mockUnitAdminFindMany.mockResolvedValue([
    { entityType: "center", entityId: CENTER.code, role: "curator" },
  ]);
  mockRelevanceFindUnique.mockResolvedValue(EXISTING);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockExecuteRaw.mockResolvedValue(1);
  mockTxRelevanceUpdate.mockResolvedValue({});
});

describe("PATCH /api/edit/center/[code]/pub-relevance/[pmid]", () => {
  it("401s when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    expect((await PATCH(patch({ relevant: false }), { params: params() })).status).toBe(401);
  });

  it("404s an unknown center", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    expect((await PATCH(patch({ relevant: false }), { params: params() })).status).toBe(404);
  });

  it("403s a non-curator before validating the body", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    expect((await PATCH(patch({ relevant: "maybe" }), { params: params() })).status).toBe(403);
    expect(mockRelevanceFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { relevant: "yes" },
    { relevant: null },
    { reason: 5 },
    { reason: "x".repeat(2001) },
  ])("400s %j", async (body) => {
    expect((await PATCH(patch(body), { params: params() })).status).toBe(400);
    expect(mockTxRelevanceUpdate).not.toHaveBeenCalled();
  });

  it("404s a publication with no relevance row for this center", async () => {
    mockRelevanceFindUnique.mockResolvedValue(null);
    expect((await PATCH(patch({ relevant: true }), { params: params() })).status).toBe(404);
    expect(mockRelevanceFindUnique.mock.calls[0][0].where).toEqual({
      centerCode_pmid: { centerCode: "example_center", pmid: "1000001" },
    });
  });

  it("confirms an AI answer: source human, reviewer stamped, reason kept, one audit row", async () => {
    const res = await PATCH(patch({ relevant: true }), { params: params() });
    expect(res.status).toBe(200);
    const { data } = mockTxRelevanceUpdate.mock.calls[0][0];
    expect(data).toMatchObject({
      relevant: true,
      reason: EXISTING.reason,
      source: "human",
      reviewedBy: "cur001",
    });
    expect(data.reviewedAt).toBeInstanceOf(Date);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(auditValues()).toEqual(
      expect.arrayContaining([
        "pub_relevance_review",
        "center_publication_relevance",
        "example_center:1000001",
      ]),
    );
  });

  it("flips the answer and replaces the note together", async () => {
    const res = await PATCH(patch({ relevant: false, reason: "  The focus is wound healing.  " }), {
      params: params(),
    });
    expect(res.status).toBe(200);
    expect(mockTxRelevanceUpdate.mock.calls[0][0].data).toMatchObject({
      relevant: false,
      reason: "The focus is wound healing.",
      source: "human",
    });
    expect(await res.json()).toMatchObject({ relevant: false, source: "human" });
  });

  it("a note alone keeps the answer, and a blank note clears it", async () => {
    await PATCH(patch({ reason: "   " }), { params: params() });
    expect(mockTxRelevanceUpdate.mock.calls[0][0].data).toMatchObject({
      relevant: true,
      reason: null,
      source: "human",
    });
  });

  it("500s when the write fails", async () => {
    mockTxRelevanceUpdate.mockRejectedValue(new Error("db down"));
    expect((await PATCH(patch({ relevant: true }), { params: params() })).status).toBe(500);
  });
});
