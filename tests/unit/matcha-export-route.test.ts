/**
 * `POST /api/edit/matcha/export`, the Matcha .xlsx download:
 *  - 404 unless `MATCHA` is on;
 *  - the Matcha write gate (superuser, developer or observer); anyone else gets 403, logged;
 *  - the body is checked at the trust boundary: a bad shape or too many rows is a 400;
 *  - the read cap is raised past the shared 64 KB for this route only;
 *  - a good body comes back as an attachment named `matcha-<title>-<date>.xlsx`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const { mockReadEditRequest, mockLogEditDenial, mockIsObserver } = vi.hoisted(() => ({
  mockReadEditRequest: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockIsObserver: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogEditDenial }));
vi.mock("@/lib/auth/observer", () => ({ isObserver: mockIsObserver }));

import { POST } from "@/app/api/edit/matcha/export/route";

const devSession = { cwid: "dev1", isSuperuser: false, isDeveloper: true };
function req(session: Record<string, unknown>, body: unknown) {
  mockReadEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, effective: session, realCwid: session.cwid, impersonatedCwid: null, body },
  });
  return {} as NextRequest;
}

const ROW = {
  rank: 1,
  cwid: "aaa1001",
  name: "Alice Alpha",
  title: null,
  department: "Medicine",
  fit: "Strong fit",
  matchedConcepts: ["fibrosis"],
  technologyCount: 0,
  careerStage: "",
  clinician: "",
  personType: "",
  researcherType: "Basic scientist",
  researchKind: "Laboratory research",
  profileUrl: "https://example.org/alice-alpha",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATCHA = "on";
  mockIsObserver.mockResolvedValue(false);
});

describe("POST /api/edit/matcha/export", () => {
  it("404s when Matcha is off", async () => {
    process.env.MATCHA = "off";
    const res = await POST(req(devSession, { rows: [ROW] }));
    expect(res.status).toBe(404);
  });

  it("refuses a user outside the Matcha gate, and logs it", async () => {
    const res = await POST(req({ cwid: "u1", isSuperuser: false, isDeveloper: false }, { rows: [ROW] }));
    expect(res.status).toBe(403);
    expect(mockLogEditDenial).toHaveBeenCalledOnce();
  });

  it("lets an observer export", async () => {
    mockIsObserver.mockResolvedValue(true);
    const res = await POST(req({ cwid: "obs1", isSuperuser: false, isDeveloper: false }, { rows: [ROW] }));
    expect(res.status).toBe(200);
  });

  it("raises the body cap for this route", async () => {
    await POST(req(devSession, { rows: [ROW] }));
    expect(mockReadEditRequest.mock.calls[0][1]).toEqual({ maxBytes: 4 * 1024 * 1024 });
  });

  it.each([
    ["no rows key", {}],
    ["rows not an array", { rows: "x" }],
    ["a row missing a field", { rows: [{ ...ROW, fit: undefined }] }],
    ["a wrong type", { rows: [{ ...ROW, rank: "1" }] }],
    ["an over-long cell", { rows: [{ ...ROW, name: "x".repeat(501) }] }],
    ["too many rows", { rows: Array.from({ length: 5001 }, () => ROW) }],
  ])("400s on %s", async (_label, body) => {
    const res = await POST(req(devSession, body));
    expect(res.status).toBe(400);
  });

  it("returns the workbook as a named attachment", async () => {
    const res = await POST(
      req(devSession, { rows: [ROW], title: "Acme Bio ask", shortlist: true, extra: "dropped" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="matcha-acme-bio-ask-shortlist-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    // An .xlsx is a zip: "PK".
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });
});
