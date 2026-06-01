import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// `readEditRequest` resolves identity through the #637 effective-identity seam:
// `getEffectiveEditSession()` for the (effective) EditSession + live superuser
// verdict, and the raw `getSession()` for the REAL cwid / overlay. Mock both —
// `impersonationActive` decides whether `impersonatedCwid` is set (false here:
// these fixtures carry no overlay).
const { mockGetEffectiveEditSession, mockGetSession, mockImpersonationActive } = vi.hoisted(
  () => ({
    mockGetEffectiveEditSession: vi.fn(),
    mockGetSession: vi.fn(),
    mockImpersonationActive: vi.fn(),
  }),
);
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEffectiveEditSession,
  impersonationActive: mockImpersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));

import { editError, editOk, readEditRequest } from "@/lib/edit/request";

function makeRequest(opts: { headers?: Record<string, string>; body?: string }): NextRequest {
  return new NextRequest("http://localhost/api/edit/field", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...opts.headers,
    },
    body: opts.body ?? JSON.stringify({ a: 1 }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: an ordinary signed-in, non-impersonating session. Effective and
  // real identities coincide; no overlay → `impersonationActive` is false.
  mockGetEffectiveEditSession.mockResolvedValue({ cwid: "usr01", isSuperuser: false });
  mockGetSession.mockResolvedValue({ cwid: "usr01", iat: 0, exp: 0 });
  mockImpersonationActive.mockReturnValue(false);
});

describe("editOk / editError", () => {
  it("editOk wraps the payload with ok:true", async () => {
    expect(await editOk({ fieldName: "overview", value: "x" }).json()).toEqual({
      ok: true,
      fieldName: "overview",
      value: "x",
    });
  });

  it("editError returns ok:false at the given status, with an optional field", async () => {
    const res = editError(400, "too_long", "value");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "too_long", field: "value" });
  });

  it("editError omits the field key when not given", async () => {
    expect(await editError(403, "not_self").json()).toEqual({ ok: false, error: "not_self" });
  });
});

describe("readEditRequest", () => {
  it("rejects a non-JSON content type with 415", async () => {
    const r = await readEditRequest(makeRequest({ headers: { "content-type": "text/plain" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(415);
  });

  it("rejects a cross-origin request with 403", async () => {
    const r = await readEditRequest(makeRequest({ headers: { "sec-fetch-site": "cross-site" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("returns 401 with an empty body when there is no session", async () => {
    mockGetEffectiveEditSession.mockResolvedValue(null);
    mockGetSession.mockResolvedValue(null);
    const r = await readEditRequest(makeRequest({}));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(await r.response.text()).toBe("");
    }
  });

  it("rejects malformed JSON with 400", async () => {
    const r = await readEditRequest(makeRequest({ body: "{not json" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it("rejects a non-object body (array, scalar) with 400", async () => {
    for (const body of ["[1,2]", "42", '"a string"']) {
      const r = await readEditRequest(makeRequest({ body }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(400);
    }
  });

  it("yields the session, parsed body, and a request id on success", async () => {
    const r = await readEditRequest(makeRequest({ body: JSON.stringify({ fieldName: "overview" }) }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ctx.session).toEqual({ cwid: "usr01", isSuperuser: false });
      expect(r.ctx.body).toEqual({ fieldName: "overview" });
      expect(r.ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
