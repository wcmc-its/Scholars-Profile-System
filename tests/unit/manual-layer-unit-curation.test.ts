/**
 * #540 Phase 3a — unit-curation read-merge helpers.
 *
 * Tests cover the four new exports in `lib/api/manual-layer.ts`:
 *  - `loadUnitFieldOverrides`
 *  - `mergeUnitFields`
 *  - `isUnitSuppressed`
 *  - their per-unit-kind centers-edit-in-row carve-out
 *
 * Each test maps to a SPEC § Edge-case test table row or to an ADR-005
 * Amendment 1 invariant so a failure names the risk.
 */
import { describe, expect, it, vi } from "vitest";

import {
  isUnitSuppressed,
  loadUnitFieldOverrides,
  mergeUnitFields,
  type UnitFieldOverrides,
} from "@/lib/api/manual-layer";

// ---------------------------------------------------------------------------
// loadUnitFieldOverrides
// ---------------------------------------------------------------------------

type FieldOverrideRow = { fieldName: string; value: string };

function fieldOverrideClient(rows: FieldOverrideRow[]) {
  return {
    fieldOverride: {
      findMany: vi.fn(async (_args: unknown) => rows),
      // unused by this helper; provided so the mock conforms to the
      // OverrideReadClient shape even when other callers expand it.
      findUnique: vi.fn(),
    } as unknown as import("@/lib/generated/prisma/client").PrismaClient["fieldOverride"],
  };
}

describe("loadUnitFieldOverrides", () => {
  it("returns an empty bag with no rows", async () => {
    const client = fieldOverrideClient([]);
    expect(await loadUnitFieldOverrides("department", "DEPT-X", client)).toEqual({});
  });

  it("maps each fieldName to its raw value", async () => {
    const client = fieldOverrideClient([
      { fieldName: "description", value: "A description." },
      { fieldName: "leaderCwid", value: "chr1234" },
      { fieldName: "leaderInterim", value: "true" },
    ]);
    expect(await loadUnitFieldOverrides("division", "N101", client)).toEqual({
      description: "A description.",
      leaderCwid: "chr1234",
      leaderInterim: "true",
    });
  });

  it("preserves empty values — `leaderCwid: \"\"` is 'explicitly cleared', not absent", async () => {
    const client = fieldOverrideClient([{ fieldName: "leaderCwid", value: "" }]);
    const result = await loadUnitFieldOverrides("department", "DEPT-X", client);
    expect(result).toEqual({ leaderCwid: "" });
    expect("leaderCwid" in result).toBe(true);
  });

  it("drops a row carrying an unknown fieldName — forward-compatible read", async () => {
    const client = fieldOverrideClient([
      { fieldName: "description", value: "OK" },
      { fieldName: "futureField", value: "junk" },
    ]);
    expect(await loadUnitFieldOverrides("division", "N101", client)).toEqual({
      description: "OK",
    });
  });

  it("short-circuits for a center — no DB query, empty bag returned", async () => {
    // Centers edit in-row; the write path rejects `field_override` writes for
    // a center entityType, so the loader must not issue a query.
    const client = fieldOverrideClient([{ fieldName: "description", value: "x" }]);
    expect(await loadUnitFieldOverrides("center", "MEYER", client)).toEqual({});
    expect(client.fieldOverride.findMany).not.toHaveBeenCalled();
  });

  it("queries exactly one round trip for dept/div — single-pass", async () => {
    const client = fieldOverrideClient([{ fieldName: "description", value: "x" }]);
    await loadUnitFieldOverrides("department", "DEPT-X", client);
    expect(client.fieldOverride.findMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// mergeUnitFields
// ---------------------------------------------------------------------------

describe("mergeUnitFields", () => {
  const ETL = { description: "ETL desc", leaderCwid: "etl0001" };

  it("returns the column when the override is undefined (edge 1 read fallback)", () => {
    expect(mergeUnitFields(ETL, {})).toEqual({
      description: "ETL desc",
      url: null,
      leaderCwid: "etl0001",
      leaderInterim: false,
    });
  });

  it("the override wins on each field independently (edge 1, 6)", () => {
    const overrides: UnitFieldOverrides = {
      description: "Curated desc",
      url: "https://ovr.example.org",
      leaderCwid: "ovr0001",
      leaderInterim: "true",
    };
    expect(mergeUnitFields(ETL, overrides)).toEqual({
      description: "Curated desc",
      url: "https://ovr.example.org",
      leaderCwid: "ovr0001",
      leaderInterim: true,
    });
  });

  it("url override wins over the column; falls back to the column otherwise (#1021)", () => {
    const row = { description: null, url: "https://col.example.org", leaderCwid: null };
    // No override → the column value shows through.
    expect(mergeUnitFields(row, {}).url).toBe("https://col.example.org");
    // Override → wins.
    expect(mergeUnitFields(row, { url: "https://ovr.example.org" }).url).toBe(
      "https://ovr.example.org",
    );
    // Empty-string override clears the link (distinct from the column value).
    expect(mergeUnitFields(row, { url: "" }).url).toBe("");
    // A row with no url column at all merges to null.
    expect(mergeUnitFields({ description: null, leaderCwid: null }, {}).url).toBeNull();
  });

  it("`leaderCwid: \"\"` overrides the column with 'explicitly cleared' — distinct from null", () => {
    // ADR-002 Path C semantics: an empty value is the curator's explicit "no
    // chair" assertion, suppressing auto-detection until cleared. The merge
    // surfaces it as `""` so the caller can distinguish from `null` (no row).
    expect(mergeUnitFields(ETL, { leaderCwid: "" }).leaderCwid).toBe("");
  });

  it("description override of \"\" clears the prose blurb", () => {
    expect(mergeUnitFields(ETL, { description: "" }).description).toBe("");
  });

  it("leaderInterim defaults to false when neither column nor override is set", () => {
    expect(mergeUnitFields({ description: null, leaderCwid: null }, {}).leaderInterim).toBe(false);
  });

  it("leaderInterim respects the in-row column for a center (no override needed)", () => {
    // Centers carry `leader_interim` as a real column; the merge picks it up
    // when no override exists.
    expect(
      mergeUnitFields({ description: null, leaderCwid: null, leaderInterim: true }, {}).leaderInterim,
    ).toBe(true);
  });

  it("leaderInterim override coerces 'true'/'false' to boolean", () => {
    expect(mergeUnitFields(ETL, { leaderInterim: "true" }).leaderInterim).toBe(true);
    expect(mergeUnitFields(ETL, { leaderInterim: "false" }).leaderInterim).toBe(false);
  });

  it("a malformed leaderInterim override falls back to the row — defensive", () => {
    // The write path validates, but the read is defensive: an unexpected
    // value must not flip the qualifier unpredictably.
    expect(
      mergeUnitFields(
        { description: null, leaderCwid: null, leaderInterim: true },
        { leaderInterim: "maybe" as string },
      ).leaderInterim,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isUnitSuppressed
// ---------------------------------------------------------------------------

function suppressionClient(rows: Array<{ id: string }>) {
  return {
    suppression: {
      findFirst: vi.fn(async (_args: unknown) => (rows.length > 0 ? rows[0] : null)),
      // unused; provided for shape conformance.
      findMany: vi.fn(),
    } as unknown as import("@/lib/generated/prisma/client").PrismaClient["suppression"],
  };
}

describe("isUnitSuppressed", () => {
  it("returns false when no active suppression covers the unit", async () => {
    const client = suppressionClient([]);
    expect(await isUnitSuppressed("department", "DEPT-X", client)).toBe(false);
  });

  it("returns true when at least one active suppression covers the unit", async () => {
    const client = suppressionClient([{ id: "sup-1" }]);
    expect(await isUnitSuppressed("center", "MEYER", client)).toBe(true);
  });

  it("issues exactly one query per call — page-scoped, never cached (ADR-005 immediacy)", async () => {
    const client = suppressionClient([{ id: "sup-1" }]);
    await isUnitSuppressed("division", "N101", client);
    expect(client.suppression.findFirst).toHaveBeenCalledTimes(1);
  });

  it("the suppression query filters out revoked rows", async () => {
    // The mock above does not enforce the where clause; we assert via the call
    // shape that the helper passes `revokedAt: null` so a revoked row is
    // ignored at query time (matches the publication-suppression pattern).
    const client = suppressionClient([]);
    await isUnitSuppressed("department", "DEPT-X", client);
    const call = (client.suppression.findFirst as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = call[0] as { where: { revokedAt: null } };
    expect(args.where.revokedAt).toBeNull();
  });

  it("the suppression query keys on entityType + entityId — no contributorCwid filter", async () => {
    // Whole-unit retire is `contributorCwid IS NULL`; the predicate matches a
    // row regardless of contributorCwid because the write path only ever
    // emits NULL for a unit target, but the read should not depend on it.
    const client = suppressionClient([]);
    await isUnitSuppressed("center", "MEYER", client);
    const call = (client.suppression.findFirst as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = call[0] as { where: { entityType: string; entityId: string } };
    expect(args.where.entityType).toBe("center");
    expect(args.where.entityId).toBe("MEYER");
  });
});
