/**
 * #1117 — Meyer program-leaders backfill: verify-all-before-write safety.
 *
 *  - dry-run verifies but writes nothing;
 *  - a real run upserts every assignment (idempotent by composite PK);
 *  - a missing scholar cwid OR a missing program ABORTS with no writes
 *    (data-integrity rule — never load a guessed/typo'd id).
 */
import { describe, expect, it, vi } from "vitest";

import {
  runBackfill,
  parseArgs,
  MEYER_PROGRAM_LEADERS,
  type ProgramLeaderBackfillDb,
} from "@/scripts/backfills/2026-06-18-meyer-program-leaders";

const ALL_CWIDS = [...new Set(MEYER_PROGRAM_LEADERS.map((a) => a.cwid))];
const ALL_PROGRAMS = [...new Set(MEYER_PROGRAM_LEADERS.map((a) => a.programCode))];

function fakeDb(opts?: { missingCwid?: string; missingProgram?: string }) {
  const upsert = vi.fn().mockResolvedValue({});
  const db: ProgramLeaderBackfillDb = {
    centerProgram: {
      findUnique: vi.fn(async ({ where }) =>
        where.centerCode_code.code === opts?.missingProgram
          ? null
          : { code: where.centerCode_code.code },
      ),
    },
    scholar: {
      findUnique: vi.fn(async ({ where }) =>
        where.cwid === opts?.missingCwid
          ? null
          : { cwid: where.cwid, preferredName: where.cwid.toUpperCase() },
      ),
    },
    centerProgramLeader: { upsert },
  };
  return { db, upsert };
}

describe("Meyer program-leaders backfill (#1117)", () => {
  it("parseArgs reads --dry-run", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseArgs([]).dryRun).toBe(false);
  });

  it("has the expected co-led assignments (CB + CT + CPC are two-leader)", () => {
    const byProgram = (code: string) =>
      MEYER_PROGRAM_LEADERS.filter((a) => a.programCode === code).map((a) => a.cwid);
    expect(byProgram("CB")).toEqual(["jur2016", "temcgraw"]);
    expect(byProgram("CGE")).toEqual(["ekk2003"]);
    expect(byProgram("CPC")).toEqual(["rmt4001", "shr4009"]);
    expect(byProgram("CT")).toEqual(["nkaltork", "roc9045"]);
  });

  it("dry-run verifies everything but writes nothing", async () => {
    const { db, upsert } = fakeDb();
    const result = await runBackfill(db, { dryRun: true });
    expect(result).toEqual({ verified: MEYER_PROGRAM_LEADERS.length, upserted: 0, dryRun: true });
    expect(upsert).not.toHaveBeenCalled();
    // every distinct program + cwid was checked
    expect(db.centerProgram.findUnique).toHaveBeenCalledTimes(ALL_PROGRAMS.length);
    expect(db.scholar.findUnique).toHaveBeenCalledTimes(ALL_CWIDS.length);
  });

  it("a real run upserts every assignment", async () => {
    const { db, upsert } = fakeDb();
    const result = await runBackfill(db, { dryRun: false });
    expect(result.upserted).toBe(MEYER_PROGRAM_LEADERS.length);
    expect(upsert).toHaveBeenCalledTimes(MEYER_PROGRAM_LEADERS.length);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          centerCode_programCode_cwid: {
            centerCode: "meyer_cancer_center",
            programCode: "CB",
            cwid: "jur2016",
          },
        },
      }),
    );
  });

  it("aborts with NO writes when a cwid doesn't resolve to a scholar", async () => {
    const { db, upsert } = fakeDb({ missingCwid: "rmt4001" });
    await expect(runBackfill(db, { dryRun: false })).rejects.toThrow(/rmt4001/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("aborts with NO writes when a program is missing for the center", async () => {
    const { db, upsert } = fakeDb({ missingProgram: "CT" });
    await expect(runBackfill(db, { dryRun: false })).rejects.toThrow(/CT/);
    expect(upsert).not.toHaveBeenCalled();
  });
});
