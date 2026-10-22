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
 *  10. MCC's rubric rules (an NCI award, Lynch syndrome → 100, `source: "rule"`, no
 *      Bedrock call), the Grant abstract/PHR reaching the prompt, and provenance
 *      written with the AI/rule value but never over a human one.
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
  buildGrantTextIndex,
  buildMembershipIndex,
  buildMembershipExistenceSet,
  filterMembersOnly,
  scopeAndLimitRows,
  loadImportRows,
  planRow,
  applyPlan,
  carriedHumanPercent,
  CENTER_CODE,
  type ImportOptions,
  type ImportRow,
  type Nci2aImportDb,
  type ApplyCounts,
  type RowPlan,
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

/** A non-NCI award, so `planRow` asks Bedrock rather than applying MCC's NCI rule. */
const LLM_ROW: ImportRow = {
  ...ROW,
  sourceAwardNumber: "5 R01 GM059736-01",
  projectNumber: "5 R01 GM059736-01",
  specificFundingSource: "National Institute of General Medical Sciences",
  projectTitle: "Ion channel gating",
};

const INFERENCE = {
  cancerRelevantPercent: 25,
  cancerRelevantRationale: "r",
  cancerRelevantModel: "us.anthropic.claude-sonnet-test",
  cancerRelevantPromptHash: "abcdef012345",
  cancerRelevantInputHash: "f".repeat(64),
  cancerRelevantInferredAt: new Date("2026-10-19T00:00:00Z"),
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
    percentCarriedHuman: 0,
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
    const awardIndex = new Map([["5 R01 GM059736-01", "abc1234"]]);
    const membershipIndex = new Map([["abc1234", "CB"]]);

    const plan = await planRow(LLM_ROW, awardIndex, membershipIndex);

    expect(plan.allocation).toEqual({ programCode: "CB", source: "membership" });
    expect(mockInfer).toHaveBeenCalledTimes(1);
    const calledWith = mockInfer.mock.calls[0][0];
    expect(calledWith).not.toHaveProperty("programs");
  });

  it("resolves { programCode: null, source: \"membership\" } — NEVER \"llm\" — when there's no membership match, and still asks Bedrock for the percent", async () => {
    mockInfer.mockResolvedValue({ cancerRelevantPercent: 40, cancerRelevantRationale: "r" });
    const plan = await planRow(LLM_ROW, new Map(), new Map());

    expect(plan.allocation).toEqual({ programCode: null, source: "membership" });
    expect(plan.cancerRelevantPercent).toBe(40);
    expect(mockInfer).toHaveBeenCalledTimes(1);
  });

  it("keeps the program allocation resolving correctly from the membership index even when the Bedrock percent call fails outright — the two are decoupled", async () => {
    mockInfer.mockResolvedValue(null);

    const awardIndex = new Map([["5 R01 GM059736-01", "abc1234"]]);
    const membershipIndex = new Map([["abc1234", "CB"]]);
    const withMembership = await planRow(LLM_ROW, awardIndex, membershipIndex);
    expect(withMembership.allocation).toEqual({ programCode: "CB", source: "membership" });
    expect(withMembership.cancerRelevantPercent).toBeNull();
    expect(withMembership.cancerRelevantRationale).toBeNull();

    const withoutMembership = await planRow(LLM_ROW, new Map(), new Map());
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

  it("a CA award number gets 100 by MCC's NCI rule with no Bedrock call", async () => {
    const plan = await planRow({ ...ROW, specificFundingSource: "Some University" }, new Map(), new Map());
    expect(mockInfer).not.toHaveBeenCalled();
    expect(plan.cancerRelevantPercent).toBe(100);
    expect(plan.cancerRelevantPercentSource).toBe("rule");
    expect(plan.cancerRelevantRationale).toBe("NCI award: 100% under MCC's rubric.");
    expect(plan.provenance.cancerRelevantModel).toBe("rule:nci");
    expect(plan.provenance.cancerRelevantPromptHash).toBeNull();
    expect(plan.provenance.cancerRelevantInferredAt).toBeInstanceOf(Date);
  });

  it("a funding source naming the National Cancer Institute gets 100 even without a CA number", async () => {
    const plan = await planRow(
      { ...LLM_ROW, specificFundingSource: "NIH/National Cancer Institute (via Columbia University)" },
      new Map(),
      new Map(),
    );
    expect(mockInfer).not.toHaveBeenCalled();
    expect(plan.provenance.cancerRelevantModel).toBe("rule:nci");
  });

  it("Lynch syndrome in the abstract gets 100 by rule", async () => {
    const textIndex = buildGrantTextIndex([
      { awardNumber: "5 R01 GM059736-01", cwid: "abc1234", abstract: "Mismatch repair in Lynch syndrome carriers.", phrText: null },
    ]);
    const plan = await planRow(LLM_ROW, new Map(), new Map(), textIndex);
    expect(mockInfer).not.toHaveBeenCalled();
    expect(plan.cancerRelevantPercent).toBe(100);
    expect(plan.provenance.cancerRelevantModel).toBe("rule:lynch");
  });

  it("sends the Grant abstract and PHR to Bedrock when present, and carries its provenance", async () => {
    mockInfer.mockResolvedValue(INFERENCE);
    const textIndex = buildGrantTextIndex([
      { awardNumber: "5 R01 GM059736-01", cwid: "abc1234", abstract: null, phrText: null },
      { awardNumber: "5 r01 gm059736-01", cwid: "xyz9999", abstract: "An abstract.", phrText: "A PHR." },
    ]);
    const plan = await planRow(LLM_ROW, new Map(), new Map(), textIndex);
    expect(mockInfer.mock.calls[0][0]).toMatchObject({ abstract: "An abstract.", phrText: "A PHR." });
    expect(plan.cancerRelevantPercentSource).toBe("llm");
    expect(plan.provenance).toEqual({
      cancerRelevantModel: INFERENCE.cancerRelevantModel,
      cancerRelevantPromptHash: INFERENCE.cancerRelevantPromptHash,
      cancerRelevantInputHash: INFERENCE.cancerRelevantInputHash,
      cancerRelevantInferredAt: INFERENCE.cancerRelevantInferredAt,
    });
  });

  it("sends null abstract/PHR when no Grant matches, and null provenance when inference fails", async () => {
    mockInfer.mockResolvedValue(null);
    const plan = await planRow(LLM_ROW, new Map(), new Map());
    expect(mockInfer.mock.calls[0][0]).toMatchObject({ abstract: null, phrText: null });
    expect(plan.provenance.cancerRelevantModel).toBeNull();
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
      findMany: vi.fn(async () => []),
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

const PLAN: RowPlan = {
  row: ROW,
  grantCwid: "abc1234",
  allocation: { programCode: "CB", source: "membership" as const },
  cancerRelevantPercent: 90,
  cancerRelevantRationale: "r",
  cancerRelevantPercentSource: "llm",
  provenance: {
    cancerRelevantModel: INFERENCE.cancerRelevantModel,
    cancerRelevantPromptHash: INFERENCE.cancerRelevantPromptHash,
    cancerRelevantInputHash: INFERENCE.cancerRelevantInputHash,
    cancerRelevantInferredAt: INFERENCE.cancerRelevantInferredAt,
  },
  isPeerReviewed: true,
};

const RULE_PLAN: RowPlan = {
  ...PLAN,
  cancerRelevantPercent: 100,
  cancerRelevantRationale: "NCI award: 100% under MCC's rubric.",
  cancerRelevantPercentSource: "rule",
  provenance: {
    cancerRelevantModel: "rule:nci",
    cancerRelevantPromptHash: null,
    cancerRelevantInputHash: null,
    cancerRelevantInferredAt: INFERENCE.cancerRelevantInferredAt,
  },
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

  it("writes the AI original alongside a created row's llm percent", async () => {
    const { db, created } = makeDb({});
    await applyPlan(db, PLAN, RUN, emptyCounts());
    const data = (created[0] as { data: Record<string, unknown> }).data;
    expect(data.cancerRelevantPercentAi).toBe(90);
    expect(data.cancerRelevantPercentSource).toBe("llm");
  });

  it("refreshes the AI original with the percent on an unreviewed row", async () => {
    const { db, updated } = makeDb({
      "12345": { id: "award-1", cancerRelevantPercent: 40, cancerRelevantPercentSource: "llm", allocations: [] },
    });
    await applyPlan(db, PLAN, RUN, emptyCounts());
    expect(updated[0].data.cancerRelevantPercentAi).toBe(90);
  });

  it("never touches the AI original (or the percent) of a human-sourced row", async () => {
    const { db, updated } = makeDb({
      "12345": { id: "award-1", cancerRelevantPercent: 40, cancerRelevantPercentSource: "human", allocations: [] },
    });
    await applyPlan(db, PLAN, RUN, emptyCounts());
    expect(updated[0].data).not.toHaveProperty("cancerRelevantPercentAi");
    expect(updated[0].data).not.toHaveProperty("cancerRelevantPercent");
  });

  it("keeps the prior AI original when this cycle's inference fails", async () => {
    const { db, updated } = makeDb({
      "12345": { id: "award-1", cancerRelevantPercent: 75, cancerRelevantPercentSource: "llm", allocations: [] },
    });
    await applyPlan(db, { ...PLAN, cancerRelevantPercent: null, cancerRelevantRationale: null }, RUN, emptyCounts());
    expect(updated[0].data).not.toHaveProperty("cancerRelevantPercentAi");
  });

  it("writes provenance with the AI value on create and on an unreviewed update", async () => {
    const { db, created, updated } = makeDb({
      "1": { id: "award-1", cancerRelevantPercent: 40, cancerRelevantPercentSource: "llm", allocations: [] },
    });
    await applyPlan(db, PLAN, RUN, emptyCounts());
    await applyPlan(db, { ...PLAN, row: { ...ROW, institutionNumber: 1 } }, RUN, emptyCounts());
    for (const data of [(created[0] as { data: Record<string, unknown> }).data, updated[0].data]) {
      expect(data).toMatchObject({
        cancerRelevantModel: INFERENCE.cancerRelevantModel,
        cancerRelevantPromptHash: INFERENCE.cancerRelevantPromptHash,
        cancerRelevantInputHash: INFERENCE.cancerRelevantInputHash,
        cancerRelevantInferredAt: INFERENCE.cancerRelevantInferredAt,
      });
    }
  });

  it("leaves a human override's provenance alone", async () => {
    const { db, updated } = makeDb({
      "12345": { id: "award-1", cancerRelevantPercent: 40, cancerRelevantPercentSource: "human", allocations: [] },
    });
    await applyPlan(db, PLAN, RUN, emptyCounts());
    expect(updated[0].data).not.toHaveProperty("cancerRelevantModel");
    expect(updated[0].data).not.toHaveProperty("cancerRelevantInferredAt");
  });

  it("a rule row replaces an older AI value, as source rule, but never a human one", async () => {
    const { db, created, updated } = makeDb({
      "12345": { id: "award-1", cancerRelevantPercent: 50, cancerRelevantPercentSource: "llm", allocations: [] },
      "2": { id: "award-2", cancerRelevantPercent: 40, cancerRelevantPercentSource: "human", allocations: [] },
    });
    await applyPlan(db, RULE_PLAN, RUN, emptyCounts());
    expect(updated[0].data).toMatchObject({
      cancerRelevantPercent: 100,
      cancerRelevantPercentSource: "rule",
      cancerRelevantPercentAi: 100,
      cancerRelevantModel: "rule:nci",
    });
    const counts = emptyCounts();
    await applyPlan(db, { ...RULE_PLAN, row: { ...ROW, institutionNumber: 2 } }, RUN, counts);
    expect(updated[1].data).not.toHaveProperty("cancerRelevantPercent");
    expect(counts.percentSkippedHuman).toBe(1);
    await applyPlan(db, { ...RULE_PLAN, row: { ...ROW, institutionNumber: 3 } }, RUN, emptyCounts());
    expect((created[0] as { data: Record<string, unknown> }).data.cancerRelevantPercentSource).toBe("rule");
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

describe("carry-forward of a reviewer's percent", () => {
  const prior = (over: Partial<{ reportingCycle: string; institutionNumber: number; projectEndDate: string; pct: number | null }> = {}) => ({
    reportingCycle: over.reportingCycle ?? "osra-2025-07-01",
    institutionNumber: over.institutionNumber ?? ROW.institutionNumber,
    projectEndDate: new Date(`${over.projectEndDate ?? "2028-12-31"}T00:00:00Z`),
    cancerRelevantPercent: over.pct === undefined ? 50 : over.pct,
  });

  it("carries the same award's human percent within its project period, latest cycle first", () => {
    expect(carriedHumanPercent(ROW, [prior(), prior({ reportingCycle: "osra-2025-12-01", pct: 25 })])).toBe(25);
  });

  it("does not carry across a renewal, another award, or the same cycle", () => {
    expect(carriedHumanPercent(ROW, [prior({ projectEndDate: "2023-12-31" })])).toBeNull();
    expect(carriedHumanPercent(ROW, [prior({ institutionNumber: 999 })])).toBeNull();
    expect(carriedHumanPercent(ROW, [prior({ reportingCycle: ROW.reportingCycle })])).toBeNull();
    expect(carriedHumanPercent(ROW, [prior({ pct: null })])).toBeNull();
  });

  it("creates the new cycle's row as human with the carried value, keeping the model's in *Ai", async () => {
    const { db, created } = makeDb({});
    const counts = emptyCounts();
    await applyPlan(db, PLAN, RUN, counts, 50);
    const data = (created[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ cancerRelevantPercent: 50, cancerRelevantPercentSource: "human", cancerRelevantPercentAi: 90 });
    expect(counts.percentCarriedHuman).toBe(1);
  });

  it("upgrades an unreviewed row of this cycle, even when Bedrock failed", async () => {
    const { db, updated } = makeDb({ "12345": { id: "a1", cancerRelevantPercent: 90, cancerRelevantPercentSource: "llm", allocations: [] } });
    await applyPlan(db, { ...PLAN, cancerRelevantPercent: null }, RUN, emptyCounts(), 25);
    expect(updated[0].data).toMatchObject({ cancerRelevantPercent: 25, cancerRelevantPercentSource: "human" });
  });

  it("never touches a row already reviewed in this cycle", async () => {
    const { db, updated } = makeDb({ "12345": { id: "a1", cancerRelevantPercent: 75, cancerRelevantPercentSource: "human", allocations: [] } });
    await applyPlan(db, PLAN, RUN, emptyCounts(), 25);
    expect(updated[0].data).not.toHaveProperty("cancerRelevantPercent");
  });
});
