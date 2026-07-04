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
import { resolveFundingConceptGrants, resolveSearchEvidenceRows } from "@/lib/api/search-flags";
import { searchFunding } from "@/lib/api/search-funding";

vi.mock("@/lib/api/search-flags", () => ({
  resolveSearchEvidenceRows: vi.fn(),
  resolveFundingConceptGrants: vi.fn(),
}));
vi.mock("@/lib/api/search-funding", () => ({ searchFunding: vi.fn() }));

function call(cwid: string, q?: string, extra?: Record<string, string>) {
  const qs = new URLSearchParams();
  if (q != null) qs.set("q", q);
  for (const [k, v] of Object.entries(extra ?? {})) qs.set(k, v);
  const suffix = qs.toString();
  const url =
    "http://localhost/api/scholar/" + cwid + "/grants" + (suffix ? "?" + suffix : "");
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
  vi.mocked(resolveFundingConceptGrants).mockReset();
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

  it("#1359: carries the grant title highlight through to the EvidenceGrant", async () => {
    vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
    vi.mocked(searchFunding).mockResolvedValue({
      hits: [
        hit({ projectId: "p1", title: "Beta-cell regeneration in diabetes", titleHighlight: "Beta-cell regeneration in <mark>diabetes</mark>" }),
        hit({ projectId: "p2", title: "No title match", titleHighlight: null }),
      ],
      total: 2,
    } as never);
    const body = await (await call("abc1234", "diabetes")).json();
    expect(body.grants[0].titleHighlight).toBe("Beta-cell regeneration in <mark>diabetes</mark>");
    expect(body.grants[1].titleHighlight).toBeNull();
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

  describe("#1359 Tier 2 — concept threading", () => {
    it("threads the resolved concept into searchFunding when the flag is on", async () => {
      vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
      vi.mocked(resolveFundingConceptGrants).mockReturnValue(true);
      vi.mocked(searchFunding).mockResolvedValue({
        hits: [hit({ projectId: "p1", matchedConcept: true })],
        total: 5,
      } as never);
      const body = await (
        await call("abc1234", "heart attack", { descriptorUis: "D009203,D009202", label: "Myocardial Infarction" })
      ).json();
      const arg = vi.mocked(searchFunding).mock.calls[0][0] as { meshResolution?: { descendantUis: string[]; name: string } };
      expect(arg.meshResolution).toMatchObject({
        descendantUis: ["D009203", "D009202"],
        name: "Myocardial Infarction",
      });
      // a concept-admitted grant ⇒ the row reads "tagged"
      expect(body.strength).toBe("tagged");
    });

    it("strength is 'mention' when no surfaced grant matched via the concept axis", async () => {
      vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
      vi.mocked(resolveFundingConceptGrants).mockReturnValue(true);
      vi.mocked(searchFunding).mockResolvedValue({
        hits: [hit({ projectId: "p1", matchedConcept: false })],
        total: 2,
      } as never);
      const body = await (
        await call("abc1234", "heart attack", { descriptorUis: "D009203", label: "Myocardial Infarction" })
      ).json();
      expect(body.strength).toBe("mention");
    });

    it("stays text-only (no meshResolution) when the flag is off, even with descriptorUis", async () => {
      vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
      vi.mocked(resolveFundingConceptGrants).mockReturnValue(false);
      vi.mocked(searchFunding).mockResolvedValue({ hits: [hit({ matchedConcept: true })], total: 1 } as never);
      const body = await (
        await call("abc1234", "heart attack", { descriptorUis: "D009203", label: "Myocardial Infarction" })
      ).json();
      expect(vi.mocked(searchFunding).mock.calls[0][0]).not.toHaveProperty("meshResolution");
      expect(body.strength).toBe("mention");
    });

    it("stays text-only when the flag is on but no concept resolved (no descriptorUis)", async () => {
      vi.mocked(resolveSearchEvidenceRows).mockReturnValue(true);
      vi.mocked(resolveFundingConceptGrants).mockReturnValue(true);
      vi.mocked(searchFunding).mockResolvedValue({ hits: [hit({ matchedConcept: false })], total: 1 } as never);
      const body = await (await call("abc1234", "heart attack")).json();
      expect(vi.mocked(searchFunding).mock.calls[0][0]).not.toHaveProperty("meshResolution");
      expect(body.strength).toBe("mention");
    });
  });
});
