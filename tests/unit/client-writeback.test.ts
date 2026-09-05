/**
 * Dormant-safe engine writeback for the core's known-clients list
 * (lib/cores/client-writeback). Reuses `claim-writeback.ts`'s
 * `CORE_CLAIM_WRITEBACK` flag gate — the skip path, the UpdateItem shape
 * (the `CORE#{coreId}` / `CLIENTS` key, NOT `CORE#{coreId}`), and the
 * best-effort error swallow.
 */
import { afterEach, describe, expect, it } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { CoreClaimDdbClient } from "@/lib/cores/claim-writeback";
import { writeBackCoreClients } from "@/lib/cores/client-writeback";

const ORIGINAL = process.env.CORE_CLAIM_WRITEBACK;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CORE_CLAIM_WRITEBACK;
  else process.env.CORE_CLAIM_WRITEBACK = ORIGINAL;
});

describe("writeBackCoreClients", () => {
  it("skips (no DynamoDB write) when the flag is off", async () => {
    delete process.env.CORE_CLAIM_WRITEBACK;
    let called = false;
    const ddb: CoreClaimDdbClient = {
      send: async () => {
        called = true;
        return {};
      },
    };
    const r = await writeBackCoreClients({ coreId: "2", cwids: ["djb2001"] }, { ddb });
    expect(r).toEqual({ ok: false, skipped: true, reason: "disabled" });
    expect(called).toBe(false);
  });

  it("UpdateItems the CORE#/CLIENTS item with the sorted, lowercased active list when enabled", async () => {
    process.env.CORE_CLAIM_WRITEBACK = "on";
    const sent: UpdateCommand[] = [];
    const ddb: CoreClaimDdbClient = {
      send: async (cmd) => {
        sent.push(cmd);
        return {};
      },
    };
    const r = await writeBackCoreClients(
      { coreId: "2", cwids: ["JX2001", "djb2001", "djb2001"] },
      { ddb },
    );
    expect(r).toEqual({ ok: true, skipped: false });
    expect(sent).toHaveLength(1);
    const input = sent[0].input;
    // The SK is the bare literal "CLIENTS" — it must NOT begin with "CORE#"
    // (both the SPS ETL and the engine select core rows by begins_with(SK,
    // "CORE#"), and this item must stay invisible to them).
    expect(input.Key).toEqual({ PK: "CORE#2", SK: "CLIENTS" });
    expect(input.ExpressionAttributeValues?.[":core"]).toBe("2");
    expect(input.ExpressionAttributeValues?.[":cwids"]).toEqual(["djb2001", "jx2001"]);
    expect(input.ExpressionAttributeValues?.[":n"]).toBe(2);
    expect(input.ExpressionAttributeValues?.[":src"]).toBe("sps");
  });

  it("writes an empty list (all clients removed) without throwing", async () => {
    process.env.CORE_CLAIM_WRITEBACK = "on";
    const sent: UpdateCommand[] = [];
    const ddb: CoreClaimDdbClient = {
      send: async (cmd) => {
        sent.push(cmd);
        return {};
      },
    };
    const r = await writeBackCoreClients({ coreId: "2", cwids: [] }, { ddb });
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
    const r = await writeBackCoreClients({ coreId: "2", cwids: ["djb2001"] }, { ddb });
    expect(r).toEqual({ ok: false, skipped: false });
  });
});
