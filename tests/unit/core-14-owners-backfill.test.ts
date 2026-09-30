/**
 * core-14 (Research Informatics) owners backfill: verify-all-before-write
 * safety.
 *
 *  - dry-run verifies but writes nothing;
 *  - a real run upserts every owner (idempotent by composite PK);
 *  - a real (non-dry-run) run without --granted-by ABORTS with no writes.
 *
 * No audit-row coverage here — this script deliberately does not write one
 * (the `etl` DB role has no grant on `scholars_audit.manual_edit_audit`; see
 * the header comment in the script itself).
 */
import { describe, expect, it, vi } from "vitest";

import {
  runBackfill,
  parseArgs,
  type CoreOwnerBackfillDb,
} from "@/scripts/backfills/2026-08-14-core-14-research-informatics-owners";

const OWNER_CWIDS = ["evs2008", "nik2004", "saa3011", "thc2015"];

function fakeDb() {
  const upsert = vi.fn().mockResolvedValue({});
  const db: CoreOwnerBackfillDb = { unitAdmin: { upsert } };
  return { db, upsert };
}

describe("core-14 owners backfill", () => {
  it("parseArgs reads --dry-run and --granted-by", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseArgs([]).dryRun).toBe(false);
    expect(parseArgs(["--granted-by=paa2013"]).grantedBy).toBe("paa2013");
    expect(parseArgs([]).grantedBy).toBeNull();
  });

  it("dry-run verifies but writes nothing", async () => {
    const { db, upsert } = fakeDb();
    const result = await runBackfill(db, { dryRun: true, grantedBy: null });
    expect(result).toEqual({ verified: OWNER_CWIDS.length, upserted: 0, dryRun: true });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("a real run upserts every owner with role=owner", async () => {
    const { db, upsert } = fakeDb();
    const result = await runBackfill(db, { dryRun: false, grantedBy: "paa2013" });
    expect(result.upserted).toBe(OWNER_CWIDS.length);
    expect(upsert).toHaveBeenCalledTimes(OWNER_CWIDS.length);
    for (const cwid of OWNER_CWIDS) {
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { entityType_entityId_cwid: { entityType: "core", entityId: "14", cwid } },
          create: expect.objectContaining({ entityType: "core", entityId: "14", cwid, role: "owner", grantedBy: "paa2013" }),
          update: expect.objectContaining({ role: "owner", grantedBy: "paa2013" }),
        }),
      );
    }
  });

  it("aborts with NO writes on a real run when --granted-by is omitted", async () => {
    const { db, upsert } = fakeDb();
    await expect(runBackfill(db, { dryRun: false, grantedBy: null })).rejects.toThrow(
      /--granted-by/,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("core 14 is 'Research Informatics' in CORE_CATALOG (guards a silent id/name drift)", async () => {
    const { CORE_CATALOG } = await import("@/etl/dynamodb/core-catalog");
    const core14 = CORE_CATALOG.find((c) => c.id === "14");
    expect(core14?.name).toBe("Research Informatics");
  });
});
