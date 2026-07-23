/**
 * Tests for app/api/faculty-review/[cwid]/grants/route.ts — the WCM-internal
 * Faculty Review Tool's server-to-server grant read.
 *
 * Covers: the Bearer gate (missing / wrong / rotation-previous / fail-closed
 * when unconfigured), the field projection, ISO date formatting, the profile's
 * `isActive` definition, and the empty-cohort case.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { read: { grant: { findMany: mockFindMany } } },
}));

import { GET } from "@/app/api/faculty-review/[cwid]/grants/route";
import { NextRequest } from "next/server";

const TOKEN = "faculty-review-secret";

function makeRequest(opts: { token?: string; authorization?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.authorization !== undefined) headers.set("authorization", opts.authorization);
  else if (opts.token !== undefined) headers.set("authorization", `Bearer ${opts.token}`);
  return new NextRequest("http://localhost/api/faculty-review/abc1001/grants", { headers });
}

function call(req: NextRequest, cwid = "abc1001") {
  return GET(req, { params: Promise.resolve({ cwid }) });
}

/** A minimal Grant row as Prisma returns it (Dates for the date columns). */
function grantRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    externalId: "INFOED-123",
    source: "InfoEd",
    title: "Mechanisms of X",
    role: "PI",
    awardNumber: "R01 AG067497",
    funder: "NCI",
    primeSponsor: "NCI",
    directSponsor: "NCI",
    isSubaward: false,
    programType: "Grant",
    mechanism: "R01",
    nihIc: "NCI",
    applId: 9988776,
    startDate: new Date("2020-01-01T00:00:00Z"),
    endDate: new Date("2099-12-31T00:00:00Z"),
    ...over,
  };
}

describe("GET /api/faculty-review/[cwid]/grants", () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    process.env.FACULTY_REVIEW_TOKEN = TOKEN;
    delete process.env.FACULTY_REVIEW_TOKEN_PREVIOUS;
  });

  it("401 when Authorization header is missing", async () => {
    const resp = await call(makeRequest());
    expect(resp.status).toBe(401);
    expect((await resp.json()).error).toBe("unauthorized");
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("401 when the token is wrong", async () => {
    const resp = await call(makeRequest({ token: "nope" }));
    expect(resp.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("fails closed with 401 when no token is configured", async () => {
    delete process.env.FACULTY_REVIEW_TOKEN;
    const resp = await call(makeRequest({ token: TOKEN }));
    expect(resp.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("accepts the rotation-previous token", async () => {
    process.env.FACULTY_REVIEW_TOKEN = "new-token";
    process.env.FACULTY_REVIEW_TOKEN_PREVIOUS = TOKEN;
    mockFindMany.mockResolvedValue([]);
    const resp = await call(makeRequest({ token: TOKEN }));
    expect(resp.status).toBe(200);
  });

  it("returns the full projection with ISO dates and profile isActive", async () => {
    mockFindMany.mockResolvedValue([
      grantRow(),
      grantRow({ externalId: "R2", endDate: new Date("2000-06-30T00:00:00Z") }),
    ]);
    const resp = await call(makeRequest({ token: TOKEN }));
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.cwid).toBe("abc1001");
    expect(body.count).toBe(2);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { cwid: "abc1001" },
      // #1881 — explicit select of only the 15 mapped columns (no abstract/Json drag).
      select: {
        externalId: true,
        source: true,
        title: true,
        role: true,
        awardNumber: true,
        funder: true,
        primeSponsor: true,
        directSponsor: true,
        isSubaward: true,
        programType: true,
        mechanism: true,
        nihIc: true,
        applId: true,
        startDate: true,
        endDate: true,
      },
      orderBy: { endDate: "desc" },
    });

    const [active, past] = body.grants;
    expect(active).toEqual({
      externalId: "INFOED-123",
      source: "InfoEd",
      title: "Mechanisms of X",
      role: "PI",
      awardNumber: "R01 AG067497",
      funder: "NCI",
      primeSponsor: "NCI",
      directSponsor: "NCI",
      isSubaward: false,
      programType: "Grant",
      mechanism: "R01",
      nihIc: "NCI",
      applId: 9988776,
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      isActive: true,
    });
    // A grant that ended in 2000 is well past the 12-month NCE grace window.
    expect(past.isActive).toBe(false);
    expect(past.endDate).toBe("2000-06-30");
    // No search-enrichment / dollar fields leak into the contract.
    expect(active).not.toHaveProperty("keywords");
    expect(active).not.toHaveProperty("amount");
  });

  it("returns an empty list for a cwid with no grants", async () => {
    mockFindMany.mockResolvedValue([]);
    const resp = await call(makeRequest({ token: TOKEN }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ cwid: "abc1001", count: 0, grants: [] });
  });

  it("400 on an over-long cwid", async () => {
    const resp = await call(makeRequest({ token: TOKEN }), "x".repeat(33));
    expect(resp.status).toBe(400);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
