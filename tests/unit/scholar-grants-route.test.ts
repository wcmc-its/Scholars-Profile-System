/**
 * Generalized evidence rows — GET /api/scholar/[cwid]/grants?q=… lazily returns a
 * scholar's TOP topic-matching grants for the Scholars-card Funding row. Default-safe:
 *   - flag off → { grants: [], total: 0 } (searchFunding never called)
 *   - no query → { grants: [], total: 0 } (no topic to match; never called)
 *   - flag on + query → maps FundingHit[] → EvidenceGrant[] (capped at 3) + total,
 *     filtered to investigator=[cwid]
 *   - searchFunding throws → empty 200 (a disclosure fetch must never 500)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/scholar/[cwid]/grants/route";
import { resolveSearchEvidenceRows } from "@/lib/api/search-flags";
import { searchFunding } from "@/lib/api/search-funding";

vi.mock("@/lib/api/search-flags", () => ({ resolveSearchEvidenceRows: vi.fn() }));
vi.mock("@/lib/api/search-funding", () => ({ searchFunding: vi.fn() }));

function call(cwid: string, q?: string) {
  const url =
    "http://localhost/api/scholar/" +
    cwid +
    "/grants" +
    (q != null ? "?q=" + encodeURIComponent(q) : "");
  // The route reads `request.nextUrl` (the method-exemplar convention), so a
  // NextRequest is required — a plain Request has no `nextUrl`.
  return GET(new NextRequest(url), { params: Promise.resolve({ cwid }) });
}

function hit(over: Record<string, unknown>) {
  return {
    projectId: "acct-1",
    title: "A grant",
    primeSponsor: "NIH / NIDDK",
    startDate: "2021-03-01",
    endDate: "2025-02-28",
    isActive: true,
    ...over,
  };
}

afterEach(() => {
  vi.mocked(resolveSearchEvidenceRows).mockReset();
  vi.mocked(searchFunding).mockReset();
});

describe("GET /api/scholar/[cwid]/grants", () => {
  it("returns empty and never calls searchFunding when the flag is off", async () => {
    vi.mocked(resolveSearchEvidenceRows).mockReturnValue(false);
    const body = await (await call("abc1234", "diabetes")).json();
    expect(body).toEqual({ grants: [], total: 0 });
    expect(searchFunding).not.toHaveBeenCalled();
  });

  it("returns empty and never calls searchFunding when there is no query", async () => {
    vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
    const body = await (await call("abc1234")).json();
    expect(body).toEqual({ grants: [], total: 0 });
    expect(searchFunding).not.toHaveBeenCalled();
  });

  it("maps the top matching grants (capped at 3) filtered to the cwid", async () => {
    vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
    vi.mocked(searchFunding).mockResolvedValue({
      hits: [
        hit({ projectId: "p1", title: "Beta-cell regeneration", startDate: "2020-01-01", endDate: "2024-12-31" }),
        hit({ projectId: "p2", title: "Islet biology", isActive: false }),
        hit({ projectId: "p3", title: "GLP-1 signaling" }),
        hit({ projectId: "p4", title: "Dropped — 4th over the cap" }),
      ],
      total: 9,
    } as never);

    const body = await (await call("abc1234", "diabetes")).json();
    expect(body.total).toBe(9);
    expect(body.grants).toHaveLength(3); // GRANT_CAP
    expect(body.grants[0]).toEqual({
      projectId: "p1",
      title: "Beta-cell regeneration",
      sponsor: "NIH / NIDDK",
      startYear: 2020,
      endYear: 2024,
      isActive: true,
    });
    // scoped to THIS scholar via the investigator filter
    expect(vi.mocked(searchFunding).mock.calls[0][0]).toMatchObject({
      q: "diabetes",
      filters: { investigator: ["abc1234"] },
    });
  });

  it("#1339: matches on the generic-stripped significant query, not raw q", async () => {
    vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
    vi.mocked(searchFunding).mockResolvedValue({ hits: [], total: 0 } as never);
    await call("abc1234", "children's health");
    // "health" is deprioritized → searchFunding sees only the significant token, so a
    // grant matching "health" alone can't admit (would otherwise surface off-topic).
    expect(vi.mocked(searchFunding).mock.calls[0][0]).toMatchObject({ q: "children's" });
  });

  it("null start/end dates degrade to null years (no NaN)", async () => {
    vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
    vi.mocked(searchFunding).mockResolvedValue({
      hits: [hit({ projectId: "p1", startDate: null, endDate: null, primeSponsor: null })],
      total: 1,
    } as never);
    const body = await (await call("abc1234", "diabetes")).json();
    expect(body.grants[0]).toMatchObject({ sponsor: null, startYear: null, endYear: null });
  });

  it("returns empty 200 (never 500s) when searchFunding throws", async () => {
    vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
    vi.mocked(searchFunding).mockRejectedValue(new Error("OpenSearch down"));
    const res = await call("abc1234", "diabetes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grants: [], total: 0 });
  });
});
