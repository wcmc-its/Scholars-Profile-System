/**
 * NCI Table 2A cycle import (`scripts/backfills/2026-08-08-cancer-center-nci-2a-import.ts`).
 * Drives the exported, dependency-injected functions with fake Prisma delegates and a
 * mocked Bedrock inference call — no live DB, no real Bedrock. Covers:
 *   1. Arg parsing: --file required, --dry-run, --limit/--concurrency validation,
 *      --members-only.
 *   2. normalizeAwardNumber: whitespace collapse + case fold.
 *   3. buildAwardNumberIndex: unique match resolves; 2+ distinct cwids -> "ambiguous",
 *      never guessed.
 *   4. buildMembershipIndex / buildMembershipExistenceSet: the same membership rows
 *      read two ways — program-if-any vs. membership-existence.
 *   5. filterMembersOnly: keeps a row whose resolved cwid is a member; skips a resolved
 *      non-member, an unmatched award number, and an ambiguous one.
 *   6. scopeAndLimitRows: the ordering guarantee `main()` relies on but never exercises
 *      itself — --members-only scoping runs BEFORE --limit slicing, proven with a
 *      non-member row placed first in raw file order.
 *   7. planRow: program assignment ALWAYS comes from the membership index, never a
 *      model guess — a membership match resolves { programCode, source: "membership" },
 *      no match resolves { programCode: null, source: "membership" } (never "llm"), and
 *      `inferCancerFundingJudgments` is called with no `programs` field at all (it no
 *      longer accepts one). The percent/rationale inference is independent of program
 *      resolution — it still runs either way, and a failed Bedrock call (inference
 *      returns null) leaves percent/rationale null while the allocation resolves from
 *      the membership index regardless.
 *   8. applyPlan (the non-clobber contract): new row creates; existing row updates
 *      both percent and allocations; a HUMAN-sourced percent is skipped on update; a
 *      HUMAN-sourced allocation blocks the WHOLE allocation replace (never partial);
 *      --dry-run writes nothing.
 *   9. isPeerReviewed (DT2A rule #4, deterministic): planRow computes it from the row's
 *      own nihAward/specificFundingSource alone, independent of membership/Bedrock; it's
 *      a plain scalar in applyPlan, so it ALWAYS overwrites on update -- unlike
 *      cancerRelevantPercent there is no human override to clobber.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInfer } = vi.hoisted(() => ({ mockInfer: vi.fn() }));
vi.mock("@/lib/edit/cancer-center-funding-generator", () => ({
  inferCancerFundingJudgments: mockInfer,
}));

import {
  parseArgs,
  normalizeAwardNumber,
  buildAwardNumberIndex,
  buildMembershipIndex,
  buildMembershipExistenceSet,
  filterMembersOnly,
  scopeAndLimitRows,
  loadImportRows,
  planRow,
  applyPlan,
  CENTER_CODE,
  type ImportOptions,
  type ImportRow,
  type Nci2aImportDb,
  type ApplyCounts,
} from "@/scripts/backfills/2026-08-08-cancer-center-nci-2a-import";

const ROW: ImportRow = {
  reportingCycle: "osra-2026-07-14",
  institutionNumber: 12345,
  sourceAwardNumber: "5 R01 CA059736-01",
  pi: "Test, PI",
  specificFundingSource: "National Cancer Institute",
  projectNumber: "5 R01 CA059736-01",
  projectTitle: "A cancer project",
  projectStartDate: "2024-01-01",
  projectEndDate: "2028-12-31",
  annualProjectDirectCosts: 200000,
  nihActivityCode: "R01",
  nihAward: true,
};

const RUN: ImportOptions = { dryRun: false, limit: null, concurrency: 5, file: "x", membersOnly: false };
const DRY: ImportOptions = { ...RUN, dryRun: true };

function emptyCounts(): ApplyCounts {
  return {
    created: 0,
    updated: 0,
    membershipResolved: 0,
    unresolvedProgram: 0,
    percentSkippedHuman: 0,
    percentSkippedInferenceFailed: 0,
    allocationsSkippedHuman: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseArgs", () => {
  it("requires --file", () => {
    expect(() => parseArgs([])).toThrow(/--file/);
  });
  it("parses --dry-run, --limit, --concurrency", () => {
    const opts = parseArgs(["--file=x.json", "--dry-run", "--limit=10", "--concurrency=3"]);
    expect(opts).toEqual({ dryRun: true, limit: 10, concurrency: 3, file: "x.json", membersOnly: false });
  });
  it("defaults concurrency to 5, membersOnly to false, and rejects a non-positive limit", () => {
    expect(parseArgs(["--file=x.json"]).concurrency).toBe(5);
    expect(parseArgs(["--file=x.json"]).membersOnly).toBe(false);
    expect(() => parseArgs(["--file=x.json", "--limit=0"])).toThrow(/--limit/);
    expect(() => parseArgs(["--file=x.json", "--concurrency=-1"])).toThrow(/--concurrency/);
  });
  it("parses --members-only", () => {
    expect(parseArgs(["--file=x.json", "--members-only"]).membersOnly).toBe(true);
  });
});

describe("loadImportRows", () => {
  function writeJsonFile(rows: unknown[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), "nci2a-import-test-"));
    const file = path.join(dir, "rows.json");
    writeFileSync(file, JSON.stringify(rows));
    return file;
  }

  it("loads rows whose nihAward is a real boolean", () => {
    const file = writeJsonFile([ROW]);
    expect(loadImportRows(file)).toEqual([ROW]);
  });

  it("throws (rather than silently defaulting) when a row has no boolean nihAward -- a stale pre-nihAward JSON", () => {
    // Regression: an unchecked `as ImportRow[]` cast would let this through as
    // `nihAward: undefined`, which reads falsy and silently misclassifies a
    // real NIH award as non-peer-reviewed instead of failing loudly.
    const rowWithoutNihAward: Partial<ImportRow> = { ...ROW };
    delete rowWithoutNihAward.nihAward;
    const file = writeJsonFile([ROW, rowWithoutNihAward]);
    expect(() => loadImportRows(file)).toThrow(/row 1 has no boolean "nihAward"/);
  });
});

describe("normalizeAwardNumber", () => {
  it("collapses whitespace and upcases", () => {
    expect(normalizeAwardNumber("  5  r01   ca059736-01 ")).toBe("5 R01 CA059736-01");
  });
});

describe("buildAwardNumberIndex", () => {
  it("resolves a number with exactly one distinct cwid", () => {
    const idx = buildAwardNumberIndex([{ awardNumber: "5 R01 CA059736-01", cwid: "abc1234" }]);
    expect(idx.get("5 R01 CA059736-01")).toBe("abc1234");
  });
  it("marks a number shared by two distinct cwids ambiguous — never guesses", () => {
    const idx = buildAwardNumberIndex([
      { awardNumber: "5 R01 CA059736-01", cwid: "abc1234" },
      { awardNumber: "5 r01 ca059736-01", cwid: "xyz9999" }, // same after normalization
    ]);
    expect(idx.get("5 R01 CA059736-01")).toBe("ambiguous");
  });
  it("skips null award numbers", () => {
    const idx = buildAwardNumberIndex([{ awardNumber: null, cwid: "abc1234" }]);
    expect(idx.size).toBe(0);
  });
});

describe("buildMembershipIndex", () => {
  it("includes only memberships with a non-null programCode", () => {
    const idx = buildMembershipIndex([
      { cwid: "abc1234", programCode: "CB" },
      { cwid: "xyz9999", programCode: null },
    ]);
    expect(idx.get("abc1234")).toBe("CB");
    expect(idx.has("xyz9999")).toBe(false);
  });
});

describe("buildMembershipExistenceSet", () => {
  it("includes a cwid regardless of programCode nullity", () => {
    const set = buildMembershipExistenceSet([{ cwid: "abc1234" }, { cwid: "xyz9999" }]);
    expect(set.has("abc1234")).toBe(true);
    expect(set.has("xyz9999")).toBe(true);
  });
});

describe("filterMembersOnly", () => {
  const memberSet = new Set(["abc1234"]);

  it("keeps a row whose resolved cwid is a member", () => {
    const awardIndex = new Map([["5 R01 CA059736-01", "abc1234"]]);
    const { kept, skipped } = filterMembersOnly([ROW], awardIndex, memberSet);
    expect(kept).toEqual([ROW]);
    expect(skipped).toBe(0);
  });

  it("skips a row whose resolved cwid resolves but isn't a member", () => {
    const awardIndex = new Map([["5 R01 CA059736-01", "notamember"]]);
    const { kept, skipped } = filterMembersOnly([ROW], awardIndex, memberSet);
    expect(kept).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("skips a row whose award number doesn't resolve to any cwid at all", () => {
    const { kept, skipped } = filterMembersOnly([ROW], new Map(), memberSet);
    expect(kept).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("skips a row whose award number is ambiguous (2+ distinct cwids)", () => {
    const awardIndex = new Map<string, string | "ambiguous">([["5 R01 CA059736-01", "ambiguous"]]);
    const { kept, skipped } = filterMembersOnly([ROW], awardIndex, memberSet);
    expect(kept).toEqual([]);
    expect(skipped).toBe(1);
  });
});

describe("scopeAndLimitRows", () => {
  it("applies --members-only BEFORE --limit — a small --limit samples the scoped set, not the raw file", () => {
    // Non-member row appears FIRST in raw file order; the member row is second.
    // If --limit sliced the raw rows before scoping, --limit=1 would keep the
    // non-member row and the (correct) member row would never be reached.
    const nonMemberRow: ImportRow = { ...ROW, institutionNumber: 1, sourceAwardNumber: "NONMEMBER-AWARD" };
    const memberRow: ImportRow = { ...ROW, institutionNumber: 2, sourceAwardNumber: "MEMBER-AWARD" };
    const awardIndex = new Map<string, string | "ambiguous">([
      ["NONMEMBER-AWARD", "notamember"],
      ["MEMBER-AWARD", "abc1234"],
    ]);
    const memberships = [{ cwid: "abc1234" }];

    const { rows, scopedCount, skipped } = scopeAndLimitRows(
      [nonMemberRow, memberRow],
      { membersOnly: true, limit: 1 },
      awardIndex,
      memberships,
    );

    expect(rows).toEqual([memberRow]);
    expect(scopedCount).toBe(1);
    expect(skipped).toBe(1);
  });

  it("without --members-only, --limit slices the raw rows directly", () => {
    const rowA: ImportRow = { ...ROW, institutionNumber: 1 };
    const rowB: ImportRow = { ...ROW, institutionNumber: 2 };

    const { rows, scopedCount, skipped } = scopeAndLimitRows(
      [rowA, rowB],
      { membersOnly: false, limit: 1 },
      new Map(),
      [],
    );

    expect(rows).toEqual([rowA]);
    expect(scopedCount).toBe(2);
    expect(skipped).toBe(0);
  });

  it("with no --limit, returns every scoped row", () => {
    const memberRow: ImportRow = { ...ROW, institutionNumber: 1, sourceAwardNumber: "MEMBER-AWARD" };
    const awardIndex = new Map<string, string | "ambiguous">([["MEMBER-AWARD", "abc1234"]]);
    const memberships = [{ cwid: "abc1234" }];

    const { rows } = scopeAndLimitRows([memberRow], { membersOnly: true, limit: null }, awardIndex, memberships);

    expect(rows).toEqual([memberRow]);
  });
});

describe("planRow", () => {
  it("resolves the allocation from a membership match, and calls inferCancerFundingJudgments with no `programs` field at all", async () => {
    mockInfer.mockResolvedValue({ cancerRelevantPercent: 90, cancerRelevantRationale: "r" });
    const awardIndex = new Map([["5 R01 CA059736-01", "abc1234"]]);
    const membershipIndex = new Map([["abc1234", "CB"]]);

    const plan = await planRow(ROW, awardIndex, membershipIndex);

    expect(plan.allocation).toEqual({ programCode: "CB", source: "membership" });
    expect(mockInfer).toHaveBeenCalledTimes(1);
    const calledWith = mockInfer.mock.calls[0][0];
    expect(calledWith).not.toHaveProperty("programs");
  });

  it("resolves { programCode: null, source: \"membership\" } — NEVER \"llm\" — when there's no membership match, and still asks Bedrock for the percent", async () => {
    mockInfer.mockResolvedValue({ cancerRelevantPercent: 40, cancerRelevantRationale: "r" });
    const plan = await planRow(ROW, new Map(), new Map());

    expect(plan.allocation).toEqual({ programCode: null, source: "membership" });
    expect(plan.cancerRelevantPercent).toBe(40);
    expect(mockInfer).toHaveBeenCalledTimes(1);
  });

  it("keeps the program allocation resolving correctly from the membership index even when the Bedrock percent call fails outright — the two are decoupled", async () => {
    mockInfer.mockResolvedValue(null);

    const awardIndex = new Map([["5 R01 CA059736-01", "abc1234"]]);
    const membershipIndex = new Map([["abc1234", "CB"]]);
    const withMembership = await planRow(ROW, awardIndex, membershipIndex);
    expect(withMembership.allocation).toEqual({ programCode: "CB", source: "membership" });
    expect(withMembership.cancerRelevantPercent).toBeNull();
    expect(withMembership.cancerRelevantRationale).toBeNull();

    const withoutMembership = await planRow(ROW, new Map(), new Map());
    expect(withoutMembership.allocation).toEqual({ programCode: null, source: "membership" });
    expect(withoutMembership.cancerRelevantPercent).toBeNull();
    expect(withoutMembership.cancerRelevantRationale).toBeNull();
  });

  it("computes isPeerReviewed deterministically from the row's own nihAward/specificFundingSource -- independent of membership/Bedrock", async () => {
    mockInfer.mockResolvedValue(null); // even when Bedrock fails outright
    const nihRow = { ...ROW, nihAward: true, specificFundingSource: "National Cancer Institute" };
    expect((await planRow(nihRow, new Map(), new Map())).isPeerReviewed).toBe(true);

    const nonNihListedRow = { ...ROW, nihAward: false, specificFundingSource: "National Science Foundation" };
    expect((await planRow(nonNihListedRow, new Map(), new Map())).isPeerReviewed).toBe(true);

    const neitherRow = { ...ROW, nihAward: false, specificFundingSource: "Columbia University" };
    expect((await planRow(neitherRow, new Map(), new Map())).isPeerReviewed).toBe(false);
  });
});

/** Shape of an `update()` call this suite inspects — narrower than the real
 *  Prisma args, just enough to read `.data` off a captured call without a
 *  bare `any`. */
type CapturedUpdate = { data: Record<string, unknown> };

function makeDb(
  existing: Record<
    string,
    { id: string; cancerRelevantPercent?: number | null; cancerRelevantPercentSource: string; allocations: { source: string }[] }
  >,
) {
  const created: unknown[] = [];
  const updated: CapturedUpdate[] = [];
  const db: Nci2aImportDb = {
    grant: { findMany: vi.fn(async () => []) },
    centerMembership: { findMany: vi.fn(async () => []) },
    cancerCenterFundingAward: {
      findUnique: vi.fn(async (args: unknown) => {
        const key = `${(args as { where: { centerCode_reportingCycle_institutionNumber: { institutionNumber: number } } }).where.centerCode_reportingCycle_institutionNumber.institutionNumber}`;
        const row = existing[key];
        return row ? { ...row, cancerRelevantPercent: row.cancerRelevantPercent ?? null } : null;
      }),
      create: vi.fn(async (args) => {
        created.push(args);
      }),
      update: vi.fn(async (args: CapturedUpdate) => {
        updated.push(args);
      }),
    },
  };
  return { db, created, updated };
}

const PLAN = {
  row: ROW,
  grantCwid: "abc1234",
  allocation: { programCode: "CB", source: "membership" as const },
  cancerRelevantPercent: 90,
  cancerRelevantRationale: "r",
  isPeerReviewed: true,
};

describe("applyPlan", () => {
  it("creates a fresh row when none exists for this cycle", async () => {
    const { db, created } = makeDb({});
    const counts = emptyCounts();
    await applyPlan(db, PLAN, RUN, counts);
    expect(created).toHaveLength(1);
    expect(counts.created).toBe(1);
    expect(counts.membershipResolved).toBe(1);
    const data = (created[0] as { data: Record<string, unknown> }).data;
    expect(data.isPeerReviewed).toBe(true);
  });

  it("always overwrites isPeerReviewed on update, even when the percent is human-sourced -- it's not an overridable judgment column", async () => {
    const { db, updated } = makeDb({
      "12345": { id: "award-1", cancerRelevantPercentSource: "human", allocations: [{ source: "llm" }] },
    });
    const counts = emptyCounts();
    await applyPlan(db, { ...PLAN, isPeerReviewed: false }, RUN, counts);
    expect(updated[0].data.isPeerReviewed).toBe(false);
  });

  it("updates both percent and allocations when neither is human-sourced", async () => {
    const { db, updated } = makeDb({
      "12345": { id: "award-1", cancerRelevantPercentSource: "llm", allocations: [{ source: "llm" }] },
    });
    const counts = emptyCounts();
    await applyPlan(db, PLAN, RUN, counts);
    expect(updated).toHaveLength(1);
    const data = updated[0].data;
    expect(data.cancerRelevantPercent).toBe(90);
    expect(data.allocations).toBeDefined();
    expect(counts.percentSkippedHuman).toBe(0);
    expect(counts.allocationsSkippedHuman).toBe(0);
  });

  it("skips the percent field when the existing value is human-sourced", async () => {
    const { db, updated } = makeDb({
      "12345": { id: "award-1", cancerRelevantPercentSource: "human", allocations: [{ source: "llm" }] },
    });
    const counts = emptyCounts();
    await applyPlan(db, PLAN, RUN, counts);
    const data = updated[0].data;
    expect(data.cancerRelevantPercent).toBeUndefined();
    expect(data.allocations).toBeDefined(); // allocations still replaced independently
    expect(counts.percentSkippedHuman).toBe(1);
  });

  it("skips the WHOLE allocation set when ANY existing allocation is human-sourced — never a partial clobber", async () => {
    const { db, updated } = makeDb({
      "12345": {
        id: "award-1",
        cancerRelevantPercentSource: "llm",
        allocations: [{ source: "human" }, { source: "llm" }],
      },
    });
    const counts = emptyCounts();
    await applyPlan(db, PLAN, RUN, counts);
    const data = updated[0].data;
    expect(data.allocations).toBeUndefined();
    expect(data.cancerRelevantPercent).toBe(90); // percent still updates independently
    expect(counts.allocationsSkippedHuman).toBe(1);
  });

  it("does NOT clobber a prior successful percent when THIS cycle's Bedrock call fails", async () => {
    // Regression: `touchPercent` used to gate only on `source !== "human"`, so
    // a re-run whose inference call fails this time (plan.cancerRelevantPercent
    // = null, per inferCancerFundingJudgments' fail-soft contract) would
    // overwrite an existing llm-sourced 75% with null — reverting an
    // already-reviewed row back to "not yet inferred" for no reason.
    const { db, updated } = makeDb({
      "12345": {
        id: "award-1",
        cancerRelevantPercent: 75,
        cancerRelevantPercentSource: "llm",
        allocations: [{ source: "llm" }],
      },
    });
    const failedRetryPlan = { ...PLAN, cancerRelevantPercent: null, cancerRelevantRationale: null };
    const counts = emptyCounts();
    await applyPlan(db, failedRetryPlan, RUN, counts);
    const data = updated[0].data;
    expect(data.cancerRelevantPercent).toBeUndefined(); // untouched, not overwritten with null
    expect(data.cancerRelevantPercentSource).toBeUndefined();
    expect(counts.percentSkippedInferenceFailed).toBe(1);
    expect(counts.percentSkippedHuman).toBe(0); // not a human override — a different reason
  });

  it("DOES write a failed-retry's null when the existing row had no value to lose", async () => {
    const { db, updated } = makeDb({
      "12345": { id: "award-1", cancerRelevantPercent: null, cancerRelevantPercentSource: "llm", allocations: [{ source: "llm" }] },
    });
    const failedRetryPlan = { ...PLAN, cancerRelevantPercent: null, cancerRelevantRationale: null };
    const counts = emptyCounts();
    await applyPlan(db, failedRetryPlan, RUN, counts);
    const data = updated[0].data;
    expect(data.cancerRelevantPercent).toBeNull(); // nothing to lose — fine to write null->null
    expect(counts.percentSkippedInferenceFailed).toBe(0);
  });

  it("--dry-run writes nothing", async () => {
    const { db, created, updated } = makeDb({});
    const counts = emptyCounts();
    await applyPlan(db, PLAN, DRY, counts);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(counts.created).toBe(1); // still counted, just not written
  });
});

describe("CENTER_CODE", () => {
  it("is the Meyer Cancer Center code", () => {
    expect(CENTER_CODE).toBe("meyer_cancer_center");
  });
});
