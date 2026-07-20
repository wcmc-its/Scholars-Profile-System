/**
 * Bug: center member counts are computed live, never read off the row.
 *
 * `Center.scholarCount` is a denormalized column that nothing maintains: the ED
 * ETL's Phase 3 refresh iterates departments and divisions only, and the roster
 * write path never touches it. Every manually created center therefore reported
 * "0 scholars" on /edit/units and /browse forever while its public page showed
 * the real number.
 *
 * The regression these tests pin: a count that tracks the stored column instead
 * of the roster. The first case fails against the pre-fix code (stored 0, three
 * real members); the rest fix the gate so the live count can't drift from the
 * one the public center page applies (§ 3.3 date window, then non-deleted +
 * status='active' Scholar).
 */
import { describe, it, expect } from "vitest";

import { countActiveCenterMembersByCode } from "@/lib/api/centers";

type Row = {
  centerCode: string;
  cwid: string;
  startDate: Date | null;
  endDate: Date | null;
};

/** Minimal stand-in for the two queries the helper issues. */
function clientWith(rows: Row[], activeScholarCwids: string[]) {
  return {
    centerMembership: {
      findMany: async ({ where }: { where: { centerCode: { in: string[] } } }) =>
        rows.filter((r) => where.centerCode.in.includes(r.centerCode)),
    },
    scholar: {
      findMany: async ({ where }: { where: { cwid: { in: string[] } } }) =>
        where.cwid.in
          .filter((c) => activeScholarCwids.includes(c))
          .map((cwid) => ({ cwid })),
    },
  } as unknown as Parameters<typeof countActiveCenterMembersByCode>[0];
}

const open = (centerCode: string, cwid: string): Row => ({
  centerCode,
  cwid,
  startDate: null,
  endDate: null,
});

describe("countActiveCenterMembersByCode", () => {
  it("counts the roster, NOT the stale scholar_count column", async () => {
    // The incident shape: a freshly created center whose stored column is 0
    // while three real members sit in center_membership.
    const client = clientWith(
      [
        open("friedman_nutrition", "aaa1001"),
        open("friedman_nutrition", "bbb1002"),
        open("friedman_nutrition", "ccc1003"),
      ],
      ["aaa1001", "bbb1002", "ccc1003"],
    );
    const counts = await countActiveCenterMembersByCode(client, ["friedman_nutrition"]);
    expect(counts.get("friedman_nutrition")).toBe(3);
  });

  it("keeps each center's count separate in one batched call", async () => {
    const client = clientWith(
      [
        open("friedman_nutrition", "aaa1001"),
        open("appel_alzheimers", "bbb1002"),
        open("appel_alzheimers", "ccc1003"),
      ],
      ["aaa1001", "bbb1002", "ccc1003"],
    );
    const counts = await countActiveCenterMembersByCode(client, [
      "friedman_nutrition",
      "appel_alzheimers",
    ]);
    expect(counts.get("friedman_nutrition")).toBe(1);
    expect(counts.get("appel_alzheimers")).toBe(2);
  });

  it("excludes members with no active Scholar row (the public page's edge-10 gate)", async () => {
    // ddd1004 is on the roster but soft-deleted / dormant / has no scholar row —
    // the public center page drops them, so the count must too.
    const client = clientWith(
      [open("friedman_nutrition", "aaa1001"), open("friedman_nutrition", "ddd1004")],
      ["aaa1001"],
    );
    const counts = await countActiveCenterMembersByCode(client, ["friedman_nutrition"]);
    expect(counts.get("friedman_nutrition")).toBe(1);
  });

  it("excludes pending and expired memberships (§ 3.3 date window)", async () => {
    const client = clientWith(
      [
        open("friedman_nutrition", "aaa1001"),
        { centerCode: "friedman_nutrition", cwid: "bbb1002", startDate: new Date("2999-01-01"), endDate: null },
        { centerCode: "friedman_nutrition", cwid: "ccc1003", startDate: null, endDate: new Date("2020-01-01") },
      ],
      ["aaa1001", "bbb1002", "ccc1003"],
    );
    const counts = await countActiveCenterMembersByCode(client, ["friedman_nutrition"]);
    expect(counts.get("friedman_nutrition")).toBe(1);
  });

  it("omits a center with no surviving members (callers render 0)", async () => {
    const client = clientWith([open("weill_metabolic_health", "aaa1001")], []);
    const counts = await countActiveCenterMembersByCode(client, ["weill_metabolic_health"]);
    expect(counts.get("weill_metabolic_health") ?? 0).toBe(0);
  });

  it("short-circuits on an empty center list without querying", async () => {
    let queried = false;
    const client = {
      centerMembership: {
        findMany: async () => {
          queried = true;
          return [];
        },
      },
      scholar: { findMany: async () => [] },
    } as unknown as Parameters<typeof countActiveCenterMembersByCode>[0];
    const counts = await countActiveCenterMembersByCode(client, []);
    expect(counts.size).toBe(0);
    expect(queried).toBe(false);
  });
});
