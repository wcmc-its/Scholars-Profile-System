/**
 * PUT /api/edit/report-meta/[n] — gating + validation + the sanitize-then-
 * upsert. Mirrors `report-access-route.test.ts`: the real `readEditRequest`
 * preamble runs (origin check stubbed ok), the session seams are mocked, and
 * `@/lib/db` is mocked with a `reportMeta.upsert` spy so this suite asserts
 * what reaches the write. The REAL sanitizer runs — the one load-bearing
 * fact here is that what is STORED is `sanitizeOverview`'s output (no
 * `<script>`, no `<h1>`, list markup intact, structurally empty → NULL), and
 * that `updatedBy` is the real human (`realCwid`), never the "View as" target.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockGetEffectiveEditSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockImpersonationActive: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockUpsert: vi.fn(),
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
vi.mock("@/lib/db", () => ({
  db: { read: {}, write: { reportMeta: { upsert: h.mockUpsert } } },
}));

import { PUT } from "@/app/api/edit/report-meta/[n]/route";

const ADMIN = "adm0001";
const PLAIN = "usr0001";

function put(n: string, body: unknown): Promise<Response> {
  const request = new NextRequest(`http://localhost/api/edit/report-meta/${n}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
  return PUT(request, { params: Promise.resolve({ n }) });
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

const VALID = {
  slug: "publications",
  name: "Publications",
  summary: "This unit's publications.",
  descriptionHtml: "<p>About.</p>",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  asGenuine(ADMIN, { isSuperuser: true });
  // Echo the write back the way Prisma would (the `select`ed columns).
  h.mockUpsert.mockImplementation(async (args: { create: Record<string, unknown> }) => ({
    reportKey: args.create.reportKey,
    slug: args.create.slug,
    name: args.create.name,
    summary: args.create.summary,
    descriptionHtml: args.create.descriptionHtml,
  }));
});

describe("PUT /api/edit/report-meta/[n] — gating", () => {
  it("401 with no session", async () => {
    h.mockGetEffectiveEditSession.mockResolvedValue(null);
    const res = await put("3", VALID);
    expect(res.status).toBe(401);
    expect(h.mockUpsert).not.toHaveBeenCalled();
  });

  it("403 not_superuser for a plain user, before the params or body are read, and no db call", async () => {
    asGenuine(PLAIN);
    const res = await put("10", { name: 42 });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_superuser" });
    expect(h.mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        actorCwid: PLAIN,
        reason: "not_superuser",
        path: "/api/edit/report-meta/[n]",
      }),
    );
    expect(h.mockUpsert).not.toHaveBeenCalled();
  });

  it("403 for a comms_steward too — this surface is superuser-only", async () => {
    asGenuine("stw0001", { isCommsSteward: true });
    const res = await put("3", VALID);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_superuser" });
    expect(h.mockUpsert).not.toHaveBeenCalled();
  });

  it("404 unknown_report for a superuser on a key outside 1..9", async () => {
    const res = await put("10", VALID);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "unknown_report" });
    expect(h.mockUpsert).not.toHaveBeenCalled();
  });
});

describe("PUT /api/edit/report-meta/[n] — validation", () => {
  it.each([
    [{ ...VALID, slug: "" }, "invalid_slug", "slug"],
    [{ ...VALID, slug: "Publications" }, "invalid_slug", "slug"],
    [{ ...VALID, slug: "a--b" }, "invalid_slug", "slug"],
    [{ ...VALID, slug: "-a" }, "invalid_slug", "slug"],
    [{ ...VALID, slug: "7" }, "invalid_slug", "slug"],
    [{ ...VALID, slug: "x".repeat(65) }, "invalid_slug", "slug"],
    [{ ...VALID, slug: 3 }, "invalid_slug", "slug"],
    [{ ...VALID, name: "" }, "invalid_name", "name"],
    [{ ...VALID, name: "   " }, "invalid_name", "name"],
    [{ ...VALID, name: "x".repeat(121) }, "invalid_name", "name"],
    [{ ...VALID, name: 42 }, "invalid_name", "name"],
    [{ ...VALID, summary: "" }, "invalid_summary", "summary"],
    [{ ...VALID, summary: "x".repeat(501) }, "invalid_summary", "summary"],
    [{ ...VALID, descriptionHtml: null }, "invalid_description", "descriptionHtml"],
    [{ ...VALID, descriptionHtml: 7 }, "invalid_description", "descriptionHtml"],
    [
      { slug: VALID.slug, name: VALID.name, summary: VALID.summary },
      "invalid_description",
      "descriptionHtml",
    ],
  ])("400 for %j → %s", async (body, error, field) => {
    const res = await put("3", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error, field });
    expect(h.mockUpsert).not.toHaveBeenCalled();
  });

  it("400 description_too_long past the overview cap", async () => {
    const res = await put("3", { ...VALID, descriptionHtml: `<p>${"a".repeat(20_001)}</p>` });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "description_too_long" });
    expect(h.mockUpsert).not.toHaveBeenCalled();
  });

  it("name/summary at exactly the caps pass, trimmed", async () => {
    const res = await put("3", {
      ...VALID,
      name: ` ${"n".repeat(120)} `,
      summary: "s".repeat(500),
    });
    expect(res.status).toBe(200);
    expect(h.mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ name: "n".repeat(120), summary: "s".repeat(500) }),
      }),
    );
  });
});

describe("PUT /api/edit/report-meta/[n] — the write", () => {
  it("stores the SANITIZED description: script dropped, h1 unwrapped to text, list markup intact", async () => {
    const res = await put("7", {
      ...VALID,
      descriptionHtml: "<p>x</p><script>alert(1)</script><h1>t</h1><ul><li>ok</li></ul>",
    });
    expect(res.status).toBe(200);
    expect(h.mockUpsert).toHaveBeenCalledTimes(1);
    const args = h.mockUpsert.mock.calls[0][0] as {
      where: unknown;
      create: { descriptionHtml: string };
      update: { descriptionHtml: string };
    };
    expect(args.where).toEqual({ reportKey: "7" });
    const stored = args.create.descriptionHtml;
    expect(stored).toBe(args.update.descriptionHtml);
    expect(stored).not.toContain("<script");
    expect(stored).not.toContain("alert(1)");
    expect(stored).not.toContain("<h1");
    expect(stored).toContain("t");
    expect(stored).toContain("<ul><li>ok</li></ul>");
    expect(stored).toContain("<p>x</p>");
    expect(await res.json()).toEqual({
      ok: true,
      meta: {
        key: "7",
        slug: VALID.slug,
        name: VALID.name,
        summary: VALID.summary,
        descriptionHtml: stored,
      },
    });
  });

  it('descriptionHtml "" → NULL stored; a structurally-empty body too', async () => {
    await put("3", { ...VALID, descriptionHtml: "" });
    expect(h.mockUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ descriptionHtml: null }),
        update: expect.objectContaining({ descriptionHtml: null }),
      }),
    );
    await put("3", { ...VALID, descriptionHtml: "<p></p> <p><br></p>" });
    expect(h.mockUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ descriptionHtml: null }) }),
    );
  });

  it("updatedBy is the REAL cwid, not the impersonation target", async () => {
    // Real human ADMIN is impersonating a (superuser) target.
    h.mockGetEffectiveEditSession.mockResolvedValue({
      cwid: "tgt0001",
      isSuperuser: true,
      isCommsSteward: false,
    });
    h.mockGetSession.mockResolvedValue({
      cwid: ADMIN,
      iat: 0,
      exp: 0,
      impersonating: { targetCwid: "tgt0001" },
    });
    h.mockImpersonationActive.mockReturnValue(true);
    const res = await put("3", VALID);
    expect(res.status).toBe(200);
    const args = h.mockUpsert.mock.calls[0][0] as {
      create: { updatedBy: string };
      update: { updatedBy: string };
    };
    expect(args.create.updatedBy).toBe(ADMIN);
    expect(args.update.updatedBy).toBe(ADMIN);
  });

  it("a trimmed slug is stored on both create and update; a taken slug (P2002) → 409 slug_taken, not 500", async () => {
    await put("3", { ...VALID, slug: " nih-pubs-2 " });
    expect(h.mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ slug: "nih-pubs-2" }),
        update: expect.objectContaining({ slug: "nih-pubs-2" }),
      }),
    );
    h.mockUpsert.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await put("3", VALID);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "slug_taken", field: "slug" });
  });

  it("answers with the row the write returned, keyed on the report", async () => {
    h.mockUpsert.mockResolvedValue({
      reportKey: "3",
      slug: "papers",
      name: "Stored name",
      summary: "Stored summary",
      descriptionHtml: "<p>Stored.</p>",
    });
    const res = await put("3", VALID);
    expect(await res.json()).toEqual({
      ok: true,
      meta: {
        key: "3",
        slug: "papers",
        name: "Stored name",
        summary: "Stored summary",
        descriptionHtml: "<p>Stored.</p>",
      },
    });
  });

  it("500 write_failed when the upsert throws", async () => {
    h.mockUpsert.mockRejectedValue(new Error("boom"));
    const res = await put("3", VALID);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "write_failed" });
  });
});

describe("PUT /api/edit/report-meta/[n] — the request record", () => {
  type UpsertArgs = { create: Record<string, unknown>; update: Record<string, unknown> };
  const lastArgs = () => h.mockUpsert.mock.calls.at(-1)![0] as UpsertArgs;

  it("absent fields are left out of the write, so a stored record survives a save without them", async () => {
    const res = await put("3", VALID);
    expect(res.status).toBe(200);
    for (const k of ["requestedBy", "requestedOn", "requestMemo"]) {
      expect(lastArgs().update[k]).toBeUndefined();
      expect(lastArgs().create[k]).toBeUndefined();
    }
  });

  it("stores trimmed text, the date as UTC midnight, and clears a blank field to NULL", async () => {
    const res = await put("3", { ...VALID, requestedBy: "  Radiology office ", requestedOn: "2026-09-01", requestMemo: "" });
    expect(res.status).toBe(200);
    expect(lastArgs().update).toMatchObject({ requestedBy: "Radiology office", requestMemo: null });
    expect((lastArgs().update.requestedOn as Date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(lastArgs().create).toMatchObject({ requestedBy: "Radiology office", requestMemo: null });
  });

  it("null clears; an empty date clears", async () => {
    await put("3", { ...VALID, requestedBy: null, requestedOn: "" });
    expect(lastArgs().update).toMatchObject({ requestedBy: null, requestedOn: null });
  });

  it.each([
    ["requestedBy", "x".repeat(201), "invalid_requested_by"],
    ["requestedBy", 7, "invalid_requested_by"],
    ["requestedOn", "09/01/2026", "invalid_requested_on"],
    ["requestedOn", "2026-02-30", "invalid_requested_on"],
    ["requestMemo", "x".repeat(5001), "invalid_request_memo"],
  ])("400 when %s is %j", async (field, value, code) => {
    const res = await put("3", { ...VALID, [field]: value });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: code });
    expect(h.mockUpsert).not.toHaveBeenCalled();
  });

  it("at the caps: 200-character requester and 5,000-character memo pass", async () => {
    const res = await put("3", { ...VALID, requestedBy: "x".repeat(200), requestMemo: "y".repeat(5000) });
    expect(res.status).toBe(200);
  });
});
