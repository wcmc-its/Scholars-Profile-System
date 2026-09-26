/**
 * POST /api/edit/report-access — gating + validation + the grant/revoke
 * dispatch. Mirrors `coi-gap-dismiss-route.test.ts`: the real
 * `readEditRequest` preamble runs (origin check stubbed ok), the session
 * seams are mocked, and `lib/edit/report-access` is mocked at the module
 * boundary so this suite asserts what the route wires where, not the
 * grant functions' own logic (covered in `report-access.test.ts`). One
 * wiring fact is load-bearing: the rows the route answers with are the ones
 * the WRITE returned (read on the writer, inside its transaction) — the route
 * must never re-fetch them through `listReportAccess`, whose default client
 * is the reader replica (the read-your-writes race, `core-client` PR #2620).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockGetEffectiveEditSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockImpersonationActive: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockGrant: vi.fn(),
  mockRevoke: vi.fn(),
  mockList: vi.fn(),
  mockFetchDirectory: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.mockGetEffectiveEditSession,
  impersonationActive: h.mockImpersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.mockGetSession }));
vi.mock("@/lib/auth/session", () => ({ nowSeconds: () => 1_000 }));
vi.mock("@/lib/edit/authz", () => ({
  verifyRequestOrigin: () => ({ ok: true }),
  logEditDenial: h.mockLogEditDenial,
}));
vi.mock("@/lib/edit/report-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/report-access")>();
  return {
    ...actual,
    grantReportAccess: h.mockGrant,
    revokeReportAccess: h.mockRevoke,
    listReportAccess: h.mockList,
  };
});
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/lib/sources/ldap", () => ({ fetchDirectoryPeopleByCwid: h.mockFetchDirectory }));

import { POST } from "@/app/api/edit/report-access/route";
import { resetDirectoryNameCache } from "@/lib/edit/directory-names";

const ADMIN = "adm0001";
const PLAIN = "usr0001";

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/edit/report-access", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

function asGenuine(cwid: string, roles: { isSuperuser?: boolean; isCommsSteward?: boolean } = {}) {
  h.mockGetEffectiveEditSession.mockResolvedValue({
    cwid,
    isSuperuser: roles.isSuperuser ?? false,
    isCommsSteward: roles.isCommsSteward ?? false,
  });
  h.mockGetSession.mockResolvedValue({ cwid, iat: 0, exp: 0 });
  h.mockImpersonationActive.mockReturnValue(false);
}

const VALID = { op: "grant", reportKey: "mentored-publications", scopeKey: "md", cwid: "Abc1234" };

/** The list as the write hands it back (writer-side, in-transaction), each
 *  row already carrying its stored `granteeName` and resolved `name`. */
const WRITTEN_ROWS = [
  {
    reportKey: "mentored-publications",
    scopeKey: "md",
    cwid: "abc1234",
    grantedBy: ADMIN,
    grantedAt: new Date("2026-09-18T12:00:00Z"),
    granteeName: "Staff Person",
    name: "Staff Person",
  },
];
/** What a reader-side `listReportAccess` would answer — deliberately
 *  different, so a route that re-fetched would be caught by the body. */
const READER_ROWS = [{ ...WRITTEN_ROWS[0], cwid: "rdr0001", scopeKey: "ecr" }];

beforeEach(() => {
  vi.clearAllMocks();
  resetDirectoryNameCache();
  h.mockFetchDirectory.mockResolvedValue([]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  asGenuine(ADMIN, { isSuperuser: true });
  h.mockGrant.mockResolvedValue({ changed: true, rows: WRITTEN_ROWS });
  h.mockRevoke.mockResolvedValue({ changed: true, rows: WRITTEN_ROWS });
  h.mockList.mockResolvedValue(READER_ROWS);
});

describe("POST /api/edit/report-access — gating", () => {
  it("401 with no session", async () => {
    h.mockGetEffectiveEditSession.mockResolvedValue(null);
    const res = await POST(post(VALID));
    expect(res.status).toBe(401);
    expect(h.mockGrant).not.toHaveBeenCalled();
  });

  it("403 not_comms_steward for a plain user, before any field is validated", async () => {
    asGenuine(PLAIN);
    const res = await POST(post({ op: "bogus" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_comms_steward" });
    expect(h.mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ actorCwid: PLAIN, reason: "not_comms_steward" }),
    );
    expect(h.mockGrant).not.toHaveBeenCalled();
  });

  it("a comms_steward passes", async () => {
    asGenuine("stw0001", { isCommsSteward: true });
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(h.mockGrant).toHaveBeenCalledWith(expect.objectContaining({ actorCwid: "stw0001" }));
  });
});

describe("POST /api/edit/report-access — validation", () => {
  it.each([
    [{ ...VALID, op: "delete" }, "invalid_op"],
    [{ ...VALID, reportKey: "other-report" }, "invalid_report_key"],
    [{ ...VALID, reportKey: "toString" }, "invalid_report_key"],
    [{ ...VALID, reportKey: "article-count", scopeKey: "md" }, "invalid_scope_key"],
    [{ ...VALID, reportKey: "high-impact-publications", scopeKey: "md" }, "invalid_scope_key"],
    [{ ...VALID, scopeKey: "phd" }, "invalid_scope_key"],
    [{ ...VALID, cwid: "1abc" }, "invalid_cwid"],
    [{ ...VALID, cwid: "a" }, "invalid_cwid"],
    [{ ...VALID, cwid: "abcdefghijklm" }, "invalid_cwid"],
    [{ ...VALID, cwid: 42 }, "invalid_cwid"],
  ])("400 for %j → %s", async (body, error) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error });
    expect(h.mockGrant).not.toHaveBeenCalled();
    expect(h.mockRevoke).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/report-access — writes", () => {
  it("grant: lowercases the cwid, keys the audit on the real actor, returns the updated list", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(h.mockGrant).toHaveBeenCalledWith({
      reportKey: "mentored-publications",
      scopeKey: "md",
      cwid: "abc1234",
      actorCwid: ADMIN,
      impersonatedCwid: null,
      requestId: expect.any(String),
      granteeName: null,
    });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, op: "grant", changed: true });
    expect(body.rows).toEqual([
      expect.objectContaining({
        cwid: "abc1234",
        scopeKey: "md",
        grantedAt: "2026-09-18T12:00:00.000Z",
        granteeName: "Staff Person",
        name: "Staff Person",
      }),
    ]);
    expect(h.mockRevoke).not.toHaveBeenCalled();
  });

  describe("grant `name` → granteeName (a display convenience, never a 400)", () => {
    it("a string is trimmed and passed through", async () => {
      const res = await POST(post({ ...VALID, name: "  Staff Person  " }));
      expect(res.status).toBe(200);
      expect(h.mockGrant).toHaveBeenCalledWith(expect.objectContaining({ granteeName: "Staff Person" }));
    });

    it("a 300-char name is stored as null (VARCHAR(255)), the grant still lands", async () => {
      const res = await POST(post({ ...VALID, name: "x".repeat(300) }));
      expect(res.status).toBe(200);
      expect(h.mockGrant).toHaveBeenCalledWith(expect.objectContaining({ granteeName: null }));
    });

    it("a 255-char name is kept whole", async () => {
      const res = await POST(post({ ...VALID, name: "y".repeat(255) }));
      expect(res.status).toBe(200);
      expect(h.mockGrant).toHaveBeenCalledWith(expect.objectContaining({ granteeName: "y".repeat(255) }));
    });

    it.each([[42], [null], [{ first: "A" }], [""], ["   "]])("%j → null", async (name) => {
      const res = await POST(post({ ...VALID, name }));
      expect(res.status).toBe(200);
      expect(h.mockGrant).toHaveBeenCalledWith(expect.objectContaining({ granteeName: null }));
    });

    it("revoke ignores name — none reaches revokeReportAccess", async () => {
      const res = await POST(post({ ...VALID, op: "revoke", name: "Staff Person" }));
      expect(res.status).toBe(200);
      expect(h.mockRevoke).toHaveBeenCalledTimes(1);
      expect(h.mockRevoke.mock.calls[0][0]).not.toHaveProperty("granteeName");
      expect(h.mockGrant).not.toHaveBeenCalled();
    });
  });

  it("answers with the rows the WRITE returned, never a reader-side re-fetch", async () => {
    const res = await POST(post(VALID));
    const body = await res.json();
    expect(body.rows.map((r: { cwid: string }) => r.cwid)).toEqual(["abc1234"]);
    expect(h.mockList).not.toHaveBeenCalled();
  });

  it("revoke: dispatches to revokeReportAccess, accepts the wildcard scope, returns the write's rows", async () => {
    h.mockRevoke.mockResolvedValue({ changed: false, rows: [] });
    const res = await POST(post({ ...VALID, op: "revoke", scopeKey: "*" }));
    expect(res.status).toBe(200);
    expect(h.mockRevoke).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: "*", cwid: "abc1234" }));
    expect(await res.json()).toMatchObject({ ok: true, op: "revoke", changed: false, rows: [] });
    expect(h.mockGrant).not.toHaveBeenCalled();
    expect(h.mockList).not.toHaveBeenCalled();
  });

  it.each(["article-count", "high-impact-publications"])(
    "grant: %s takes a whole-report (wildcard) grant",
    async (reportKey) => {
      const res = await POST(post({ ...VALID, reportKey, scopeKey: "*" }));
      expect(res.status).toBe(200);
      expect(h.mockGrant).toHaveBeenCalledWith(expect.objectContaining({ reportKey, scopeKey: "*" }));
    },
  );

  it("500 write_failed when the grant throws", async () => {
    h.mockGrant.mockRejectedValue(new Error("boom"));
    const res = await POST(post(VALID));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});

describe("POST /api/edit/report-access — ED names", () => {
  const BARE = { ...WRITTEN_ROWS[0], cwid: "fake777", granteeName: null, name: "fake777" };

  it("fills a grantee with no Scholar row and no stored name from ED", async () => {
    h.mockGrant.mockResolvedValue({ changed: true, rows: [WRITTEN_ROWS[0], BARE] });
    h.mockFetchDirectory.mockResolvedValue([
      {
        cwid: "fake777",
        name: "Doe, Dana",
        title: null,
        dept: null,
        firstName: "Dana",
        lastName: "Doe",
        email: null,
      },
    ]);
    const res = await POST(post(VALID));
    const body = (await res.json()) as { rows: Array<{ cwid: string; name: string }> };
    expect(h.mockFetchDirectory).toHaveBeenCalledWith(["fake777"]);
    expect(body.rows.map((r) => [r.cwid, r.name])).toEqual([
      ["abc1234", "Staff Person"],
      ["fake777", "Dana Doe"],
    ]);
  });

  it("an ED failure still answers 200 with the CWID", async () => {
    h.mockGrant.mockResolvedValue({ changed: true, rows: [BARE] });
    h.mockFetchDirectory.mockRejectedValue(new Error("ldap down"));
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ name: string }> };
    expect(body.rows[0]!.name).toBe("fake777");
  });
});
