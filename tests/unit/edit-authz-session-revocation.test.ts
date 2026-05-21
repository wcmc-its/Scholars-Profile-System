/**
 * AC-3 boundary test for B02 (#101): the same actor's superuser claim is
 * re-fetched on every POST. Drives the full route handler twice with the
 * superuser verdict flipped between calls and asserts the second POST
 * returns 403 with the structured `edit_authz_denied` log line.
 *
 * Picks the slug field on `/api/edit/field` because slug is the
 * superuser-only field; a slug write on someone else's record therefore
 * hinges entirely on the live superuser verdict.
 *
 * The flip is applied at `getEditSession()` rather than at `isSuperuser()`.
 * `getEditSession` is the single per-request entry point both the field
 * route and `readEditRequest()` consume; mocking it captures the AC-3
 * invariant directly ("verdict re-resolved per call, not cached") and
 * sidesteps an ESM live-binding issue where a partial mock of the inner
 * `isSuperuser` symbol does not intercept the same-module reference from
 * `getEditSession`. Unit coverage for `isSuperuser` itself lives in
 * `auth-superuser.test.ts`; this file's job is the boundary behaviour at
 * the route handler.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockFieldOverrideFindUnique,
  mockFieldOverrideUpsert,
  mockExecuteRaw,
  mockScholarFindFirst,
  mockFieldOverrideFindFirst,
  mockSlugHistoryFindFirst,
  mockReflectOverviewEdit,
  mockResolveProfiles,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockFieldOverrideFindUnique: vi.fn(),
  mockFieldOverrideUpsert: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockFieldOverrideFindFirst: vi.fn(),
  mockSlugHistoryFindFirst: vi.fn(),
  mockReflectOverviewEdit: vi.fn(),
  mockResolveProfiles: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findFirst: mockScholarFindFirst },
      fieldOverride: { findFirst: mockFieldOverrideFindFirst },
      slugHistory: { findFirst: mockSlugHistoryFindFirst },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectOverviewEdit: mockReflectOverviewEdit,
  resolveAffectedProfiles: mockResolveProfiles,
}));

import { POST } from "@/app/api/edit/field/route";

const ACTOR_CWID = "adm001";
const TARGET_CWID = "sch5";

const fakeTx = {
  fieldOverride: {
    findUnique: mockFieldOverrideFindUnique,
    upsert: mockFieldOverrideUpsert,
  },
  $executeRaw: mockExecuteRaw,
};

function post(): NextRequest {
  return new NextRequest("http://localhost/api/edit/field", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      entityType: "scholar",
      entityId: TARGET_CWID,
      fieldName: "slug",
      value: "new-slug",
    }),
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockFieldOverrideFindUnique.mockResolvedValue(null);
  mockFieldOverrideUpsert.mockResolvedValue({});
  mockExecuteRaw.mockResolvedValue(1);
  // Slug is unused / free; the superuser POST is otherwise valid.
  mockScholarFindFirst.mockResolvedValue(null);
  mockFieldOverrideFindFirst.mockResolvedValue(null);
  mockSlugHistoryFindFirst.mockResolvedValue(null);
  mockResolveProfiles.mockResolvedValue([{ slug: `${TARGET_CWID}-slug`, cwid: TARGET_CWID }]);
});

describe("POST /api/edit/field -- live superuser re-fetch (B02 AC-3)", () => {
  it("flips 200 -> 403 across two POSTs from the same actor when the superuser claim revokes between calls", async () => {
    // Same identity, two POSTs, the verdict is the only thing that
    // changes between calls.
    mockGetEditSession
      .mockResolvedValueOnce({ cwid: ACTOR_CWID, isSuperuser: true })
      .mockResolvedValueOnce({ cwid: ACTOR_CWID, isSuperuser: false });

    // POST 1: actor is still in the superuser group; slug write allowed.
    const res1 = await POST(post());
    expect(res1.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    // POST 2: group claim revoked between calls; same slug write denied.
    const res2 = await POST(post());
    expect(res2.status).toBe(403);

    // The route did not start a second write transaction.
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    // The 403 emitted exactly one structured edit_authz_denied log line
    // with the documented field shape.
    const deniedLines = warnSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (line): line is string => typeof line === "string" && line.includes('"edit_authz_denied"'),
      );
    expect(deniedLines).toHaveLength(1);
    const denial = JSON.parse(deniedLines[0]!);
    expect(denial).toEqual({
      event: "edit_authz_denied",
      actor_cwid: ACTOR_CWID,
      target_cwid: TARGET_CWID,
      path: "/api/edit/field",
      reason: "not_superuser",
    });

    // The session was re-resolved once per POST -- not cached. This is
    // the AC-3 invariant.
    expect(mockGetEditSession).toHaveBeenCalledTimes(2);
  });
});
