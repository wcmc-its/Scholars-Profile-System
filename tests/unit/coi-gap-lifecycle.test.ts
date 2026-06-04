/**
 * Tests for lib/coi-gap/lifecycle.ts — the daily ETL's reconcile rules that make
 * COI-gap candidates incremental, disavow-able, and self-healing.
 */
import { describe, expect, it } from "vitest";
import { reconcileCandidates, type ExistingGap, type FreshGap } from "@/lib/coi-gap/lifecycle";

function fresh(pmid: string, entity: string, tier: "High" | "Medium" = "High"): FreshGap {
  return {
    pmid,
    normalizedEntity: entity,
    entity: entity,
    tier,
    attribution: "scholar",
    entityScore: 0.9,
    category: "personal",
    sourceSentence: `... ${entity} ...`,
  };
}
function existing(pmid: string, entity: string, status: ExistingGap["status"]): ExistingGap {
  return { pmid, normalizedEntity: entity, status };
}

describe("reconcileCandidates", () => {
  it("inserts a brand-new gap as status 'new'", () => {
    const r = reconcileCandidates([], [fresh("1", "pfizer")]);
    expect(r.upserts).toHaveLength(1);
    expect(r.upserts[0]).toMatchObject({ status: "new", isNew: true, pmid: "1" });
    expect(r.resolve).toHaveLength(0);
  });

  it("keeps a dismissed (disavowed) gap dismissed — never re-nags", () => {
    const r = reconcileCandidates([existing("1", "pfizer", "dismissed")], [fresh("1", "pfizer")]);
    expect(r.upserts).toHaveLength(1);
    expect(r.upserts[0]).toMatchObject({ status: "dismissed", isNew: false });
    expect(r.resolve).toHaveLength(0);
  });

  it("preserves an 'acknowledged' status across runs", () => {
    const r = reconcileCandidates([existing("1", "pfizer", "acknowledged")], [fresh("1", "pfizer")]);
    expect(r.upserts[0].status).toBe("acknowledged");
    expect(r.upserts[0].isNew).toBe(false);
  });

  it("resolves a gap that disappeared (scholar disclosed it)", () => {
    const r = reconcileCandidates([existing("1", "pfizer", "new")], []);
    expect(r.upserts).toHaveLength(0);
    expect(r.resolve).toEqual([{ pmid: "1", normalizedEntity: "pfizer" }]);
  });

  it("does NOT resolve a dismissed gap that disappeared (leaves it dismissed)", () => {
    const r = reconcileCandidates([existing("1", "pfizer", "dismissed")], []);
    expect(r.upserts).toHaveLength(0);
    expect(r.resolve).toHaveLength(0);
  });

  it("reopens a previously-resolved gap that reappears", () => {
    const r = reconcileCandidates([existing("1", "pfizer", "resolved")], [fresh("1", "pfizer")]);
    expect(r.upserts[0]).toMatchObject({ status: "new", isNew: false });
  });

  it("handles a mixed batch: add one, keep dismissed, resolve a stale, reopen", () => {
    const ex = [
      existing("1", "pfizer", "dismissed"), // still present → stays dismissed
      existing("2", "merck", "new"), // gone → resolved
      existing("3", "gilead", "resolved"), // reappears → reopened to new
    ];
    const fr = [fresh("1", "pfizer"), fresh("3", "gilead"), fresh("4", "novartis")];
    const r = reconcileCandidates(ex, fr);

    const byEntity = Object.fromEntries(r.upserts.map((u) => [u.normalizedEntity, u]));
    expect(byEntity["pfizer"].status).toBe("dismissed");
    expect(byEntity["gilead"].status).toBe("new");
    expect(byEntity["novartis"]).toMatchObject({ status: "new", isNew: true });
    expect(r.resolve).toEqual([{ pmid: "2", normalizedEntity: "merck" }]);
  });
});
