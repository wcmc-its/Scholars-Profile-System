/**
 * `/api/edit/opportunity-intake` route wiring (`docs/opportunity-url-intake-spec.md` §5):
 *  - both verbs 404 while OPPORTUNITY_URL_INTAKE is off (dark-ship posture);
 *  - dev-role gate (superuser OR isDeveloper), GET 403 / POST 403 + denial log;
 *  - POST validation + the two 409 duplicate shapes;
 *  - happy path: queue Put with the NORMALIZED url as dedup key, then the B03
 *    audit row (action/entity `opportunity_submission`, target = the SK).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockGetEffectiveEditSession,
  mockReadEditRequest,
  mockPutSubmission,
  mockListSubmissions,
  mockGetSubmission,
  mockDeleteSubmission,
  mockSuppressSubmission,
  mockOpportunityFindMany,
  mockTransaction,
  mockAppendAuditRow,
  mockLogEditDenial,
} = vi.hoisted(() => ({
  mockGetEffectiveEditSession: vi.fn(),
  mockReadEditRequest: vi.fn(),
  mockPutSubmission: vi.fn(),
  mockListSubmissions: vi.fn(),
  mockGetSubmission: vi.fn(),
  mockDeleteSubmission: vi.fn(),
  mockSuppressSubmission: vi.fn(),
  mockOpportunityFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockLogEditDenial: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEffectiveEditSession,
}));
vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/opportunity-submission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/opportunity-submission")>()),
  putSubmission: mockPutSubmission,
  listSubmissions: mockListSubmissions,
  getSubmission: mockGetSubmission,
  deleteSubmission: mockDeleteSubmission,
  suppressSubmission: mockSuppressSubmission,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: { opportunity: { findMany: mockOpportunityFindMany } },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogEditDenial }));

import { DELETE, GET, PATCH, POST } from "@/app/api/edit/opportunity-intake/route";

const developerCtx = {
  session: { cwid: "flm4001", isSuperuser: false, isDeveloper: true },
  effective: { cwid: "flm4001", isSuperuser: false, isDeveloper: true },
  realCwid: "flm4001",
  impersonatedCwid: null,
  requestId: "req-1",
  body: {} as Record<string, unknown>,
};

function postRequest(body: Record<string, unknown>) {
  mockReadEditRequest.mockResolvedValue({ ok: true, ctx: { ...developerCtx, body } });
  return {} as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPPORTUNITY_URL_INTAKE = "on";
  mockListSubmissions.mockResolvedValue([]);
  mockOpportunityFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => fn({}));
  mockPutSubmission.mockImplementation(async (input: Record<string, unknown>) => ({
    submissionId: "2026-07-06T12:00:00.000Z#ab12cd34",
    ...input,
    submittedAt: "2026-07-06T12:00:00.000Z",
    status: "pending",
    processedAt: null,
    producedOpportunityIds: [],
    rejectReason: null,
  }));
});

describe("flag gate", () => {
  it("404s all four verbs while the flag is off", async () => {
    process.env.OPPORTUNITY_URL_INTAKE = "off";
    expect((await GET()).status).toBe(404);
    expect((await POST(postRequest({ url: "https://x.org" }))).status).toBe(404);
    expect((await DELETE(postRequest({ submissionId: "sk" }))).status).toBe(404);
    expect((await PATCH(postRequest({ submissionId: "sk", action: "suppress" }))).status).toBe(
      404,
    );
    expect(mockReadEditRequest).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("403s a non-developer, 200s a developer with the queue", async () => {
    mockGetEffectiveEditSession.mockResolvedValue({ isSuperuser: false, isDeveloper: false });
    expect((await GET()).status).toBe(403);

    mockGetEffectiveEditSession.mockResolvedValue({ isSuperuser: false, isDeveloper: true });
    mockListSubmissions.mockResolvedValue([{ submissionId: "s1" }]);
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, submissions: [{ submissionId: "s1" }] });
  });

  it("502s when the queue is unreachable", async () => {
    mockGetEffectiveEditSession.mockResolvedValue({ isSuperuser: true, isDeveloper: false });
    mockListSubmissions.mockRejectedValue(new Error("ddb down"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("queue_unavailable");
  });
});

describe("POST", () => {
  it("403s + logs a denial for a non-developer", async () => {
    mockReadEditRequest.mockResolvedValue({
      ok: true,
      ctx: {
        ...developerCtx,
        session: { cwid: "abc1234", isSuperuser: false, isDeveloper: false },
        body: { url: "https://x.org" },
      },
    });
    const res = await POST({} as NextRequest);
    expect(res.status).toBe(403);
    expect(mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not_developer_post" }),
    );
    expect(mockPutSubmission).not.toHaveBeenCalled();
  });

  it("400s a non-https or malformed url", async () => {
    const http = await POST(postRequest({ url: "http://x.org" }));
    expect(http.status).toBe(400);
    expect((await http.json()).error).toBe("https_required");

    const junk = await POST(postRequest({ url: "not a url" }));
    expect(junk.status).toBe(400);
    expect((await junk.json()).error).toBe("invalid_url");
  });

  it("409s with the existing corpus row on a duplicate URL (normalized both sides)", async () => {
    mockOpportunityFindMany.mockResolvedValue([
      {
        opportunityId: "wcm_curated:hartwell-abc123",
        title: "Hartwell Award",
        sourceUrl: "https://WWW.hartwell.org/award/",
      },
    ]);
    const res = await POST(postRequest({ url: "https://www.hartwell.org/award?utm_source=x" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: "duplicate_url",
      existing: { opportunityId: "wcm_curated:hartwell-abc123", title: "Hartwell Award" },
    });
    expect(mockPutSubmission).not.toHaveBeenCalled();
  });

  it("409s on an already-queued URL", async () => {
    mockListSubmissions.mockResolvedValue([
      {
        submissionId: "2026-07-05T10:00:00.000Z#dead beef".replace(" ", ""),
        normalizedUrl: "https://x.org/grants",
        status: "pending",
      },
    ]);
    const res = await POST(postRequest({ url: "https://x.org/grants/" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("duplicate_submission");
  });

  it("queues with the normalized url, then appends the audit row", async () => {
    const res = await POST(
      postRequest({ url: "https://Skincancer.org/about-us/research-grants/#apply", note: "  ped onc  " }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.submission.submissionId).toBe("2026-07-06T12:00:00.000Z#ab12cd34");

    expect(mockPutSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedUrl: "https://skincancer.org/about-us/research-grants",
        note: "ped onc",
        submittedBy: "flm4001",
      }),
      expect.anything(),
    );
    expect(mockAppendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorCwid: "flm4001",
        targetEntityType: "opportunity_submission",
        targetEntityId: "2026-07-06T12:00:00.000Z#ab12cd34",
        action: "opportunity_submission",
        afterValues: expect.objectContaining({ note: "ped onc" }),
      }),
    );
  });

  it("502s (and skips the audit) when the queue Put fails", async () => {
    mockPutSubmission.mockRejectedValue(new Error("denied"));
    const res = await POST(postRequest({ url: "https://x.org/grants" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("queue_write_failed");
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });
});

const SK = "2026-07-06T12:00:00.000Z#ab12cd34";

function queueItem(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: SK,
    url: "https://x.org/grants",
    normalizedUrl: "https://x.org/grants",
    note: "oops",
    submittedBy: "flm4001",
    submittedAt: "2026-07-06T12:00:00.000Z",
    status: "pending",
    processedAt: null,
    producedOpportunityIds: [],
    rejectReason: null,
    ...overrides,
  };
}

function conditionalCheckError() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

describe("DELETE", () => {
  it("403s + logs a denial for a non-developer", async () => {
    mockReadEditRequest.mockResolvedValue({
      ok: true,
      ctx: {
        ...developerCtx,
        session: { cwid: "abc1234", isSuperuser: false, isDeveloper: false },
        body: { submissionId: SK },
      },
    });
    const res = await DELETE({} as NextRequest);
    expect(res.status).toBe(403);
    expect(mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not_developer_delete" }),
    );
    expect(mockDeleteSubmission).not.toHaveBeenCalled();
  });

  it("400s a missing submissionId, 404s an unknown one", async () => {
    const bad = await DELETE(postRequest({}));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_submission_id");

    mockGetSubmission.mockResolvedValue(null);
    const missing = await DELETE(postRequest({ submissionId: SK }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("not_found");
    expect(mockDeleteSubmission).not.toHaveBeenCalled();
  });

  it("409s a processed (and a suppressed) submission without touching the queue", async () => {
    mockGetSubmission.mockResolvedValue(queueItem({ status: "processed" }));
    const processed = await DELETE(postRequest({ submissionId: SK }));
    expect(processed.status).toBe(409);
    expect((await processed.json()).error).toBe("submission_processed");

    mockGetSubmission.mockResolvedValue(queueItem({ status: "suppressed" }));
    const suppressed = await DELETE(postRequest({ submissionId: SK }));
    expect(suppressed.status).toBe(409);
    expect(mockDeleteSubmission).not.toHaveBeenCalled();
  });

  it("deletes a pending item, then appends the audit row", async () => {
    mockGetSubmission.mockResolvedValue(queueItem());
    mockDeleteSubmission.mockResolvedValue(undefined);
    const res = await DELETE(postRequest({ submissionId: SK }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, submissionId: SK });

    expect(mockDeleteSubmission).toHaveBeenCalledWith(SK);
    expect(mockAppendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorCwid: "flm4001",
        targetEntityType: "opportunity_submission",
        targetEntityId: SK,
        action: "opportunity_submission_delete",
        beforeValues: expect.objectContaining({ url: "https://x.org/grants", status: "pending" }),
        afterValues: null,
      }),
    );
  });

  it("also deletes a rejected item", async () => {
    mockGetSubmission.mockResolvedValue(queueItem({ status: "rejected" }));
    mockDeleteSubmission.mockResolvedValue(undefined);
    expect((await DELETE(postRequest({ submissionId: SK }))).status).toBe(200);
  });

  it("409s when the drain processed the item between the read and the write", async () => {
    mockGetSubmission.mockResolvedValue(queueItem());
    mockDeleteSubmission.mockRejectedValue(conditionalCheckError());
    const res = await DELETE(postRequest({ submissionId: SK }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("submission_processed");
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("502s on a queue failure, 500s on an audit failure", async () => {
    mockGetSubmission.mockResolvedValue(queueItem());
    mockDeleteSubmission.mockRejectedValue(new Error("denied"));
    expect((await DELETE(postRequest({ submissionId: SK }))).status).toBe(502);

    mockDeleteSubmission.mockResolvedValue(undefined);
    mockTransaction.mockRejectedValue(new Error("mysql down"));
    const res = await DELETE(postRequest({ submissionId: SK }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("write_failed");
  });
});

describe("PATCH (suppress)", () => {
  it("403s + logs a denial for a non-developer", async () => {
    mockReadEditRequest.mockResolvedValue({
      ok: true,
      ctx: {
        ...developerCtx,
        session: { cwid: "abc1234", isSuperuser: false, isDeveloper: false },
        body: { submissionId: SK, action: "suppress" },
      },
    });
    const res = await PATCH({} as NextRequest);
    expect(res.status).toBe(403);
    expect(mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not_developer_patch" }),
    );
    expect(mockSuppressSubmission).not.toHaveBeenCalled();
  });

  it("400s a missing or unknown action", async () => {
    mockGetSubmission.mockResolvedValue(queueItem({ status: "processed" }));
    const missing = await PATCH(postRequest({ submissionId: SK }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("invalid_action");
    expect(
      (await PATCH(postRequest({ submissionId: SK, action: "resubmit" }))).status,
    ).toBe(400);
    expect(mockSuppressSubmission).not.toHaveBeenCalled();
  });

  it("409s a pending item (not_processed) and a double-suppress (already_suppressed)", async () => {
    mockGetSubmission.mockResolvedValue(queueItem());
    const pending = await PATCH(postRequest({ submissionId: SK, action: "suppress" }));
    expect(pending.status).toBe(409);
    expect((await pending.json()).error).toBe("not_processed");

    mockGetSubmission.mockResolvedValue(queueItem({ status: "suppressed" }));
    const twice = await PATCH(postRequest({ submissionId: SK, action: "suppress" }));
    expect(twice.status).toBe(409);
    expect((await twice.json()).error).toBe("already_suppressed");
    expect(mockSuppressSubmission).not.toHaveBeenCalled();
  });

  it("suppresses a processed item, then appends the audit row", async () => {
    mockGetSubmission.mockResolvedValue(
      queueItem({ status: "processed", producedOpportunityIds: ["manual_url:x-abc123"] }),
    );
    mockSuppressSubmission.mockResolvedValue(undefined);
    const res = await PATCH(postRequest({ submissionId: SK, action: "suppress" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, submissionId: SK });

    expect(mockSuppressSubmission).toHaveBeenCalledWith(
      SK,
      { suppressedBy: "flm4001" },
      expect.anything(),
    );
    expect(mockAppendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "opportunity_submission_suppress",
        targetEntityId: SK,
        beforeValues: expect.objectContaining({
          status: "processed",
          produced_opportunity_ids: ["manual_url:x-abc123"],
        }),
        afterValues: { status: "suppressed" },
      }),
    );
  });

  it("409s when the drain raced the condition, 502s on a queue failure", async () => {
    mockGetSubmission.mockResolvedValue(queueItem({ status: "processed" }));
    mockSuppressSubmission.mockRejectedValue(conditionalCheckError());
    expect(
      (await PATCH(postRequest({ submissionId: SK, action: "suppress" }))).status,
    ).toBe(409);

    mockSuppressSubmission.mockRejectedValue(new Error("denied"));
    expect(
      (await PATCH(postRequest({ submissionId: SK, action: "suppress" }))).status,
    ).toBe(502);
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });
});
