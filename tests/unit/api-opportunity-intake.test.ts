/**
 * `/api/edit/opportunity-intake` route wiring (`docs/opportunity-url-intake-spec.md` §5):
 *  - both verbs 404 while OPPORTUNITY_URL_INTAKE is off (dark-ship posture);
 *  - dev-role gate (superuser OR isDeveloper), GET 403 / POST 403 + denial log;
 *  - GET's produced-id → corpus-title batch join (one deduped query, no
 *    suppressed filter, fail-soft to an empty map);
 *  - POST validation + the two 409 duplicate shapes;
 *  - happy path: queue Put with the NORMALIZED url as dedup key, then the B03
 *    audit row (action/entity `opportunity_submission`, target = the SK);
 *  - PATCH/suppress unification cascade (matcha-admin Phase 1b): projected
 *    corpus rows carrying the submission's URL are suppressed immediately —
 *    read BEFORE the queue flip, gated on MATCHA_ADMIN (drain-only while off),
 *    re-driven idempotently on a retried suppress.
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
  mockScholarFindMany,
  mockOpportunityUpdate,
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
  mockScholarFindMany: vi.fn(),
  mockOpportunityUpdate: vi.fn(),
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
    read: {
      opportunity: { findMany: mockOpportunityFindMany },
      scholar: { findMany: mockScholarFindMany },
    },
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
  process.env.MATCHA_ADMIN = "on";
  mockListSubmissions.mockResolvedValue([]);
  mockOpportunityFindMany.mockResolvedValue([]);
  mockScholarFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
    fn({ opportunity: { update: mockOpportunityUpdate } }),
  );
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
    mockListSubmissions.mockResolvedValue([{ submissionId: "s1", producedOpportunityIds: [] }]);
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      submissions: [{ submissionId: "s1", producedOpportunityIds: [] }],
      opportunityTitles: {},
      submitterNames: {},
    });
    // No produced ids anywhere on the page → the corpus join never runs.
    expect(mockOpportunityFindMany).not.toHaveBeenCalled();
  });

  it("joins produced ids to corpus titles in ONE deduped query, suppressed rows included", async () => {
    mockGetEffectiveEditSession.mockResolvedValue({ isSuperuser: true, isDeveloper: false });
    mockListSubmissions.mockResolvedValue([
      { submissionId: "s1", producedOpportunityIds: ["manual_url:a-1", "manual_url:b-2"] },
      // Same id twice across the page → still one entry in the `in` list.
      { submissionId: "s2", producedOpportunityIds: ["manual_url:a-1"] },
      { submissionId: "s3", producedOpportunityIds: [] },
    ]);
    // b-2 is corpus-suppressed — its title must still come back (the detail
    // route 404s suppressed rows, which is exactly why this join can't filter).
    mockOpportunityFindMany.mockResolvedValue([
      { opportunityId: "manual_url:a-1", title: "Hartwell Fellowship" },
      { opportunityId: "manual_url:b-2", title: "Retracted Award" },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).opportunityTitles).toEqual({
      "manual_url:a-1": "Hartwell Fellowship",
      "manual_url:b-2": "Retracted Award",
    });
    expect(mockOpportunityFindMany).toHaveBeenCalledTimes(1);
    // Exact args: id-scoped, title-only select, and NO suppressedAt filter.
    expect(mockOpportunityFindMany).toHaveBeenCalledWith({
      where: { opportunityId: { in: ["manual_url:a-1", "manual_url:b-2"] } },
      select: { opportunityId: true, title: true },
    });
  });

  it("joins submitter cwids to scholar names in one deduped query, fail-soft to {}", async () => {
    mockGetEffectiveEditSession.mockResolvedValue({ isSuperuser: true, isDeveloper: false });
    mockListSubmissions.mockResolvedValue([
      { submissionId: "s1", submittedBy: "admin", producedOpportunityIds: [] },
      { submissionId: "s2", submittedBy: "admin", producedOpportunityIds: [] },
      // A submitter with no scholar row (e.g. IT staff) simply has no entry.
      { submissionId: "s3", submittedBy: "ops", producedOpportunityIds: [] },
    ]);
    mockScholarFindMany.mockResolvedValue([{ cwid: "admin", preferredName: "Ada Admin" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).submitterNames).toEqual({ admin: "Ada Admin" });
    expect(mockScholarFindMany).toHaveBeenCalledTimes(1);
    expect(mockScholarFindMany).toHaveBeenCalledWith({
      where: { cwid: { in: ["admin", "ops"] } },
      select: { cwid: true, preferredName: true },
    });

    // And the fail-soft posture, same as titles: a scholar read failure is a 200.
    mockScholarFindMany.mockRejectedValue(new Error("mysql down"));
    const res2 = await GET();
    expect(res2.status).toBe(200);
    expect((await res2.json()).submitterNames).toEqual({});
  });

  it("degrades to an empty title map (still 200) when the corpus read fails", async () => {
    mockGetEffectiveEditSession.mockResolvedValue({ isSuperuser: true, isDeveloper: false });
    mockListSubmissions.mockResolvedValue([
      { submissionId: "s1", producedOpportunityIds: ["manual_url:a-1"] },
    ]);
    mockOpportunityFindMany.mockRejectedValue(new Error("mysql down"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).opportunityTitles).toEqual({});
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
        suppressedAt: null,
      },
    ]);
    const res = await POST(postRequest({ url: "https://www.hartwell.org/award?utm_source=x" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: "duplicate_url",
      existing: {
        opportunityId: "wcm_curated:hartwell-abc123",
        title: "Hartwell Award",
        suppressedAt: null,
      },
    });
    expect(mockPutSubmission).not.toHaveBeenCalled();
  });

  it("carries the duplicate's suppressed state so the panel can say 'duplicate of a suppressed row'", async () => {
    mockOpportunityFindMany.mockResolvedValue([
      {
        opportunityId: "manual_url:x-abc123",
        title: "Suppressed Award",
        sourceUrl: "https://x.org/award",
        suppressedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ]);
    const res = await POST(postRequest({ url: "https://x.org/award" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("duplicate_url");
    expect(body.existing.suppressedAt).toBe("2026-08-01T00:00:00.000Z");
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
    expect(await res.json()).toEqual({
      ok: true,
      submissionId: SK,
      suppressedOpportunityIds: [],
    });

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
        afterValues: { status: "suppressed", suppressed_opportunity_ids: [] },
      }),
    );
    expect(mockOpportunityUpdate).not.toHaveBeenCalled();
  });

  it("cascades the suppression to a projected corpus row carrying the same URL", async () => {
    mockGetSubmission.mockResolvedValue(
      queueItem({ status: "processed", producedOpportunityIds: ["manual_url:x-abc123"] }),
    );
    mockSuppressSubmission.mockResolvedValue(undefined);
    // Corpus URLs are stored raw — the match must normalize at compare time.
    // The already-suppressed row keeps its original attribution (skipped).
    mockOpportunityFindMany.mockResolvedValue([
      {
        opportunityId: "manual_url:x-abc123",
        sourceUrl: "https://X.org/grants/",
        suppressedAt: null,
      },
      {
        opportunityId: "manual_url:y-def456",
        sourceUrl: "https://x.org/grants",
        suppressedAt: new Date("2026-08-01T00:00:00Z"),
      },
      { opportunityId: "grants_gov:1", sourceUrl: "https://other.org/nofo", suppressedAt: null },
    ]);
    const res = await PATCH(
      postRequest({ submissionId: SK, action: "suppress", reason: "  dead link  " }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      submissionId: SK,
      suppressedOpportunityIds: ["manual_url:x-abc123"],
    });

    // The cascade read must land BEFORE the queue flip — a read failure after
    // the flip would strand the cascade behind the already_suppressed guard.
    expect(mockOpportunityFindMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockSuppressSubmission.mock.invocationCallOrder[0],
    );
    expect(mockOpportunityUpdate).toHaveBeenCalledTimes(1);
    expect(mockOpportunityUpdate).toHaveBeenCalledWith({
      where: { opportunityId: "manual_url:x-abc123" },
      data: {
        suppressedAt: expect.any(Date),
        suppressedBy: "flm4001",
        suppressReason: "dead link",
      },
    });
    // One `opportunity` suppression_create per cascaded row + the submission row.
    expect(mockAppendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetEntityType: "opportunity",
        targetEntityId: "manual_url:x-abc123",
        action: "suppression_create",
        afterValues: expect.objectContaining({
          suppressed_by: "flm4001",
          suppress_reason: "dead link",
        }),
      }),
    );
    expect(mockAppendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "opportunity_submission_suppress",
        afterValues: {
          status: "suppressed",
          suppressed_opportunity_ids: ["manual_url:x-abc123"],
        },
      }),
    );
  });

  it("stays drain-only while MATCHA_ADMIN is off — no corpus read or write", async () => {
    process.env.MATCHA_ADMIN = "off";
    mockGetSubmission.mockResolvedValue(queueItem({ status: "processed" }));
    mockSuppressSubmission.mockResolvedValue(undefined);
    const res = await PATCH(postRequest({ submissionId: SK, action: "suppress" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, submissionId: SK, suppressedOpportunityIds: [] });
    expect(mockOpportunityFindMany).not.toHaveBeenCalled();
    expect(mockOpportunityUpdate).not.toHaveBeenCalled();
  });

  it("re-drives a stranded cascade on a retried suppress instead of 409ing", async () => {
    // An earlier PATCH committed the queue flip, then lost its cascade
    // transaction — the retry finds status=suppressed with a live corpus row.
    mockGetSubmission.mockResolvedValue(queueItem({ status: "suppressed" }));
    mockOpportunityFindMany.mockResolvedValue([
      { opportunityId: "manual_url:x-abc123", sourceUrl: "https://x.org/grants", suppressedAt: null },
    ]);
    const res = await PATCH(postRequest({ submissionId: SK, action: "suppress" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      submissionId: SK,
      suppressedOpportunityIds: ["manual_url:x-abc123"],
    });
    expect(mockSuppressSubmission).not.toHaveBeenCalled();
    expect(mockOpportunityUpdate).toHaveBeenCalledTimes(1);
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
