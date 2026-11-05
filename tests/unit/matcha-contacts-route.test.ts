/**
 * `/api/edit/matcha/contacts` — the Matcha contact address lookup:
 *  - 404 unless BOTH `MATCHA` and `MATCHA_BRIEF` are on;
 *  - superuser/developer only (the brief-drafting gate) — an observer gets 403;
 *  - a cwid absent from the SAVED result is refused (400), as the brief POST does;
 *  - more than 50 people is refused with 400, never truncated;
 *  - people without an address come back as `missing`, never silently dropped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockReadEditRequest,
  mockLogEditDenial,
  mockSubFindUnique,
  mockSubFindMany,
  mockScholarFindMany,
  mockOfficer,
} = vi.hoisted(() => ({
  mockReadEditRequest: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockSubFindUnique: vi.fn(),
  mockSubFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockOfficer: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      sponsorMatchSubmission: { findUnique: mockSubFindUnique, findMany: mockSubFindMany },
      scholar: { findMany: mockScholarFindMany },
    },
  },
}));
vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogEditDenial }));
vi.mock("@/lib/api/matcha-report", () => ({ loadOfficerContact: mockOfficer }));

import { POST } from "@/app/api/edit/matcha/contacts/route";

const devSession = { cwid: "dev1", isSuperuser: false, isDeveloper: true };
function req(session: Record<string, unknown>, body: Record<string, unknown>) {
  mockReadEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session,
      effective: session,
      realCwid: session.cwid,
      impersonatedCwid: null,
      requestId: "req-1",
      body,
    },
  });
  return {} as NextRequest;
}

const cand = (cwid: string) => ({
  cwid,
  name: `Stored ${cwid}`,
  profileSlug: cwid,
  title: null,
  department: null,
  fusedScore: 1,
  contributions: [],
  technologyCount: 0,
});
const STORED = ["a", "b", "c", ...Array.from({ length: 60 }, (_, i) => `p${i}`)];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATCHA = "on";
  process.env.MATCHA_BRIEF = "on";
  process.env.SCHOLAR_LIST_EXPORT_EMAIL = "on";
  mockSubFindUnique.mockResolvedValue({ descriptionHash: "h1" });
  mockSubFindMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
    args.select.resultKey
      ? [{ id: "r1", resultKey: "sponsor:spine:v3:h1" }]
      : [{ id: "r1", result: { concepts: [], candidates: STORED.map(cand) } }],
  );
  mockScholarFindMany.mockImplementation(async (args: { where: { cwid: { in: string[] } } }) =>
    args.where.cwid.in
      // "b" has no address on record; "c" has no active Scholar row.
      .filter((c) => c !== "c")
      .map((cwid) => ({
        cwid,
        preferredName: `Jane ${cwid.toUpperCase()}`,
        email: cwid === "b" ? null : `${cwid}@researcher.example.org`,
        roleCategory: "full_time_faculty",
        // "d" released the address to nobody (the release gate withholds it when on).
        emailVisibility: cwid === "d" ? "none" : "institution",
      })),
  );
  mockOfficer.mockResolvedValue({
    name: "Olive Officer",
    email: "officer@example.org",
    dept: null,
  });
});

describe("POST /api/edit/matcha/contacts", () => {
  it("404s when MATCHA_BRIEF is off", async () => {
    process.env.MATCHA_BRIEF = "off";
    const r = await POST(req(devSession, { submissionId: "s1", cwids: ["a"] }));
    expect(r.status).toBe(404);
    expect(mockReadEditRequest).not.toHaveBeenCalled();
  });

  it("404s when MATCHA is off", async () => {
    process.env.MATCHA = "off";
    expect((await POST(req(devSession, { submissionId: "s1", cwids: ["a"] }))).status).toBe(404);
  });

  it("refuses an observer (403) and logs the denial, without reading any address", async () => {
    const observer = { cwid: "obs1", isSuperuser: false, isDeveloper: false, isObserver: true };
    const r = await POST(req(observer, { submissionId: "s1", cwids: ["a"] }));
    expect(r.status).toBe(403);
    expect(mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ actorCwid: "obs1", reason: "not_developer_contact" }),
    );
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });

  it("lets a superuser through", async () => {
    const su = { cwid: "su1", isSuperuser: true, isDeveloper: false };
    expect((await POST(req(su, { submissionId: "s1", cwids: ["a"] }))).status).toBe(200);
  });

  it("returns contacts, reports missing addresses, and names the officer", async () => {
    const r = await POST(req(devSession, { submissionId: "s1", cwids: ["a", "b", "c", "a"] }));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(body.contacts).toEqual([
      { cwid: "a", name: "Jane A", email: "a@researcher.example.org" },
    ]);
    expect(body.missing).toEqual([
      { cwid: "b", name: "Jane B" },
      { cwid: "c", name: "Stored c" },
    ]);
    expect(body.officer).toEqual({ name: "Olive Officer", email: "officer@example.org" });
    expect(mockOfficer).toHaveBeenCalledWith("dev1");
    // Only active scholars are read.
    expect(mockScholarFindMany.mock.calls[0][0].where).toMatchObject({
      deletedAt: null,
      status: "active",
    });
  });

  it("returns no addresses when the export-email kill switch is off", async () => {
    process.env.SCHOLAR_LIST_EXPORT_EMAIL = "off";
    const body = await (await POST(req(devSession, { submissionId: "s1", cwids: ["a"] }))).json();
    expect(body.contacts).toEqual([]);
    expect(body.missing).toEqual([{ cwid: "a", name: "Jane A" }]);
  });

  it("withholds an address its owner has not released when the release gate is on", async () => {
    STORED.push("d");
    process.env.PROFILE_EMAIL_RELEASE_GATE = "on";
    try {
      const body = await (
        await POST(req(devSession, { submissionId: "s1", cwids: ["a", "d"] }))
      ).json();
      expect(body.contacts.map((c: { cwid: string }) => c.cwid)).toEqual(["a"]);
      expect(body.missing).toEqual([{ cwid: "d", name: "Jane D" }]);
      process.env.PROFILE_EMAIL_RELEASE_GATE = "off";
      const open = await (
        await POST(req(devSession, { submissionId: "s1", cwids: ["a", "d"] }))
      ).json();
      expect(open.contacts.map((c: { cwid: string }) => c.cwid)).toEqual(["a", "d"]);
    } finally {
      delete process.env.PROFILE_EMAIL_RELEASE_GATE;
      STORED.pop();
    }
  });

  it("refuses a cwid that is not in the saved result, like the brief POST", async () => {
    const r = await POST(req(devSession, { submissionId: "s1", cwids: ["a", "zzz9999"] }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("cwid_not_in_results");
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });

  it("refuses more than 50 people with 400 rather than truncating", async () => {
    const cwids = STORED.slice(3, 54); // 51 distinct, all in the stored result
    const r = await POST(req(devSession, { submissionId: "s1", cwids }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("over_contact_cap");
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });

  it("accepts exactly 50", async () => {
    const cwids = STORED.slice(3, 53);
    const r = await POST(req(devSession, { submissionId: "s1", cwids }));
    expect(r.status).toBe(200);
    expect((await r.json()).contacts).toHaveLength(50);
  });

  it("validates the body", async () => {
    expect((await POST(req(devSession, { submissionId: "", cwids: ["a"] }))).status).toBe(400);
    expect((await POST(req(devSession, { submissionId: "s1", cwids: [] }))).status).toBe(400);
    expect((await POST(req(devSession, { submissionId: "s1", cwids: [7] }))).status).toBe(400);
  });

  it("404s a submission outside the caller's scope, 409s one with no stored result", async () => {
    mockSubFindUnique.mockResolvedValueOnce(null);
    expect((await POST(req(devSession, { submissionId: "s1", cwids: ["a"] }))).status).toBe(404);
    mockSubFindMany.mockResolvedValue([]);
    expect((await POST(req(devSession, { submissionId: "s1", cwids: ["a"] }))).status).toBe(409);
  });
});
