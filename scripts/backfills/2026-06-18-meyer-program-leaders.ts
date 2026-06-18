/**
 * #1117 — seed the Meyer Cancer Center program leaders.
 *
 * #1105 added per-program pages; #1117 adds multi-leader support (a program may
 * be co-led) + the edit UI. This backfill loads the initial leader assignments
 * the comms office provided, into `CenterProgramLeader`. It writes NOTHING that
 * couldn't also be set through `/edit/center/meyer_cancer_center` → Programs.
 *
 * Assignments (center `meyer_cancer_center`):
 *   CB  Cancer Biology                 — Juan Cubillos-Ruiz (jur2016), Tim McGraw (temcgraw)
 *   CGE Cancer Genetics & Epigenetics  — Ekta Khurana (ekk2003)
 *   CPC Cancer Prevention and Control  — Rulla Tamimi (rmt4001), Shoshana Rosenberg (shr4009)
 *   CT  Cancer Therapeutics            — Nasser Altorki (nkaltork), Rohit Chandwani (roc9045)
 *
 * Safety (data-integrity rule — never write a guessed/typo'd cwid):
 *   - VERIFY-ALL-BEFORE-WRITE. Every program code must exist for the center, and
 *     every cwid must resolve to exactly one `scholar` row. If any check fails the
 *     run THROWS and writes NOTHING — fix the data, never load a non-resolving id.
 *   - Idempotent: each row is an upsert by composite PK, so a re-run is a no-op
 *     (it refreshes `interim`/`sort_order` to the canonical values below).
 *
 * Flags:
 *   --dry-run   verify + report what would change; write nothing.
 *
 * Run: npx tsx scripts/backfills/2026-06-18-meyer-program-leaders.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";

const CENTER_CODE = "meyer_cancer_center";

/** One leader assignment. `sortOrder` is the display order within the program. */
type Assignment = { programCode: string; cwid: string; sortOrder: number };

/**
 * The initial assignments. Resolved cwids: six from local data exports, two
 * (rmt4001 Tamimi, nkaltork Altorki) provided by comms. All are verified against
 * the live `scholar` table at run time — these literals are not trusted blindly.
 */
export const MEYER_PROGRAM_LEADERS: ReadonlyArray<Assignment> = [
  { programCode: "CB", cwid: "jur2016", sortOrder: 0 },
  { programCode: "CB", cwid: "temcgraw", sortOrder: 1 },
  { programCode: "CGE", cwid: "ekk2003", sortOrder: 0 },
  { programCode: "CPC", cwid: "rmt4001", sortOrder: 0 },
  { programCode: "CPC", cwid: "shr4009", sortOrder: 1 },
  { programCode: "CT", cwid: "nkaltork", sortOrder: 0 },
  { programCode: "CT", cwid: "roc9045", sortOrder: 1 },
];

/** The narrow Prisma slice this backfill touches — structural so the unit test
 *  can supply a mock without a live DB. */
export type ProgramLeaderBackfillDb = {
  centerProgram: {
    findUnique(args: {
      where: { centerCode_code: { centerCode: string; code: string } };
      select: { code: true };
    }): Promise<{ code: string } | null>;
  };
  scholar: {
    findUnique(args: {
      where: { cwid: string };
      select: { cwid: true; preferredName: true };
    }): Promise<{ cwid: string; preferredName: string } | null>;
  };
  centerProgramLeader: {
    upsert(args: {
      where: {
        centerCode_programCode_cwid: { centerCode: string; programCode: string; cwid: string };
      };
      create: {
        centerCode: string;
        programCode: string;
        cwid: string;
        interim: boolean;
        sortOrder: number;
      };
      update: { interim: boolean; sortOrder: number };
    }): Promise<unknown>;
  };
};

export type BackfillOpts = { dryRun: boolean };
export type BackfillResult = {
  verified: number;
  upserted: number;
  dryRun: boolean;
};

function log(msg: string): void {
  console.log(msg);
}

export function parseArgs(argv: ReadonlyArray<string>): BackfillOpts {
  return { dryRun: argv.includes("--dry-run") };
}

export async function runBackfill(
  db: ProgramLeaderBackfillDb,
  opts: BackfillOpts,
): Promise<BackfillResult> {
  // 1. Verify every program exists for the center.
  const programCodes = [...new Set(MEYER_PROGRAM_LEADERS.map((a) => a.programCode))];
  const missingPrograms: string[] = [];
  for (const code of programCodes) {
    const row = await db.centerProgram.findUnique({
      where: { centerCode_code: { centerCode: CENTER_CODE, code } },
      select: { code: true },
    });
    if (!row) missingPrograms.push(code);
  }

  // 2. Verify every cwid resolves to exactly one scholar (findUnique on the PK).
  const missingScholars: string[] = [];
  const resolvedNames = new Map<string, string>();
  for (const cwid of new Set(MEYER_PROGRAM_LEADERS.map((a) => a.cwid))) {
    const s = await db.scholar.findUnique({
      where: { cwid },
      select: { cwid: true, preferredName: true },
    });
    if (!s) missingScholars.push(cwid);
    else resolvedNames.set(cwid, s.preferredName);
  }

  if (missingPrograms.length > 0 || missingScholars.length > 0) {
    const parts: string[] = [];
    if (missingPrograms.length) parts.push(`programs not found for ${CENTER_CODE}: ${missingPrograms.join(", ")}`);
    if (missingScholars.length) parts.push(`cwids not found in scholar: ${missingScholars.join(", ")}`);
    // Fail loudly and write NOTHING — never load a guessed/typo'd id.
    throw new Error(`Aborting — ${parts.join("; ")}. No rows written.`);
  }

  log(`Verified ${programCodes.length} program(s) and ${resolvedNames.size} scholar(s):`);
  for (const a of MEYER_PROGRAM_LEADERS) {
    log(`  ${a.programCode.padEnd(4)} ${a.cwid.padEnd(12)} (${resolvedNames.get(a.cwid)}) sort=${a.sortOrder}`);
  }

  if (opts.dryRun) {
    log(`\n[DRY RUN] would upsert ${MEYER_PROGRAM_LEADERS.length} leader row(s). Nothing written.`);
    return { verified: MEYER_PROGRAM_LEADERS.length, upserted: 0, dryRun: true };
  }

  // 3. Upsert each row (idempotent by composite PK).
  let upserted = 0;
  for (const a of MEYER_PROGRAM_LEADERS) {
    await db.centerProgramLeader.upsert({
      where: {
        centerCode_programCode_cwid: {
          centerCode: CENTER_CODE,
          programCode: a.programCode,
          cwid: a.cwid,
        },
      },
      create: {
        centerCode: CENTER_CODE,
        programCode: a.programCode,
        cwid: a.cwid,
        interim: false,
        sortOrder: a.sortOrder,
      },
      update: { interim: false, sortOrder: a.sortOrder },
    });
    upserted += 1;
  }
  log(`\nUpserted ${upserted} leader row(s).`);
  return { verified: MEYER_PROGRAM_LEADERS.length, upserted, dryRun: false };
}

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  log(`#1117 Meyer program-leaders backfill${opts.dryRun ? " [DRY RUN — no writes]" : ""}`);

  // Lazily imported so the structural type stays the contract and the unit test
  // never loads the real client.
  const { db } = await import("../../lib/db");
  try {
    await runBackfill(db.write as unknown as ProgramLeaderBackfillDb, opts);
  } finally {
    await db.write.$disconnect();
  }
};

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
