/**
 * Tests for scripts/exports/grants-bulk-export.ts's row-to-NDJSON-line
 * mapping (`toGrantExportRecord`). This is a thin export script — the S3
 * upload plumbing is not tested here; the interesting logic is the field
 * mapping + the `cwid` addition on top of the shared `toGrantRecord`.
 */
import { describe, expect, it } from "vitest";

import {
  toGrantExportRecord,
  type GrantRowForBulkExport,
} from "@/scripts/exports/grants-bulk-export";

const NOW = new Date("2026-08-11T00:00:00Z");

/** A minimal bulk-export Grant row, as Prisma returns it (Dates for date columns). */
function grantRow(over: Partial<GrantRowForBulkExport> = {}): GrantRowForBulkExport {
  return {
    cwid: "abc1001",
    externalId: "INFOED-123",
    source: "InfoEd",
    title: "Mechanisms of X",
    role: "PI",
    awardNumber: "R01 AG067497",
    funder: "NCI",
    primeSponsor: "NCI",
    directSponsor: "NCI",
    isSubaward: false,
    programType: "Grant",
    mechanism: "R01",
    nihIc: "NCI",
    applId: 9988776,
    startDate: new Date("2020-01-01T00:00:00Z"),
    endDate: new Date("2099-12-31T00:00:00Z"),
    ...over,
  };
}

describe("toGrantExportRecord", () => {
  it("carries cwid alongside the shared GrantRecord fields", () => {
    const record = toGrantExportRecord(grantRow(), NOW);
    expect(record).toEqual({
      cwid: "abc1001",
      externalId: "INFOED-123",
      source: "InfoEd",
      title: "Mechanisms of X",
      role: "PI",
      roleLabel: "Principal Investigator",
      isPrincipalInvestigator: true,
      awardNumber: "R01 AG067497",
      funder: "NCI",
      primeSponsor: "NCI",
      directSponsor: "NCI",
      isSubaward: false,
      programType: "Grant",
      mechanism: "R01",
      nihIc: "NCI",
      applId: 9988776,
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      isActive: true,
    });
  });

  it("derives roleLabel/isPrincipalInvestigator for a Co-PI (MPI) row", () => {
    const record = toGrantExportRecord(grantRow({ cwid: "xyz2002", role: "Co-PI" }), NOW);
    expect(record.cwid).toBe("xyz2002");
    expect(record.role).toBe("Co-PI");
    expect(record.roleLabel).toBe("Multiple Principal Investigator (MPI)");
    expect(record.isPrincipalInvestigator).toBe(true);
  });

  it("marks a grant past its 12-month NCE grace window as inactive", () => {
    const record = toGrantExportRecord(
      grantRow({ endDate: new Date("2000-06-30T00:00:00Z") }),
      NOW,
    );
    expect(record.endDate).toBe("2000-06-30");
    expect(record.isActive).toBe(false);
  });

  it("carries different cwids across rows for the same scholar's grants", () => {
    const a = toGrantExportRecord(grantRow({ cwid: "aaa1111", externalId: "A" }), NOW);
    const b = toGrantExportRecord(grantRow({ cwid: "bbb2222", externalId: "B" }), NOW);
    expect(a.cwid).toBe("aaa1111");
    expect(b.cwid).toBe("bbb2222");
  });
});
