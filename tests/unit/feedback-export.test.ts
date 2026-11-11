/**
 * Feedback CSV export — `lib/feedback/export.ts` helpers and
 * `GET /api/edit/feedback/export` (docs/feedback-badge-spec.md § CSV export).
 * All CWIDs and text here are fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  FEEDBACK_EXPORT_COLUMNS,
  feedbackCsvCell,
  feedbackToCsv,
  isFeedbackExportAllowlisted,
  parseFeedbackExportFilters,
} from "@/lib/feedback/export";

const { mockGetSession, mockIsSuperuser, mockFindMany, mockAppend, mockLogDenial } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockIsSuperuser: vi.fn(),
  mockFindMany: vi.fn(),
  mockAppend: vi.fn(),
  mockLogDenial: vi.fn(),
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: mockIsSuperuser }));
vi.mock("@/lib/db", () => ({
  db: { read: { feedbackSubmission: { findMany: mockFindMany } }, write: { tag: "write-client" } },
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppend }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogDenial }));

import { GET } from "@/app/api/edit/feedback/export/route";

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: "f-1",
    submittedAt: new Date("2026-11-03T15:00:00.000Z"),
    mode: "contextual",
    pageUrl: "https://example.test/profile/x",
    pageRoute: "/profile/[slug]",
    cwid: null,
    purpose: "research_story",
    purposeOther: null,
    taskSuccess: "yes",
    taskFailureIntent: null,
    usefulness: 4,
    whatHelped: 'Clear, "fast", and\nhelpful',
    whatMissing: null,
    accuracy: 2,
    oneChange: "=HYPERLINK(1)",
    wouldUseAgain: 5,
    role: "faculty",
    roleOther: null,
    consent: true,
    consentVersion: "v1",
    contactEmail: null,
    followupOptin: false,
    ...over,
  }) as never;

describe("isFeedbackExportAllowlisted", () => {
  it("matches trimmed, case-insensitive entries; empty or unset allows nobody", () => {
    expect(isFeedbackExportAllowlisted("abc1001", " ABC1001 , xyz2002")).toBe(true);
    expect(isFeedbackExportAllowlisted("xyz2002", "abc1001,xyz2002")).toBe(true);
    expect(isFeedbackExportAllowlisted("qqq3003", "abc1001,xyz2002")).toBe(false);
    expect(isFeedbackExportAllowlisted("abc1001", "")).toBe(false);
    expect(isFeedbackExportAllowlisted("abc1001", undefined)).toBe(false);
    expect(isFeedbackExportAllowlisted("", ",,")).toBe(false);
  });
});

describe("parseFeedbackExportFilters", () => {
  const now = new Date("2026-11-11T18:00:00.000Z");
  const parse = (qs: string) => parseFeedbackExportFilters(new URLSearchParams(qs), now);

  it("defaults to the last 30 days ending today, to-day inclusive", () => {
    const f = parse("");
    expect(f).toMatchObject({ from: "2026-10-13", to: "2026-11-11", pageRoute: null });
    if ("error" in f) throw new Error("unexpected");
    expect(f.endExclusive.toISOString()).toBe("2026-11-12T00:00:00.000Z");
  });
  it("accepts an explicit window and pageRoute", () => {
    expect(parse("from=2026-01-01&to=2026-01-31&pageRoute=/search")).toMatchObject({
      from: "2026-01-01",
      to: "2026-01-31",
      pageRoute: "/search",
    });
  });
  it("rejects malformed, impossible, or reversed dates", () => {
    expect(parse("from=yesterday")).toEqual({ error: "invalid_from", field: "from" });
    expect(parse("to=2026-02-30")).toEqual({ error: "invalid_to", field: "to" });
    expect(parse("from=2026-02-01&to=2026-01-01")).toEqual({ error: "from_after_to", field: "from" });
    expect(parse("pageRoute=")).toEqual({ error: "invalid_page_route", field: "pageRoute" });
  });
});

describe("CSV", () => {
  it("quotes commas, quotes and newlines; neutralizes spreadsheet formulas", () => {
    expect(feedbackCsvCell('a, "b"\nc')).toBe('"a, ""b""\nc"');
    expect(feedbackCsvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(feedbackCsvCell("-1+1")).toBe("'-1+1");
    expect(feedbackCsvCell(-1)).toBe("-1");
    expect(feedbackCsvCell(null)).toBe("");
    expect(feedbackCsvCell(false)).toBe("false");
    expect(feedbackCsvCell(new Date("2026-11-03T15:00:00.000Z"))).toBe("2026-11-03T15:00:00.000Z");
  });
  it("header is every DB column; one line per row; truncation is marked", () => {
    const csv = feedbackToCsv([row()], true).split("\r\n");
    expect(csv[0]!.split(",")).toEqual(FEEDBACK_EXPORT_COLUMNS.map(([c]) => c));
    expect(csv[0]).toContain("contact_email");
    expect(csv[1]).toContain('"Clear, ""fast"", and\nhelpful"');
    expect(csv[1]).toContain("'=HYPERLINK(1)");
    expect(csv[csv.length - 1]).toMatch(/^# truncated at/);
  });
});

describe("GET /api/edit/feedback/export", () => {
  const req = (qs = "") => new NextRequest(`http://localhost/api/edit/feedback/export${qs}`);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FEEDBACK_EXPORT_ALLOWLIST = "su0001";
    mockGetSession.mockResolvedValue({ cwid: "su0001" });
    mockIsSuperuser.mockResolvedValue(true);
    mockFindMany.mockResolvedValue([row()]);
    mockAppend.mockResolvedValue(undefined);
  });

  it("401 without a session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("403 for a superuser not on the allowlist, and for an allowlisted non-superuser", async () => {
    process.env.FEEDBACK_EXPORT_ALLOWLIST = "other9999";
    expect((await GET(req())).status).toBe(403);
    process.env.FEEDBACK_EXPORT_ALLOWLIST = "su0001";
    mockIsSuperuser.mockResolvedValueOnce(false);
    expect((await GET(req())).status).toBe(403);
    expect(mockLogDenial).toHaveBeenCalledTimes(2);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("an empty allowlist lets nobody export", async () => {
    process.env.FEEDBACK_EXPORT_ALLOWLIST = "";
    expect((await GET(req())).status).toBe(403);
  });

  it("400 on a malformed date", async () => {
    expect((await GET(req("?from=2026-13-01"))).status).toBe(400);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("returns the CSV, filters the read, and audits the export with its filters", async () => {
    const res = await GET(req("?from=2026-11-01&to=2026-11-10&pageRoute=/search"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="feedback-2026-11-01-2026-11-10.csv"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.text()).split("\r\n")).toHaveLength(2);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          submittedAt: {
            gte: new Date("2026-11-01T00:00:00.000Z"),
            lt: new Date("2026-11-11T00:00:00.000Z"),
          },
          pageRoute: "/search",
        },
      }),
    );
    expect(mockAppend).toHaveBeenCalledWith(
      { tag: "write-client" },
      expect.objectContaining({
        actorCwid: "su0001",
        action: "feedback_export",
        targetEntityType: "feedback_submission",
        targetEntityId: "export",
        afterValues: { from: "2026-11-01", to: "2026-11-10", pageRoute: "/search", rows: 1 },
        impersonatedCwid: null,
      }),
    );
  });

  it("fails closed (500, no file) when the audit write fails", async () => {
    mockAppend.mockRejectedValueOnce(new Error("INSERT denied"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).not.toContain("text/csv");
  });
});
