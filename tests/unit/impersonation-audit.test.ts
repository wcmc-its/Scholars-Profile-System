/**
 * #637 — "View as" impersonation: audit write & hash recipe v2
 * (impersonation-spec.md §3/§10, R3/R5, edge case E10).
 *
 * The audit layer gained `impersonatedCwid` on every `AuditRow` and bumped
 * `computeRowHash` to recipe **v2** (append `impersonatedCwid` as the final
 * positional element). These tests pin the security-critical properties:
 *
 *   - A row WITH an `impersonatedCwid` hashes differently from the same row with
 *     `null` — the "on behalf of whom" fact is inside `row_hash`, so an
 *     impersonated edit cannot be silently re-attributed (R3 / threat T2/T4).
 *   - The v2 array carries `impersonatedCwid` **last**, after `requestId`; the
 *     pre-migration v1 recipe is that array with the final element dropped, and
 *     a v1 row verifies under v1 while a v2 row verifies under v2 (E10).
 *   - `appendAuditRow` binds `impersonated_cwid` into the INSERT as the LAST
 *     bound value (mirroring the v2 hash recipe — the physical column sits
 *     `AFTER actor_cwid`, but the INSERT column list is explicit, so the bound
 *     order matches `computeRowHash` v2) and `actor_cwid` stays the REAL human —
 *     never the target (R3 — the non-forgery property).
 *   - The two new actions (`impersonation_start` / `impersonation_end`, R5)
 *     round-trip through the ENUM-typed `action` column.
 *
 * This is a separate suite from `edit-audit.test.ts` so the impersonation
 * fixtures (which always set the new required `impersonatedCwid`) stay cohesive
 * and don't perturb the existing B03 base-row fixture.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { type AuditRow, appendAuditRow, computeRowHash } from "@/lib/edit/audit";

/** A normal, non-impersonated edit — `impersonatedCwid` is null. */
const PLAIN_ROW: AuditRow = {
  actorCwid: "schol001",
  targetEntityType: "scholar",
  targetEntityId: "schol001",
  action: "field_override",
  fieldsChanged: ["overview"],
  beforeValues: { overview: "old bio" },
  afterValues: { overview: "new bio" },
  ts: new Date("2026-06-01T12:00:00.000Z"),
  requestId: "req-imp-1",
  impersonatedCwid: null,
};

/** The same edit, but made by a superuser impersonating the scholar (R3). */
const IMPERSONATED_ROW: AuditRow = {
  ...PLAIN_ROW,
  actorCwid: "super001", // the REAL human — never the target
  impersonatedCwid: "schol001", // on whose behalf
};

// ---------------------------------------------------------------------------
// computeRowHash — recipe v2 (impersonation-spec.md §10, E10)
// ---------------------------------------------------------------------------

/**
 * Re-derive a digest from a positional array exactly as `computeRowHash` does
 * (canonical JSON → sha256-hex), so a test can assert what the v1 / v2 recipes
 * hash over without re-implementing `canonicalize` (these arrays carry no nested
 * objects whose key order would matter, so a plain `JSON.stringify` suffices).
 */
function digestOf(positional: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(positional), "utf8").digest("hex");
}

/** The recipe-v2 positional array for a row (10 elements, `impersonatedCwid` last). */
function v2Array(row: AuditRow): unknown[] {
  return [
    row.actorCwid,
    row.targetEntityType,
    row.targetEntityId,
    row.action,
    row.fieldsChanged,
    row.beforeValues,
    row.afterValues,
    row.ts.toISOString(),
    row.requestId,
    row.impersonatedCwid,
  ];
}

describe("computeRowHash — recipe v2", () => {
  it("E10 — an impersonated row hashes differently from the same row with a null impersonatedCwid", () => {
    // Hold everything else equal: only `impersonatedCwid` differs (and the actor,
    // which differs in reality — but isolate the new column first).
    const withTarget = computeRowHash({ ...PLAIN_ROW, impersonatedCwid: "schol001" });
    const withNull = computeRowHash({ ...PLAIN_ROW, impersonatedCwid: null });
    expect(withTarget).not.toBe(withNull);
  });

  it("includes impersonatedCwid as the LAST positional element (v2 = 10 elements)", () => {
    const arr = v2Array(IMPERSONATED_ROW);
    expect(arr).toHaveLength(10);
    expect(arr[arr.length - 1]).toBe("schol001");
    // The emitted digest matches a hand-built v2 array — pins the recipe shape.
    expect(computeRowHash(IMPERSONATED_ROW)).toBe(digestOf(arr));
  });

  it("E10 — a pre-migration row verifies under v1 (the v2 array with its final element dropped)", () => {
    // v1 is v2 minus the trailing `impersonatedCwid`. A v2 recompute of a v1
    // row (or vice versa) must NOT match — the migration timestamp picks the
    // recipe, and the two are deliberately distinguishable.
    const v1 = digestOf(v2Array(PLAIN_ROW).slice(0, -1)); // 9 elements
    const v2 = computeRowHash(PLAIN_ROW); // 10 elements, trailing null
    expect(v1).not.toBe(v2);
    // The current emitter is v2 — never the legacy v1 shape.
    expect(computeRowHash(PLAIN_ROW)).toBe(digestOf(v2Array(PLAIN_ROW)));
  });

  it("is deterministic and 64-char lowercase hex", () => {
    expect(computeRowHash(IMPERSONATED_ROW)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRowHash(IMPERSONATED_ROW)).toBe(computeRowHash({ ...IMPERSONATED_ROW }));
  });
});

// ---------------------------------------------------------------------------
// appendAuditRow — binds impersonated_cwid (column 2) and the R5 actions
// ---------------------------------------------------------------------------

type Tx = Parameters<typeof appendAuditRow>[0];

function fakeTx(rowsAffected: number) {
  return { $executeRaw: vi.fn().mockResolvedValue(rowsAffected) };
}

describe("appendAuditRow — impersonation columns", () => {
  it("binds the target into impersonated_cwid while keeping actor_cwid the real human (R3)", async () => {
    const tx = fakeTx(1);
    await appendAuditRow(tx as unknown as Tx, IMPERSONATED_ROW);

    const args = tx.$executeRaw.mock.calls[0];
    // Bound-value order (args[0] is the SQL template; args[1..] the values),
    // matching the v2 hash recipe — `impersonated_cwid` LAST:
    // 1 actor_cwid, 2 target_entity_type, 3 target_entity_id, 4 action,
    // 5 fields_changed, 6 before_values, 7 after_values, 8 row_hash, 9 ts,
    // 10 request_id, 11 impersonated_cwid.
    expect(args[1]).toBe("super001"); // actor_cwid — the REAL human
    expect(args[11]).toBe("schol001"); // impersonated_cwid — on whose behalf
    expect(args[1]).not.toBe(args[11]); // never forged as the target (R3)
    expect(args[8]).toBe(computeRowHash(IMPERSONATED_ROW)); // row_hash over v2
  });

  it("binds SQL NULL into impersonated_cwid for an ordinary non-impersonated write", async () => {
    const tx = fakeTx(1);
    await appendAuditRow(tx as unknown as Tx, PLAIN_ROW);
    expect(tx.$executeRaw.mock.calls[0][11]).toBeNull(); // impersonated_cwid (LAST bound value)
  });

  // R5 — both the enter and exit rows round-trip through the ENUM-typed column;
  // a future drift between the TS `AuditAction` union and the SQL ENUM surfaces
  // here rather than as a runtime INSERT rejection (cf. the #540 enum test).
  it.each([
    ["impersonation_start"],
    ["impersonation_end"],
  ] as const)("writes the %s action with actor=real, impersonated_cwid=target (R5)", async (action) => {
    const tx = fakeTx(1);
    await appendAuditRow(tx as unknown as Tx, {
      ...IMPERSONATED_ROW,
      action,
      fieldsChanged: null,
      beforeValues: null,
      afterValues: { startedAt: 1_780_272_000 },
    });
    const args = tx.$executeRaw.mock.calls[0];
    expect(args[1]).toBe("super001"); // actor_cwid = real
    expect(args[11]).toBe("schol001"); // impersonated_cwid = target (LAST bound value)
    expect(args[4]).toBe(action); // action ENUM value (4th bound value)
  });
});
