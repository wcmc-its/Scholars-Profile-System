/**
 * POST /api/edit/request-change — the server mailer endpoint (#160 Phase 2).
 * Mirrors the edit-suppress-route mocking. Verifies the dormant 503, server-side
 * recipient resolution, the non-routable + authz gates, send-first ordering, the
 * best-effort audit that never rolls back a sent email (#493 grant gap), and the
 * per-cwid rate limit (SPEC § 5 abuse controls). The rate-limit *mechanism* is
 * unit-tested in edit-rate-limit.test.ts; here it is mocked to assert the route's
 * gate, superuser exemption, dormant-no-quota ordering, and 429 logging.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockIsMailerConfigured,
  mockSendMail,
  mockAppendAuditRow,
  mockTransaction,
  mockScholarFindUnique,
  mockRecordAttempt,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockIsMailerConfigured: vi.fn(),
  mockSendMail: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockTransaction: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockRecordAttempt: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/edit/mailer", () => ({
  isMailerConfigured: mockIsMailerConfigured,
  sendMail: mockSendMail,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/edit/rate-limit", () => ({ recordRequestChangeAttempt: mockRecordAttempt }));
vi.mock("@/lib/db", () => ({
  db: {
    write: { $transaction: mockTransaction },
    read: { scholar: { findUnique: mockScholarFindUnique } },
  },
}));

import { POST } from "@/app/api/edit/request-change/route";

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/request-change", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(SELF);
  mockIsMailerConfigured.mockReturnValue(true);
  mockSendMail.mockResolvedValue({ messageId: "msg-1" });
  mockAppendAuditRow.mockResolvedValue(undefined);
  // Within the limit by default; the rate-limit tests below opt into a block.
  mockRecordAttempt.mockResolvedValue({ allowed: true, count: 1, limit: 20 });
  mockTransaction.mockImplementation(async (cb: (tx: { $executeRaw: () => void }) => unknown) =>
    cb({ $executeRaw: vi.fn() }),
  );
  // Default: the actor has no resolvable email, so no courtesy receipt is sent
  // and `sendMail` is called once (the office). Receipt tests opt this in.
  mockScholarFindUnique.mockResolvedValue({ email: null });
});

describe("POST /api/edit/request-change", () => {
  it("503 send_disabled when the mailer is dark (client falls back to mailto)", async () => {
    mockIsMailerConfigured.mockReturnValue(false);
    const res = await POST(post({ attribute: "education", issueId: "education-wrong" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "send_disabled" });
    expect(mockSendMail).not.toHaveBeenCalled();
    // The 503 gate precedes the limiter, so a dormant endpoint consumes no quota.
    expect(mockRecordAttempt).not.toHaveBeenCalled();
  });

  it("sends to the resolved office, structured body, returns sent:true", async () => {
    const res = await POST(
      post({
        attribute: "education",
        issueId: "education-wrong",
        itemId: "Ph.D., Stanford",
        detail: "Year is wrong",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sent: true });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const arg = mockSendMail.mock.calls[0][0];
    expect(arg.to).toBe("ofa@med.cornell.edu");
    expect(arg.subject).toBe("Scholars profile correction — Education");
    expect(arg.text).toContain("Item: Ph.D., Stanford");
    expect(arg.text).toContain("Year is wrong");
  });

  it("carries the cc for an OSRA funding request", async () => {
    await POST(post({ attribute: "funding", issueId: "funding-wrong" }));
    expect(mockSendMail.mock.calls[0][0].cc).toBe("scholars@weill.cornell.edu");
  });

  it("400 not_routable for a self-service issue (never sends)", async () => {
    const res = await POST(post({ attribute: "name-title", issueId: "name-wrong" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "not_routable" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("400 invalid_attribute for an unknown attribute", async () => {
    const res = await POST(post({ attribute: "salary", issueId: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_attribute" });
  });

  it("403 when a non-superuser targets another scholar", async () => {
    const res = await POST(
      post({ attribute: "education", issueId: "education-wrong", targetCwid: "other9" }),
    );
    expect(res.status).toBe(403);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("a superuser may submit about another scholar", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(
      post({ attribute: "education", issueId: "education-wrong", targetCwid: "other9" }),
    );
    expect(res.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it("writes a best-effort request_change audit row after the send", async () => {
    await POST(post({ attribute: "funding", issueId: "funding-wrong", itemId: "R01" }));
    expect(mockAppendAuditRow).toHaveBeenCalledTimes(1);
    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("request_change");
    expect(row.targetEntityType).toBe("scholar");
    expect(row.targetEntityId).toBe("self01");
    expect(row.afterValues).toMatchObject({
      attribute: "funding",
      issue_id: "funding-wrong",
      office: "OSRA",
      message_id: "msg-1",
      item_id: "R01",
    });
  });

  it("still returns 200 when the audit INSERT fails (#493 grant gap) — send not rolled back", async () => {
    mockAppendAuditRow.mockRejectedValue(new Error("INSERT command denied"));
    const res = await POST(post({ attribute: "education", issueId: "education-wrong" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it("502 send_failed when the mailer throws (no audit row)", async () => {
    mockSendMail.mockRejectedValue(new Error("SES throttled"));
    const res = await POST(post({ attribute: "education", issueId: "education-wrong" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "send_failed" });
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("400 detail_too_long for an oversized note", async () => {
    const res = await POST(
      post({ attribute: "education", issueId: "education-wrong", detail: "x".repeat(4001) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "detail_too_long" });
  });

  it("sends a courtesy receipt to the submitter by default", async () => {
    mockScholarFindUnique.mockResolvedValue({ email: "self01@med.cornell.edu" });
    await POST(post({ attribute: "education", issueId: "education-wrong", itemId: "Ph.D." }));
    expect(mockSendMail).toHaveBeenCalledTimes(2); // office + receipt
    const receipt = mockSendMail.mock.calls[1][0];
    expect(receipt.to).toBe("self01@med.cornell.edu");
    expect(receipt.subject).toBe("Your Scholars profile change request — Education");
    expect(receipt.text).toContain("Routed to: Office of Faculty Affairs");
  });

  it("omits the receipt when the submitter opts out (noReceipt)", async () => {
    mockScholarFindUnique.mockResolvedValue({ email: "self01@med.cornell.edu" });
    await POST(post({ attribute: "education", issueId: "education-wrong", noReceipt: true }));
    expect(mockSendMail).toHaveBeenCalledTimes(1); // office only
  });

  it("skips the receipt when the actor has no email (e.g. a superuser not in the scholar table)", async () => {
    mockScholarFindUnique.mockResolvedValue({ email: null });
    await POST(post({ attribute: "education", issueId: "education-wrong" }));
    expect(mockSendMail).toHaveBeenCalledTimes(1); // office only, no throw
  });

  it("still returns 200 when the receipt send fails (best-effort, after the office send)", async () => {
    mockScholarFindUnique.mockResolvedValue({ email: "self01@med.cornell.edu" });
    mockSendMail
      .mockResolvedValueOnce({ messageId: "office-1" }) // office send ok
      .mockRejectedValueOnce(new Error("SES throttled")); // receipt send fails
    const res = await POST(post({ attribute: "education", issueId: "education-wrong" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true });
  });

  it("400 invalid_receipt_flag when noReceipt is not a boolean", async () => {
    const res = await POST(
      post({ attribute: "education", issueId: "education-wrong", noReceipt: "yes" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_receipt_flag" });
  });

  describe("per-cwid rate limit (SPEC § 5)", () => {
    it("counts one attempt against the actor's cwid before sending", async () => {
      await POST(post({ attribute: "education", issueId: "education-wrong" }));
      expect(mockRecordAttempt).toHaveBeenCalledWith("self01");
    });

    it("429 rate_limited with a Retry-After header, and no send, when over the limit", async () => {
      mockRecordAttempt.mockResolvedValue({
        allowed: false,
        count: 21,
        limit: 20,
        retryAfterSeconds: 1800,
      });
      const res = await POST(post({ attribute: "education", issueId: "education-wrong" }));
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("1800");
      expect(await res.json()).toMatchObject({ ok: false, error: "rate_limited" });
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(mockAppendAuditRow).not.toHaveBeenCalled();
    });

    it("logs every 429 with the actor cwid and observed count", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockRecordAttempt.mockResolvedValue({
        allowed: false,
        count: 25,
        limit: 20,
        retryAfterSeconds: 600,
      });
      await POST(post({ attribute: "education", issueId: "education-wrong" }));
      const line = JSON.parse(warn.mock.calls[0][0] as string);
      expect(line).toMatchObject({
        event: "request_change_rate_limited",
        actor_cwid: "self01",
        count: 25,
        limit: 20,
      });
    });

    it("exempts superusers — never consults the limiter, sends regardless", async () => {
      mockGetEditSession.mockResolvedValue(ADMIN);
      // A blocked verdict here would be ignored, because it is never requested.
      mockRecordAttempt.mockResolvedValue({
        allowed: false,
        count: 999,
        limit: 20,
        retryAfterSeconds: 1,
      });
      const res = await POST(
        post({ attribute: "education", issueId: "education-wrong", targetCwid: "other9" }),
      );
      expect(res.status).toBe(200);
      expect(mockRecordAttempt).not.toHaveBeenCalled();
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });
  });
});
