import { describe, expect, it, vi } from "vitest";

import { type AuditRow, appendAuditRow, computeRowHash } from "@/lib/edit/audit";

const BASE_ROW: AuditRow = {
  actorCwid: "abc1234",
  targetEntityType: "scholar",
  targetEntityId: "abc1234",
  action: "field_override",
  fieldsChanged: ["overview"],
  beforeValues: { overview: "old bio" },
  afterValues: { overview: "new bio" },
  ts: new Date("2026-05-17T14:03:01.234Z"),
  requestId: "req-001",
};

// ---------------------------------------------------------------------------
// computeRowHash  (docs/b03-audit-log.md § row_hash recipe)
// ---------------------------------------------------------------------------

describe("computeRowHash", () => {
  it("produces a 64-char lowercase hex digest", () => {
    expect(computeRowHash(BASE_ROW)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — the same row yields the same digest", () => {
    expect(computeRowHash(BASE_ROW)).toBe(computeRowHash({ ...BASE_ROW }));
  });

  it("changes when the action changes", () => {
    expect(computeRowHash({ ...BASE_ROW, action: "suppression_create" })).not.toBe(
      computeRowHash(BASE_ROW),
    );
  });

  it("changes when the before/after values change", () => {
    expect(computeRowHash({ ...BASE_ROW, beforeValues: { overview: "different" } })).not.toBe(
      computeRowHash(BASE_ROW),
    );
  });

  it("changes when the timestamp shifts by a single millisecond", () => {
    expect(
      computeRowHash({ ...BASE_ROW, ts: new Date("2026-05-17T14:03:01.235Z") }),
    ).not.toBe(computeRowHash(BASE_ROW));
  });

  it("distinguishes null from an empty value in the JSON columns", () => {
    expect(computeRowHash({ ...BASE_ROW, fieldsChanged: null })).not.toBe(
      computeRowHash({ ...BASE_ROW, fieldsChanged: [] }),
    );
  });
});

// ---------------------------------------------------------------------------
// appendAuditRow
// ---------------------------------------------------------------------------

type Tx = Parameters<typeof appendAuditRow>[0];

function fakeTx(rowsAffected: number) {
  return { $executeRaw: vi.fn().mockResolvedValue(rowsAffected) };
}

describe("appendAuditRow", () => {
  it("inserts exactly one parameterized row carrying the computed row_hash", async () => {
    const tx = fakeTx(1);
    await appendAuditRow(tx as unknown as Tx, BASE_ROW);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const args = tx.$executeRaw.mock.calls[0];
    // args[0] is the SQL template; args[1..] are the bound values, in order.
    expect(args[1]).toBe("abc1234"); // actor_cwid
    expect(args[2]).toBe("scholar"); // target_entity_type
    expect(args[4]).toBe("field_override"); // action
    expect(args[8]).toBe(computeRowHash(BASE_ROW)); // row_hash
  });

  it("stores the timestamp as a UTC datetime string the hash can be verified against", async () => {
    const tx = fakeTx(1);
    await appendAuditRow(tx as unknown as Tx, BASE_ROW);
    const args = tx.$executeRaw.mock.calls[0];
    expect(args[9]).toBe("2026-05-17 14:03:01.234"); // ts column
  });

  it("serializes JSON columns as strings, with null left as SQL NULL", async () => {
    const tx = fakeTx(1);
    await appendAuditRow(tx as unknown as Tx, {
      ...BASE_ROW,
      action: "suppression_create",
      fieldsChanged: null,
      beforeValues: null,
      afterValues: { suppressionId: "s1", reason: "retraction" },
    });
    const args = tx.$executeRaw.mock.calls[0];
    expect(args[5]).toBeNull(); // fields_changed
    expect(args[6]).toBeNull(); // before_values
    expect(args[7]).toBe(JSON.stringify({ suppressionId: "s1", reason: "retraction" }));
  });

  it("throws — failing the transaction — if the insert does not affect exactly one row", async () => {
    await expect(appendAuditRow(fakeTx(0) as unknown as Tx, BASE_ROW)).rejects.toThrow();
  });
});
