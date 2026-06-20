/**
 * Dormant-safe engine writeback (lib/cores/claim-writeback). The flag gate, the
 * skip path, the UpdateItem shape, and the best-effort error swallow.
 */
import { afterEach, describe, expect, it } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  isCoreClaimWritebackEnabled,
  writeBackCoreClaim,
  type CoreClaimDdbClient,
} from "@/lib/cores/claim-writeback";

const ORIGINAL = process.env.CORE_CLAIM_WRITEBACK;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CORE_CLAIM_WRITEBACK;
  else process.env.CORE_CLAIM_WRITEBACK = ORIGINAL;
});

describe("isCoreClaimWritebackEnabled", () => {
  it("is true only when the flag is exactly 'on'", () => {
    expect(isCoreClaimWritebackEnabled({ CORE_CLAIM_WRITEBACK: "on" })).toBe(true);
    expect(isCoreClaimWritebackEnabled({ CORE_CLAIM_WRITEBACK: "true" })).toBe(false);
    expect(isCoreClaimWritebackEnabled({})).toBe(false);
  });
});

describe("writeBackCoreClaim", () => {
  it("skips (no DynamoDB write) when the flag is off", async () => {
    delete process.env.CORE_CLAIM_WRITEBACK;
    let called = false;
    const ddb: CoreClaimDdbClient = {
      send: async () => {
        called = true;
        return {};
      },
    };
    const r = await writeBackCoreClaim(
      { pmid: "30418319", coreId: "2", status: "claimed" },
      { ddb },
    );
    expect(r).toEqual({ ok: false, skipped: true, reason: "disabled" });
    expect(called).toBe(false);
  });

  it("UpdateItems the PUB#/CORE# item with the human status when enabled", async () => {
    process.env.CORE_CLAIM_WRITEBACK = "on";
    const sent: UpdateCommand[] = [];
    const ddb: CoreClaimDdbClient = {
      send: async (cmd) => {
        sent.push(cmd);
        return {};
      },
    };
    const r = await writeBackCoreClaim(
      { pmid: "30418319", coreId: "2", status: "claimed" },
      { ddb },
    );
    expect(r).toEqual({ ok: true, skipped: false });
    expect(sent).toHaveLength(1);
    const input = sent[0].input;
    expect(input.Key).toEqual({ PK: "PUB#30418319", SK: "CORE#2" });
    expect(input.ExpressionAttributeValues?.[":st"]).toBe("claimed");
    expect(input.ExpressionAttributeValues?.[":pmid"]).toBe("30418319");
  });

  it("returns a non-skipped failure when the write throws (best-effort)", async () => {
    process.env.CORE_CLAIM_WRITEBACK = "on";
    const ddb: CoreClaimDdbClient = {
      send: async () => {
        throw new Error("no IAM grant");
      },
    };
    const r = await writeBackCoreClaim({ pmid: "1", coreId: "2", status: "rejected" }, { ddb });
    expect(r).toEqual({ ok: false, skipped: false });
  });
});
