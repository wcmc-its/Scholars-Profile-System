/**
 * Report 8's CWID list: the shared paste parser (`lib/cwid-list-text.ts`),
 * the store (`lib/edit/cwid-list.ts`: insert-only, a new id per list, the
 * shape re-checked before a write) and `POST
 * /api/edit/reports/article-count/cwid-list` (the real `readEditRequest`
 * preamble with the origin check stubbed; the report gate
 * `canViewArticleCountReport` and the store mocked at the module boundary).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockGetEffectiveEditSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockImpersonationActive: vi.fn(),
  canView: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.mockGetEffectiveEditSession,
  impersonationActive: h.mockImpersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.mockGetSession }));
vi.mock("@/lib/auth/session", () => ({ nowSeconds: () => 1_000 }));
vi.mock("@/lib/edit/authz", () => ({ verifyRequestOrigin: () => ({ ok: true }), logEditDenial: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: { reportCwidList: { create: h.create } } } }));
vi.mock("@/lib/edit/article-count-report", () => ({ canViewArticleCountReport: h.canView }));

import { POST } from "@/app/api/edit/reports/article-count/cwid-list/route";
import { CWID_LIST_MAX, parseCwidText } from "@/lib/cwid-list-text";
import { createCwidList } from "@/lib/edit/cwid-list";

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/edit/reports/article-count/cwid-list", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mockGetEffectiveEditSession.mockResolvedValue({ cwid: "usr0001", isSuperuser: false, isCommsSteward: false });
  h.mockGetSession.mockResolvedValue({ cwid: "usr0001", iat: 0, exp: 0 });
  h.mockImpersonationActive.mockReturnValue(false);
  h.canView.mockResolvedValue(true);
  h.create.mockResolvedValue({});
});

describe("parseCwidText", () => {
  it("any separator, lowercased, deduplicated in first-seen order; non-CWIDs reported, never kept", () => {
    expect(parseCwidText("ABC1234, def5678\n\tghi9012;abc1234 'jkl3456' 12 x")).toEqual({
      cwids: ["abc1234", "def5678", "ghi9012", "jkl3456"],
      invalid: ["12", "x"],
    });
    expect(parseCwidText("  \n ")).toEqual({ cwids: [], invalid: [] });
  });
});

describe("createCwidList", () => {
  it("inserts one row with a fresh URL-safe id and the deduplicated CWIDs", async () => {
    const id = await createCwidList(["abc1234", "def5678", "abc1234"], "usr0001");
    expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(h.create).toHaveBeenCalledWith({ data: { id, cwids: ["abc1234", "def5678"], createdBy: "usr0001" } });
  });

  it("refuses an empty, oversized or malformed list before any write", async () => {
    await expect(createCwidList([], "u")).rejects.toThrow();
    await expect(createCwidList(["BAD!"], "u")).rejects.toThrow();
    await expect(createCwidList(Array.from({ length: CWID_LIST_MAX + 1 }, (_, i) => `a${i}xx`), "u")).rejects.toThrow();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("retries once on an id collision, then gives up", async () => {
    h.create.mockRejectedValueOnce({ code: "P2002" }).mockResolvedValueOnce({});
    await expect(createCwidList(["abc1234"], "u")).resolves.toMatch(/^[A-Za-z0-9_-]{12}$/);
    h.create.mockRejectedValue({ code: "P2002" });
    await expect(createCwidList(["abc1234"], "u")).rejects.toEqual({ code: "P2002" });
  });
});

describe("POST /api/edit/reports/article-count/cwid-list", () => {
  it("stores the list and answers its id; created_by is the signed-in user", async () => {
    const res = await POST(post({ text: "abc1234 def5678" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, count: 2 });
    expect(h.create).toHaveBeenCalledWith({
      data: { id: body.id, cwids: ["abc1234", "def5678"], createdBy: "usr0001" },
    });
  });

  it("403 for someone who cannot open report 8, before anything is written", async () => {
    h.canView.mockResolvedValue(false);
    const res = await POST(post({ text: "abc1234" }));
    expect(res.status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("400s: no text, nothing CWID-shaped, a non-CWID entry (named back), over the cap", async () => {
    expect((await POST(post({}))).status).toBe(400);
    expect(await (await POST(post({ text: " , " }))).json()).toMatchObject({ error: "no_cwids" });
    const bad = await POST(post({ text: "abc1234 12" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "invalid_cwids", invalid: ["12"] });
    const many = Array.from({ length: CWID_LIST_MAX + 1 }, (_, i) => `a${i}x`).join(" ");
    expect(await (await POST(post({ text: many }))).json()).toMatchObject({ error: "too_many_cwids" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("401 with no session", async () => {
    h.mockGetEffectiveEditSession.mockResolvedValue(null);
    h.mockGetSession.mockResolvedValue(null);
    expect((await POST(post({ text: "abc1234" }))).status).toBe(401);
  });
});
