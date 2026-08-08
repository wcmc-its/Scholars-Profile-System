/**
 * NCI Table 2A cycle import (`scripts/backfills/2026-08-08-cancer-center-nci-2a-import.ts`).
 * Drives the exported, dependency-injected functions with fake Prisma delegates and a
 * mocked Bedrock inference call — no live DB, no real Bedrock. Covers:
 *   1. Arg parsing: --file required, --dry-run, --limit/--concurrency validation.
 *   2. normalizeAwardNumber: whitespace collapse + case fold.
 *   3. buildAwardNumberIndex: unique match resolves; 2+ distinct cwids -> "ambiguous",
 *      never guessed.
 *   4. planRow: a membership match skips the Bedrock program ask entirely (source=
 *      "membership", no `programs` sent); no match asks Bedrock for a program guess
 *      (source="llm"); a failed Bedrock call (inference returns null) leaves the
 *      percent/rationale null and the allocation an explicit programCode:null gap.
 *   5. applyPlan (the non-clobber contract): new row creates; existing row updates
 *      both percent and allocations; a HUMAN-sourced percent is skipped on update; a
 *      HUMAN-sourced allocation blocks the WHOLE allocation replace (never partial);
 *      --dry-run writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInfer } = vi.hoisted(() => ({ mockInfer: vi.fn() }));
vi.mock("@/lib/edit/cancer-center-funding-generator", () => ({
  inferCancerFundingJudgments: mockInfer,
}));

import {
  parseArgs,
  normalizeAwardNumber,
  buildAwardNumberIndex,
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
};

const PROGRAMS = [{ code: "CB", label: "Cancer Biology" }];

const RUN: ImportOptions = { dryRun: false, limit: null, concurrency: 5, file: "x" };
const DRY: ImportOptions = { ...RUN, dryRun: true };

function emptyCounts(): ApplyCounts {
  return {
    created: 0,
    updated: 0,
    membershipResolved: 0,
    llmProgramResolved: 0,
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
    expect(opts).toEqual({ dryRun: true, limit: 10, concurrency: 3, file: "x.json" });
  });
  it("defaults concurrency to 5 and rejects a non-positive limit", () => {
    expect(parseArgs(["--file=x.json"]).concurrency).toBe(5);
    expect(() => parseArgs(["--file=x.json", "--limit=0"])).toThrow(/--limit/);
    expect(() => parseArgs(["--file=x.json", "--concurrency=-1"])).toThrow(/--concurrency/);
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

describe("planRow", () => {
  it("uses the membership match and never asks Bedrock for a program", async () => {
    mockInfer.mockResolvedValue({ cancerRelevantPercent: 90, cancerRelevantRationale: "r" });
    const awardIndex = new Map([["5 R01 CA059736-01", "abc1234"]]);
    const membershipIndex = new Map([["abc1234", "CB"]]);

    const plan = await planRow(ROW, awardIndex, membershipIndex, PROGRAMS);

    expect(plan.allocation).toEqual({ programCode: "CB", source: "membership" });
    expect(mockInfer).toHaveBeenCalledWith(expect.objectContaining({ programs: [] }));
  });

  it("asks Bedrock for a program when there's no membership match", async () => {
    mockInfer.mockResolvedValue({
      cancerRelevantPercent: 40,
      cancerRelevantRationale: "r",
      programCode: "CB",
      programRationale: "fits",
    });
    const plan = await planRow(ROW, new Map(), new Map(), PROGRAMS);

    expect(plan.allocation).toEqual({ programCode: "CB", source: "llm" });
    expect(mockInfer).toHaveBeenCalledWith(expect.objectContaining({ programs: PROGRAMS }));
  });

  it("leaves an explicit gap (programCode: null) when Bedrock fails outright", async () => {
    mockInfer.mockResolvedValue(null);
    const plan = await planRow(ROW, new Map(), new Map(), PROGRAMS);

    expect(plan.allocation).toEqual({ programCode: null, source: "llm" });
    expect(plan.cancerRelevantPercent).toBeNull();
    expect(plan.cancerRelevantRationale).toBeNull();
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
    centerProgram: { findMany: vi.fn(async () => []) },
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
};

describe("applyPlan", () => {
  it("creates a fresh row when none exists for this cycle", async () => {
    const { db, created } = makeDb({});
    const counts = emptyCounts();
    await applyPlan(db, PLAN, RUN, counts);
    expect(created).toHaveLength(1);
    expect(counts.created).toBe(1);
    expect(counts.membershipResolved).toBe(1);
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
