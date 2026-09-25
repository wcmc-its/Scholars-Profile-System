/**
 * GET /api/edit/activity/recent — the "Load older" page of the /edit/activity
 * feed. Verifies the superuser gate (401 / 403 with a logged denial, the read
 * never runs), cursor validation (400, the read never runs), the decoded
 * cursor and the summary's `asOf` reaching the loader, and a 503 (not a 500) when the audit read fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockGetSession, mockLoadOlder, mockLogDenial } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockLoadOlder: vi.fn(),
  mockLogDenial: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetSession,
}));
vi.mock("@/lib/db", () => ({ db: { read: { tag: "read-client" } } }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogDenial }));
vi.mock("@/lib/api/edit-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/edit-activity")>()),
  loadOlderEdits: mockLoadOlder,
}));

import { GET } from "@/app/api/edit/activity/recent/route";

const CURSOR = "2026-09-24T12:00:00.123Z_4242";
const AS_OF = "2026-09-24T20:00:00.000Z";
const QS = `?cursor=${encodeURIComponent(CURSOR)}&asOf=${encodeURIComponent(AS_OF)}`;
const req = (qs: string) => new NextRequest(`https://app.example/api/edit/activity/recent${qs}`);

const PAGE = {
  recent: [
    {
      id: "4241",
      ts: "2026-09-24T11:59:00.000Z",
      actorCwid: "abc1234",
      impersonatedCwid: null,
      action: "field_override",
      entityType: "scholar",
      entityId: "sch0001",
      changes: [],
      detail: null,
    },
  ],
  nextCursor: "2026-09-24T11:59:00.000Z_4241",
  people: { abc1234: { name: "Ada Editor", title: null } },
  entityNames: {},
};

describe("GET /api/edit/activity/recent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetSession.mockResolvedValue({ cwid: "su00001", isSuperuser: true });
    mockLoadOlder.mockResolvedValue(PAGE);
  });

  it("401 without a session; the audit read never runs", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(req(QS));
    expect(res.status).toBe(401);
    expect(mockLoadOlder).not.toHaveBeenCalled();
  });

  it("403 for a non-superuser, with a logged denial; the audit read never runs", async () => {
    mockGetSession.mockResolvedValue({ cwid: "usr0001", isSuperuser: false });
    const res = await GET(req(QS));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "not_superuser" });
    expect(mockLogDenial).toHaveBeenCalledWith(
      expect.objectContaining({ actorCwid: "usr0001", path: "/api/edit/activity/recent" }),
    );
    expect(mockLoadOlder).not.toHaveBeenCalled();
  });

  it("400 for a missing or malformed cursor", async () => {
    for (const qs of ["", "?cursor=", "?cursor=nope", "?cursor=2026-09-24T12:00:00.000Z_x"]) {
      const res = await GET(req(qs));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "invalid_cursor", field: "cursor" });
    }
    expect(mockLoadOlder).not.toHaveBeenCalled();
  });

  it("400 for a missing or malformed asOf; the window is never recomputed from request time", async () => {
    const c = `?cursor=${encodeURIComponent(CURSOR)}`;
    for (const qs of [c, `${c}&asOf=`, `${c}&asOf=yesterday`, `${c}&asOf=2026-09-24`]) {
      const res = await GET(req(qs));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "invalid_as_of", field: "asOf" });
    }
    expect(mockLoadOlder).not.toHaveBeenCalled();
  });

  it("passes the decoded (ts, id) cursor to the read and returns the page", async () => {
    const res = await GET(req(QS));
    expect(res.status).toBe(200);
    expect(mockLoadOlder).toHaveBeenCalledWith(
      { tag: "read-client" },
      {
        ts: new Date("2026-09-24T12:00:00.123Z"),
        id: 4242n,
      },
      new Date(AS_OF),
    );
    expect(await res.json()).toEqual({ ok: true, ...PAGE });
  });

  it("503 (not a 500) when the audit read throws", async () => {
    mockLoadOlder.mockRejectedValue(new Error("SELECT command denied"));
    const res = await GET(req(QS));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "activity_unavailable" });
  });
});
