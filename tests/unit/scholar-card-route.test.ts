/**
 * `GET /api/edit/scholar-card/[cwid]` — the gate (roster scope OR any report
 * grant) and the internal-viewer email release passed to the loader.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSession, mockScope, mockReportAccess, mockLoadCard } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockScope: vi.fn(),
  mockReportAccess: vi.fn(),
  mockLoadCard: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));
vi.mock("@/lib/edit/data-quality", () => ({
  loadDataQualityScope: mockScope,
  isEmptyScope: (s: { all: boolean; unitCodes?: string[] }) => !s.all && (s.unitCodes ?? []).length === 0,
}));
vi.mock("@/lib/edit/report-access", () => ({ hasAnyReportAccess: mockReportAccess }));
vi.mock("@/lib/api/data-quality", () => ({ loadScholarCard: mockLoadCard }));
vi.mock("@/lib/profile/email-visibility-flags", () => ({ isEmailReleaseGateEnabled: () => true }));

import { GET } from "@/app/api/edit/scholar-card/[cwid]/route";

const call = (cwid = "abc1001") => GET(new Request("http://x"), { params: Promise.resolve({ cwid }) });

describe("scholar-card route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.mockResolvedValue({ cwid: "viewer1" });
    mockScope.mockResolvedValue({ all: false, unitCodes: [] });
    mockReportAccess.mockResolvedValue(false);
    mockLoadCard.mockResolvedValue({ cwid: "abc1001" });
  });

  it("401s without a session", async () => {
    mockSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it("403s a viewer with no roster scope and no report grant, before any read", async () => {
    expect((await call()).status).toBe(403);
    expect(mockLoadCard).not.toHaveBeenCalled();
  });

  it("admits a report grantee and releases email as for an internal viewer", async () => {
    mockReportAccess.mockResolvedValue(true);
    expect((await call()).status).toBe(200);
    const gate = mockLoadCard.mock.calls[0][2];
    expect(gate("a@b.c", "institution")).toBe("a@b.c");
    expect(gate("a@b.c", "none")).toBeNull();
  });

  it("admits a roster-scoped viewer; 404s a malformed or unknown cwid", async () => {
    mockScope.mockResolvedValue({ all: true });
    expect((await call("../x")).status).toBe(404);
    mockLoadCard.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
