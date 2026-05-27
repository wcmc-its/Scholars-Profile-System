/**
 * POST /api/edit/request-change — the server mailer endpoint (#160 Phase 2).
 * Mirrors the edit-suppress-route mocking. Verifies the dormant 503, server-side
 * recipient resolution, the non-routable + authz gates, send-first ordering, and
 * the best-effort audit that never rolls back a sent email (#493 grant gap).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockIsMailerConfigured,
  mockSendMail,
  mockAppendAuditRow,
  mockTransaction,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockIsMailerConfigured: vi.fn(),
  mockSendMail: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/edit/mailer", () => ({
  isMailerConfigured: mockIsMailerConfigured,
  sendMail: mockSendMail,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/db", () => ({ db: { write: { $transaction: mockTransaction } } }));

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
  mockGetEditSession.mockResolvedValue(SELF);
  mockIsMailerConfigured.mockReturnValue(true);
  mockSendMail.mockResolvedValue({ messageId: "msg-1" });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (cb: (tx: { $executeRaw: () => void }) => unknown) =>
    cb({ $executeRaw: vi.fn() }),
  );
});

describe("POST /api/edit/request-change", () => {
  it("503 send_disabled when the mailer is dark (client falls back to mailto)", async () => {
    mockIsMailerConfigured.mockReturnValue(false);
    const res = await POST(post({ attribute: "education", issueId: "education-wrong" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "send_disabled" });
    expect(mockSendMail).not.toHaveBeenCalled();
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
});
