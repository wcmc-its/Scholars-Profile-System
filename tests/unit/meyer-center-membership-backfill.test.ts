/**
 * #552 Phase 5 — Meyer Cancer Center membership type+program backfill.
 *
 * Drives the exported, dependency-injected parser + apply function with fake
 * Prisma delegates (no live DB, no real file). Covers:
 *   1. Arg parsing (--dry-run / --limit / --file) + bad --limit rejection.
 *   2. Line parsing: type+program, the raw "Meyer Cancer Center: CT" export
 *      field, the compact "type:program" form, comma-separated, a startDate,
 *      cwid-only, comments/blanks, and skip reasons (bad cwid, unknown program,
 *      bad date, conflicts).
 *   3. Whole-file parse: duplicate cwid → last wins (idempotent).
 *   4. applyBackfill: matched (on roster → update) vs unmatched (off roster →
 *      create), cwid-only-off-roster skipped, --dry-run writes nothing,
 *      --limit caps writes, idempotent re-run produces the same upsert args.
 */
import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  parseLine,
  parseSource,
  normalizeType,
  normalizeProgram,
  applyBackfill,
  MEYER_CENTER_CODE,
  type MeyerBackfillDb,
  type MeyerBackfillOptions,
  type ParsedMember,
  type SkippedLine,
} from "@/scripts/backfills/2026-06-10-meyer-center-membership-extended";

const RUN: MeyerBackfillOptions = { dryRun: false, limit: null, file: "x" };
const DRY: MeyerBackfillOptions = { dryRun: true, limit: null, file: "x" };

/** The captured upsert args this test inspects. */
type CapturedUpsert = {
  where: { centerCode_cwid: { centerCode: string; cwid: string } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

/** A centerMembership fake whose findUnique reports membership from a roster set. */
function makeDb(rosterCwids: string[] = []): { db: MeyerBackfillDb; upsertArgs: CapturedUpsert[] } {
  const upsertArgs: CapturedUpsert[] = [];
  const roster = new Set(rosterCwids);
  const db: MeyerBackfillDb = {
    centerMembership: {
      findUnique: vi.fn(async (args) => {
        const cwid = args.where.centerCode_cwid.cwid;
        return roster.has(cwid) ? { cwid } : null;
      }),
      upsert: vi.fn(async (args) => {
        upsertArgs.push(args as CapturedUpsert);
        return {};
      }),
    },
  };
  return { db, upsertArgs };
}

function asMember(v: ParsedMember | SkippedLine | null): ParsedMember {
  if (v === null || "reason" in v) throw new Error(`expected a member, got ${JSON.stringify(v)}`);
  return v;
}
function asSkip(v: ParsedMember | SkippedLine | null): SkippedLine {
  if (v === null || !("reason" in v)) throw new Error(`expected a skip, got ${JSON.stringify(v)}`);
  return v;
}

describe("parseArgs", () => {
  it("defaults to a real run, no limit, the default file", () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      limit: null,
      file: "data/center-members/meyer-cancer-center.txt",
    });
  });
  it("reads --dry-run, --limit=N, --file=path", () => {
    expect(parseArgs(["--dry-run", "--limit=5", "--file=/tmp/m.txt"])).toEqual({
      dryRun: true,
      limit: 5,
      file: "/tmp/m.txt",
    });
  });
  it("rejects a non-positive --limit", () => {
    expect(() => parseArgs(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--limit=abc"])).toThrow(/positive integer/);
  });
});

describe("normalizeType / normalizeProgram", () => {
  it("type tokens are case-insensitive", () => {
    expect(normalizeType("RESEARCH")).toBe("research");
    expect(normalizeType("Clinical")).toBe("clinical");
    expect(normalizeType("staff")).toBeNull();
  });
  it("program codes are validated against the Meyer set, uppercased", () => {
    expect(normalizeProgram("ct")).toBe("CT");
    expect(normalizeProgram("ZY")).toBe("ZY");
    expect(normalizeProgram("XX")).toBeNull();
  });
});

describe("parseLine", () => {
  it("parses type + program (whitespace)", () => {
    expect(asMember(parseLine("abc1001 RESEARCH CT", 1))).toEqual({
      cwid: "abc1001",
      membershipType: "research",
      programCode: "CT",
      startDate: null,
    });
  });

  it("parses the raw export 'Meyer Cancer Center: CT' program field", () => {
    expect(asMember(parseLine("def2002 CLINICAL Meyer Cancer Center: ZY", 1))).toEqual({
      cwid: "def2002",
      membershipType: "clinical",
      programCode: "ZY",
      startDate: null,
    });
  });

  it("parses the compact type:program token", () => {
    expect(asMember(parseLine("ghi3003 research:CB", 1))).toEqual({
      cwid: "ghi3003",
      membershipType: "research",
      programCode: "CB",
      startDate: null,
    });
  });

  it("parses comma-separated fields with a startDate", () => {
    expect(asMember(parseLine("jkl4004, CLINICAL, CPC, 2024-07-01", 1))).toEqual({
      cwid: "jkl4004",
      membershipType: "clinical",
      programCode: "CPC",
      startDate: "2024-07-01",
    });
  });

  it("position-independent: program before type still parses", () => {
    expect(asMember(parseLine("mno5005 CGE RESEARCH", 1))).toEqual({
      cwid: "mno5005",
      membershipType: "research",
      programCode: "CGE",
      startDate: null,
    });
  });

  it("cwid-only line → member with null classification", () => {
    expect(asMember(parseLine("pqr6006", 1))).toEqual({
      cwid: "pqr6006",
      membershipType: null,
      programCode: null,
      startDate: null,
    });
  });

  it("blank, whitespace, and comment-only lines are ignored (null)", () => {
    expect(parseLine("", 1)).toBeNull();
    expect(parseLine("   ", 2)).toBeNull();
    expect(parseLine("# a comment", 3)).toBeNull();
  });

  it("trailing comment is stripped", () => {
    expect(asMember(parseLine("abc1001 RESEARCH CT # joined 2024", 1)).programCode).toBe("CT");
  });

  it("skips a non-CWID first token", () => {
    expect(asSkip(parseLine("not-a-cwid RESEARCH CT", 7)).reason).toMatch(/not a CWID/);
  });

  it("skips an unknown program code (never guesses)", () => {
    const s = asSkip(parseLine("abc1001 RESEARCH XX", 9));
    expect(s.reason).toMatch(/unrecognized token/i);
    expect(s.lineNumber).toBe(9);
  });

  it("skips an invalid date", () => {
    expect(asSkip(parseLine("abc1001 RESEARCH CT 2024-13-99", 1)).reason).toMatch(
      /unrecognized|invalid date/i,
    );
  });

  it("skips conflicting programs / types", () => {
    expect(asSkip(parseLine("abc1001 CT CB", 1)).reason).toMatch(/conflicting programs/);
    expect(asSkip(parseLine("abc1001 RESEARCH CLINICAL", 1)).reason).toMatch(/conflicting types/);
  });
});

describe("parseSource", () => {
  it("collects members + skips; duplicate cwid → last wins (idempotent)", () => {
    const text = [
      "# Meyer export",
      "abc1001 RESEARCH CT",
      "",
      "def2002 CLINICAL ZY",
      "bad-line RESEARCH CT",
      "abc1001 RESEARCH CB", // duplicate — supersedes the earlier CT
    ].join("\n");
    const { members, skipped } = parseSource(text);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/not a CWID/);
    const byCwid = Object.fromEntries(members.map((m) => [m.cwid, m]));
    expect(members).toHaveLength(2);
    expect(byCwid.abc1001.programCode).toBe("CB"); // last wins
    expect(byCwid.def2002.programCode).toBe("ZY");
  });
});

describe("applyBackfill", () => {
  const M = (over: Partial<ParsedMember> & { cwid: string }): ParsedMember => ({
    membershipType: "research",
    programCode: "CT",
    startDate: null,
    ...over,
  });

  it("matched (on roster) → upsert update; counts matched", async () => {
    const { db, upsertArgs } = makeDb(["abc1001"]);
    const res = await applyBackfill(db, [M({ cwid: "abc1001" })], RUN);
    expect(res).toEqual({ matched: 1, unmatched: 0, written: 1 });
    expect(upsertArgs[0].where).toEqual({
      centerCode_cwid: { centerCode: MEYER_CENTER_CODE, cwid: "abc1001" },
    });
    expect(upsertArgs[0].update).toMatchObject({ membershipType: "research", programCode: "CT" });
  });

  it("unmatched (off roster, has classification) → upsert create source='manual'", async () => {
    const { db, upsertArgs } = makeDb([]); // empty roster
    const res = await applyBackfill(db, [M({ cwid: "zzz9999", programCode: "ZY" })], RUN);
    expect(res).toEqual({ matched: 0, unmatched: 1, written: 1 });
    expect(upsertArgs[0].create).toMatchObject({
      centerCode: MEYER_CENTER_CODE,
      cwid: "zzz9999",
      source: "manual",
      programCode: "ZY",
    });
  });

  it("cwid-only AND off roster → skipped, no write (never creates a bare row)", async () => {
    const { db, upsertArgs } = makeDb([]);
    const res = await applyBackfill(
      db,
      [M({ cwid: "new0001", membershipType: null, programCode: null, startDate: null })],
      RUN,
    );
    expect(res).toEqual({ matched: 0, unmatched: 1, written: 0 });
    expect(upsertArgs).toHaveLength(0);
  });

  it("--dry-run writes nothing but still reports matched/unmatched", async () => {
    const { db, upsertArgs } = makeDb(["abc1001"]);
    const res = await applyBackfill(db, [M({ cwid: "abc1001" }), M({ cwid: "zzz9999" })], DRY);
    expect(res).toEqual({ matched: 1, unmatched: 1, written: 2 });
    expect(upsertArgs).toHaveLength(0);
    expect(db.centerMembership.upsert).not.toHaveBeenCalled();
  });

  it("--limit caps the number of rows written", async () => {
    const { db, upsertArgs } = makeDb(["a", "b", "c"]); // roster set membership doesn't gate writes here
    const members = [M({ cwid: "aaa1001" }), M({ cwid: "bbb1002" }), M({ cwid: "ccc1003" })];
    const res = await applyBackfill(db, members, { dryRun: false, limit: 2, file: "x" });
    expect(res.written).toBe(2);
    expect(upsertArgs).toHaveLength(2);
  });

  it("idempotent: a second run issues the same upsert args (fixed file-derived state)", async () => {
    const members = [M({ cwid: "abc1001", programCode: "CB", startDate: "2024-07-01" })];
    const a = makeDb(["abc1001"]);
    const b = makeDb(["abc1001"]);
    await applyBackfill(a.db, members, RUN);
    await applyBackfill(b.db, members, RUN);
    expect(a.upsertArgs).toEqual(b.upsertArgs);
    // the date is materialized as a Date for the column
    expect((a.upsertArgs[0].update.startDate as Date).toISOString()).toBe(
      "2024-07-01T00:00:00.000Z",
    );
  });
});
