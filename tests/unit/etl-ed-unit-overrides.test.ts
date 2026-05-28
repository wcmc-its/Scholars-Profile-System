/**
 * #540 Phase 4 — `etl/ed/unit-overrides.ts` helpers.
 *
 * Covers the three exports:
 *  - `loadUnitOverridesForETL` — two-query loader, deptType/divType split.
 *  - `resolveUnitSlugForETL`   — override wins over the derived slug.
 *  - `resolveUnitLeaderForETL` — the three-state model:
 *      - absent       → fall through to ETL detection
 *      - non-empty    → write that CWID
 *      - empty string → write null (explicit vacancy)
 *
 * Each case maps to a SPEC § Edge-case row or an ADR-005 Amendment 1
 * invariant so a failure names the risk.
 */
import { describe, it, expect, vi } from "vitest";

import {
  loadUnitOverridesForETL,
  resolveUnitLeaderForETL,
  resolveUnitSlugForETL,
} from "@/etl/ed/unit-overrides";

// ---------------------------------------------------------------------------
// loadUnitOverridesForETL
// ---------------------------------------------------------------------------

type Row = { entityId: string; fieldName: string; value: string };

function makeClient(deptRows: Row[], divRows: Row[]) {
  const findMany = vi.fn(async (args: { where: { entityType: string } }) => {
    if (args.where.entityType === "department") return deptRows;
    if (args.where.entityType === "division") return divRows;
    return [];
  });
  return {
    fieldOverride: {
      findMany,
    } as unknown as import("@/lib/generated/prisma/client").PrismaClient["fieldOverride"],
  };
}

describe("loadUnitOverridesForETL", () => {
  it("returns empty maps when nothing is curated (allocates nothing observable)", async () => {
    const client = makeClient([], []);
    const out = await loadUnitOverridesForETL(client);
    expect(out.deptSlugs.size).toBe(0);
    expect(out.divSlugs.size).toBe(0);
    expect(out.deptLeaders.size).toBe(0);
    expect(out.divLeaders.size).toBe(0);
  });

  it("buckets dept rows into slug / leaderCwid maps; preserves empty values", async () => {
    const client = makeClient(
      [
        { entityId: "MED", fieldName: "slug", value: "medicine-special" },
        { entityId: "MED", fieldName: "leaderCwid", value: "chr1234" },
        { entityId: "N1932", fieldName: "leaderCwid", value: "" }, // explicit vacancy
      ],
      [],
    );
    const out = await loadUnitOverridesForETL(client);
    expect(out.deptSlugs.get("MED")).toBe("medicine-special");
    expect(out.deptLeaders.get("MED")).toBe("chr1234");
    expect(out.deptLeaders.get("N1932")).toBe("");
    expect(out.deptLeaders.has("N1932")).toBe(true);
  });

  it("buckets div rows into the division maps (not the dept maps)", async () => {
    const client = makeClient(
      [],
      [
        { entityId: "CARDIO", fieldName: "slug", value: "cardiology" },
        { entityId: "CARDIO", fieldName: "leaderCwid", value: "ovr0001" },
      ],
    );
    const out = await loadUnitOverridesForETL(client);
    expect(out.deptSlugs.size).toBe(0);
    expect(out.deptLeaders.size).toBe(0);
    expect(out.divSlugs.get("CARDIO")).toBe("cardiology");
    expect(out.divLeaders.get("CARDIO")).toBe("ovr0001");
  });

  it("only queries slug + leaderCwid — `description` / `leaderInterim` are read-time merges", async () => {
    // SPEC § etl/ed precedence consult — the ETL touches `slug` and the
    // leader column only. `description` is never written by the ETL;
    // `leaderInterim` has no backing column (synthesized at read time).
    const client = makeClient([], []);
    await loadUnitOverridesForETL(client);
    const calls = (client.fieldOverride.findMany as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [arg] of calls) {
      const where = (arg as { where: { fieldName: { in: string[] } } }).where;
      expect(where.fieldName.in.sort()).toEqual(["leaderCwid", "slug"]);
    }
  });

  it("issues exactly two queries per run — one per entityType", async () => {
    const client = makeClient([], []);
    await loadUnitOverridesForETL(client);
    expect(client.fieldOverride.findMany).toHaveBeenCalledTimes(2);
  });

  it("drops an unexpected fieldName silently — forward-compatible read", async () => {
    const client = makeClient(
      [{ entityId: "MED", fieldName: "futureField", value: "x" }],
      [],
    );
    const out = await loadUnitOverridesForETL(client);
    expect(out.deptSlugs.size).toBe(0);
    expect(out.deptLeaders.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveUnitSlugForETL
// ---------------------------------------------------------------------------

describe("resolveUnitSlugForETL", () => {
  it("returns the derived slug unchanged when no override exists (edge 2 baseline)", () => {
    const out = resolveUnitSlugForETL("MED", "medicine", new Map());
    expect(out).toEqual({ slug: "medicine", fromOverride: false });
  });

  it("the override wins outright (edge 2)", () => {
    // SPEC § etl/ed precedence: a `slug` override is never re-derived; the
    // ETL writes it verbatim — curator intent is the final word.
    const out = resolveUnitSlugForETL(
      "MED",
      "medicine",
      new Map([["MED", "weill-medicine"]]),
    );
    expect(out).toEqual({ slug: "weill-medicine", fromOverride: true });
  });

  it('a curator\'s empty override is honored — "" overwrites the derived slug', () => {
    // The write path rejects an empty slug at validation, but if one ever
    // reaches here the resolver does not silently fall back to derivation
    // (that would mask a write-time failure). Pass it through; the upsert's
    // @unique guard catches it.
    const out = resolveUnitSlugForETL("MED", "medicine", new Map([["MED", ""]]));
    expect(out).toEqual({ slug: "", fromOverride: true });
  });

  it("the override map is consulted by `code`, not by the derived slug value", () => {
    const out = resolveUnitSlugForETL(
      "N1280",
      "medicine",
      new Map([["medicine", "x"]]), // wrong-key — must not match
    );
    expect(out).toEqual({ slug: "medicine", fromOverride: false });
  });
});

// ---------------------------------------------------------------------------
// resolveUnitLeaderForETL — the three-state model
// ---------------------------------------------------------------------------

describe("resolveUnitLeaderForETL", () => {
  it("no override row → applied=false; caller falls through to ETL detection (Paths A/B/C)", () => {
    const out = resolveUnitLeaderForETL("MED", new Map());
    expect(out).toEqual({ applied: false, reason: "no_override" });
  });

  it("non-empty override → applied=true with that CWID (edge 6)", () => {
    const out = resolveUnitLeaderForETL("MED", new Map([["MED", "ovr0001"]]));
    expect(out).toEqual({ applied: true, cwid: "ovr0001", reason: "override" });
  });

  it("empty-string override → applied=true with cwid=null (explicit vacancy, edge 6 — third state)", () => {
    // SPEC § 1 three-state model: an explicit "" must NOT re-engage
    // auto-detection — the curator's vacancy is the whole point of
    // setting "". `applied: true` tells the caller to skip the regex.
    const out = resolveUnitLeaderForETL("MED", new Map([["MED", ""]]));
    expect(out).toEqual({ applied: true, cwid: null, reason: "override" });
  });

  it("override applies to the queried code only (CARDIO override does not affect MED)", () => {
    const overrides = new Map([["CARDIO", "ovr0001"]]);
    expect(resolveUnitLeaderForETL("MED", overrides).applied).toBe(false);
    expect(resolveUnitLeaderForETL("CARDIO", overrides).applied).toBe(true);
  });
});
