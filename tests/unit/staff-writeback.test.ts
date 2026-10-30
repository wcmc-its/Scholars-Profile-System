/**
 * Dormant-safe engine writeback for a core's curated staff list
 * (lib/cores/staff-writeback). Same `CORE_CLAIM_WRITEBACK` gate as the
 * clients writeback; the item is `CORE#{coreId}` / `STAFF` with `staff_cwids`,
 * the key ReciterAI's `get_curated_staff` reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { CoreClaimDdbClient } from "@/lib/cores/claim-writeback";
import { writeBackCoreStaff } from "@/lib/cores/staff-writeback";

const ORIGINAL = process.env.CORE_CLAIM_WRITEBACK;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CORE_CLAIM_WRITEBACK;
  else process.env.CORE_CLAIM_WRITEBACK = ORIGINAL;
});

function capture() {
  const sent: UpdateCommand[] = [];
  const ddb: CoreClaimDdbClient = {
    send: async (cmd) => {
      sent.push(cmd);
      return {};
    },
  };
  return { sent, ddb };
}

describe("writeBackCoreStaff", () => {
  it("skips (no DynamoDB write) when the flag is off", async () => {
    delete process.env.CORE_CLAIM_WRITEBACK;
    const { sent, ddb } = capture();
    const r = await writeBackCoreStaff({ coreId: "2", cwids: ["abc1234"] }, { ddb });
    expect(r).toEqual({ ok: false, skipped: true, reason: "disabled" });
    expect(sent).toHaveLength(0);
  });

  it("UpdateItems CORE#/STAFF with the sorted, lowercased, de-duped list", async () => {
    process.env.CORE_CLAIM_WRITEBACK = "on";
    const { sent, ddb } = capture();
    const r = await writeBackCoreStaff(
      { coreId: "2", cwids: ["XYZ5678", "abc1234", "abc1234"] },
      { ddb },
    );
    expect(r).toEqual({ ok: true, skipped: false });
    expect(sent).toHaveLength(1);
    const input = sent[0].input;
    // Bare "STAFF": not "CORE#..." (core-row scanners) and not "STAFF_DICT"
    // (the engine-written dictionary count the SPS ETL ingests).
    expect(input.Key).toEqual({ PK: "CORE#2", SK: "STAFF" });
    expect(input.UpdateExpression).toContain("staff_cwids = :cwids");
    expect(input.ExpressionAttributeValues?.[":core"]).toBe("2");
    expect(input.ExpressionAttributeValues?.[":cwids"]).toEqual(["abc1234", "xyz5678"]);
    expect(input.ExpressionAttributeValues?.[":n"]).toBe(2);
    expect(input.ExpressionAttributeValues?.[":src"]).toBe("sps");
  });

  it("writes an empty list (all staff removed) without throwing", async () => {
    process.env.CORE_CLAIM_WRITEBACK = "on";
    const { sent, ddb } = capture();
    const r = await writeBackCoreStaff({ coreId: "2", cwids: [] }, { ddb });
    expect(r).toEqual({ ok: true, skipped: false });
    expect(sent[0].input.ExpressionAttributeValues?.[":cwids"]).toEqual([]);
  });

  it("returns a non-skipped failure when the write throws (best-effort)", async () => {
    process.env.CORE_CLAIM_WRITEBACK = "on";
    const ddb: CoreClaimDdbClient = {
      send: async () => {
        throw new Error("no IAM grant");
      },
    };
    const r = await writeBackCoreStaff({ coreId: "2", cwids: ["abc1234"] }, { ddb });
    expect(r).toEqual({ ok: false, skipped: false });
  });
});
