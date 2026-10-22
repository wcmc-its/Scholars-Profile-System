/**
 * NCI CCSG Data Table 2A — import one OSRA "Active Awards" workbook cycle into
 * `CancerCenterFundingAward` / `CancerCenterProgramAllocation`
 * (`2026-08-08-cancer-center-nci-table-2a-feature-plan.md`).
 *
 * SOURCE FILE — a JSON array produced by
 * `~/Dropbox/Projects/Scholars-Profile-System/build-2a-skeleton.py --import-json`
 * (Python parses the OSRA xlsx and computes the retained-direct-cost math; this
 * script never reads the workbook itself). Real award/PI data — the file lives
 * outside this repo and `--file` has no default; pass it explicitly.
 *
 * PROGRAM ASSIGNMENT — existing data ONLY, never a model guess:
 *   1. Normalize the OSRA "Award Number" and match it against `Grant.awardNumber`
 *      (both already use the same spaced NIH format in practice — see the
 *      feature plan). A normalized number matching MORE THAN ONE distinct
 *      `Grant.cwid` is treated as ambiguous, never guessed.
 *   2. A resolved cwid's `CenterMembership.programCode` for this center, if any,
 *      becomes the allocation directly — `source: "membership"`, 100%.
 * Program assignment is a pre-existing person-level fact, not something an LLM
 * should ever assert. A Meyer member with no program assigned yet (or a row
 * whose award number doesn't resolve at all) gets `programCode: null,
 * source: "membership"` — an explicit, honest gap, never a guess.
 * `cancerRelevantPercent` has no data source anywhere. MCC's rubric decides
 * two cases outright (`cancerRelevanceRule`: an NCI award, Lynch syndrome →
 * 100, `source: "rule"`, no Bedrock call); every other row asks Bedrock, with
 * the matching `Grant`'s abstract and PHR statement, regardless of program
 * resolution — see `lib/edit/cancer-center-funding-generator.ts`. That is a
 * fully separate concept from program assignment above.
 *
 * `isPeerReviewed` (DT2A rule #4) is a THIRD, fully separate concept again —
 * deterministic, no Bedrock, no override — see
 * `lib/edit/cancer-center-peer-review.ts`. Computed alongside the allocation
 * in `planRow`, written as a plain scalar in `applyPlan` (always overwritten
 * on a re-run, unlike `cancerRelevantPercent` — there is no human override
 * to clobber).
 *
 * NON-CLOBBER — a reviewer's override always wins over a re-run of this script
 * for the SAME (centerCode, reportingCycle, institutionNumber): `update` skips
 * `cancerRelevantPercent` when its `source` is already `"human"`, and skips
 * replacing the allocation set entirely when ANY existing allocation is
 * `"human"`-sourced (never a partial clobber of a mixed set).
 *
 * CARRY-FORWARD — a reviewer's percent also outlives its cycle. A NEW cycle row
 * takes a prior cycle's "human" percent for the same `institutionNumber` (OSRA's
 * award record) while it's the same project period: the new row starts on or
 * before the prior row's `projectEndDate`. A renewal (new period) is judged
 * afresh. Bedrock still runs, so `cancerRelevantPercentAi` keeps the model's view.
 *
 * AI ORIGINAL — every llm- or rule-sourced percent this script writes is also
 * written to `cancerRelevantPercentAi`, so the report can tell a reviewer's
 * correction from a confirmation, with its provenance (`cancerRelevantModel`,
 * prompt/input hashes, `cancerRelevantInferredAt`). They move with the
 * percent: a row whose percent is skipped (human-sourced, or this cycle's
 * inference failed) keeps its AI value and provenance too, so a human row's
 * "AI said X%" stays the value the reviewer actually saw.
 *
 * NOT AUDITED — this is a machine-run batch import, not a signed-in actor's
 * `/api/edit` write; same posture as every other ETL ingest in this repo (see
 * `lib/edit/audit.ts`). A reviewer's later override IS audited
 * (`cancer_funding_override`, in the API route that serves the UI panel).
 *
 * ponytail: no cross-cycle inference reuse — a re-imported cycle (even for an
 * award unchanged since last cycle) re-asks Bedrock for every LLM-sourced row.
 * Fine at ~1,600 rows/cycle and an infrequent (per-OSRA-pull) cadence; revisit
 * with a carry-forward-from-prior-cycle path if cadence or volume grow an
 * order of magnitude.
 *
 * Flags:
 *   --file=<path>         REQUIRED — the import JSON (see SOURCE FILE above).
 *   --dry-run              report what would happen; write nothing.
 *   --limit=<n>            cap the number of rows processed (sampling / smoke test).
 *   --concurrency=<n>      parallel Bedrock calls (default 5).
 *   --members-only         scope the run to Meyer Cancer Center members only — a row
 *                          is kept only when its award number resolves (uniquely) to a
 *                          cwid that has ANY Meyer `CenterMembership` row, program
 *                          assigned or not. An unresolved or ambiguous award number has
 *                          no identity to check membership against, so it's skipped too
 *                          (see `filterMembersOnly`). Applied BEFORE `--limit`, so a
 *                          small `--limit` run samples real member rows.
 *
 * Run: npx tsx scripts/backfills/2026-08-08-cancer-center-nci-2a-import.ts \
 *        --file=/path/to/nci-table-2a-import.json [--dry-run] [--limit=N] [--members-only]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeAwardNumber, parseNihAward } from "@/lib/award-number";
import { inferCancerFundingJudgments } from "@/lib/edit/cancer-center-funding-generator";
import { isPeerReviewedFundingSource } from "@/lib/edit/cancer-center-peer-review";

export const CENTER_CODE = "meyer_cancer_center";

/** One row from the Python-produced import JSON. */
export type ImportRow = {
  reportingCycle: string;
  institutionNumber: number;
  sourceAwardNumber: string;
  pi: string;
  specificFundingSource: string;
  projectNumber: string;
  projectTitle: string;
  projectStartDate: string; // YYYY-MM-DD
  projectEndDate: string; // YYYY-MM-DD
  annualProjectDirectCosts: number;
  nihActivityCode: string | null;
  /** OSRA's own "NIH Award" Y/N flag -- feeds the deterministic Peer-Reviewed
   *  classification (DT2A rule #4), see `lib/edit/cancer-center-peer-review.ts`. */
  nihAward: boolean;
};

export type ImportOptions = {
  dryRun: boolean;
  limit: number | null;
  concurrency: number;
  file: string;
  membersOnly: boolean;
};

/** The narrow Prisma surface this script touches — structural so unit tests can
 *  supply a mock without a live DB. */
export type Nci2aImportDb = {
  grant: {
    findMany(args: {
      where: { awardNumber: { not: null } };
      select: { awardNumber: true; cwid: true; abstract: true; phrText: true };
    }): Promise<GrantText[]>;
  };
  centerMembership: {
    findMany(args: {
      where: { centerCode: string; programCode?: { not: null } };
      select: { cwid: true; programCode: true };
    }): Promise<{ cwid: string; programCode: string | null }[]>;
  };
  cancerCenterFundingAward: {
    findUnique(args: unknown): Promise<ExistingAward | null>;
    findMany(args: unknown): Promise<PriorHumanPercent[]>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
};

/** A reviewer-set percent from any cycle — the carry-forward source. */
export type PriorHumanPercent = {
  reportingCycle: string;
  institutionNumber: number;
  projectEndDate: Date;
  cancerRelevantPercent: unknown; // Prisma Decimal
};

/** The latest prior cycle's human percent for `row`'s award, while `row` is
 *  still in that row's project period; else null (see CARRY-FORWARD). */
export function carriedHumanPercent(row: ImportRow, prior: PriorHumanPercent[]): number | null {
  const hit = prior
    .filter(
      (p) =>
        p.institutionNumber === row.institutionNumber &&
        p.reportingCycle !== row.reportingCycle &&
        p.cancerRelevantPercent != null &&
        row.projectStartDate <= p.projectEndDate.toISOString().slice(0, 10),
    )
    .sort((a, b) => b.reportingCycle.localeCompare(a.reportingCycle))[0];
  return hit ? Number(hit.cancerRelevantPercent) : null;
}

type GrantText = { awardNumber: string | null; cwid: string; abstract: string | null; phrText: string | null };

type ExistingAward = {
  id: string;
  cancerRelevantPercent: number | null;
  cancerRelevantPercentSource: string;
  allocations: { source: string }[];
};

const log = (msg: string) => console.log(msg);

export function parseArgs(argv: string[]): ImportOptions {
  const dryRun = argv.includes("--dry-run");

  const fileArg = argv.find((a) => a.startsWith("--file="));
  if (!fileArg) {
    throw new Error("--file=<path to nci-table-2a-import.json> is required (no default — real award data lives outside the repo).");
  }
  const file = fileArg.slice("--file=".length);

  const limitArg = argv.find((a) => a.startsWith("--limit="));
  let limit: number | null = null;
  if (limitArg) {
    const n = Number.parseInt(limitArg.slice("--limit=".length), 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit must be a positive integer, got "${limitArg}"`);
    limit = n;
  }

  const concurrencyArg = argv.find((a) => a.startsWith("--concurrency="));
  let concurrency = 5;
  if (concurrencyArg) {
    const n = Number.parseInt(concurrencyArg.slice("--concurrency=".length), 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--concurrency must be a positive integer, got "${concurrencyArg}"`);
    concurrency = n;
  }

  const membersOnly = argv.includes("--members-only");

  return { dryRun, limit, concurrency, file, membersOnly };
}

// Re-exported (not redefined) so this script's own call sites below keep
// resolving `normalizeAwardNumber`, while also sharing it with the GET route
// that serves this import's review panel
// (`app/api/edit/center/[code]/nci-2a/route.ts`), which re-does this same
// join against `Grant.awardNumber` at read time to resolve `applId` — see
// `lib/award-number.ts` for the contract.
export { normalizeAwardNumber };

export function loadImportRows(filePath: string): ImportRow[] {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const parsed: unknown = JSON.parse(readFileSync(absPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain a JSON array of rows`);
  const rows = parsed as ImportRow[];
  // `nihAward` feeds the deterministic Peer-Reviewed classification (DT2A
  // rule #4, see cancer-center-peer-review.ts) — a JSON file built before
  // build-2a-skeleton.py grew this field would silently read `undefined`
  // (falsy), misclassifying real NIH awards as non-peer-reviewed instead of
  // failing loudly. Caught here, at load time, before any Bedrock spend.
  const badRow = rows.findIndex((r) => typeof r.nihAward !== "boolean");
  if (badRow !== -1) {
    throw new Error(
      `${filePath} row ${badRow} has no boolean "nihAward" field — regenerate with the current ` +
        `build-2a-skeleton.py --import-json (must include OSRA's "NIH Award" flag).`,
    );
  }
  return rows;
}

/** normalizedAwardNumber -> the ONE cwid it resolves to, or `"ambiguous"` when
 *  more than one distinct cwid shares that normalized number — never guessed. */
export function buildAwardNumberIndex(
  grants: { awardNumber: string | null; cwid: string }[],
): Map<string, string | "ambiguous"> {
  const byNumber = new Map<string, Set<string>>();
  for (const g of grants) {
    if (!g.awardNumber) continue;
    const key = normalizeAwardNumber(g.awardNumber);
    if (!byNumber.has(key)) byNumber.set(key, new Set());
    byNumber.get(key)!.add(g.cwid);
  }
  const index = new Map<string, string | "ambiguous">();
  for (const [key, cwids] of byNumber) {
    index.set(key, cwids.size === 1 ? [...cwids][0] : "ambiguous");
  }
  return index;
}

/** normalizedAwardNumber -> the abstract / PHR statement of a `Grant` row with
 *  that number (first non-null of each). Text belongs to the project, not the
 *  person, so an award number shared by several cwids still has one text. */
export function buildGrantTextIndex(
  grants: GrantText[],
): Map<string, { abstract: string | null; phrText: string | null }> {
  const index = new Map<string, { abstract: string | null; phrText: string | null }>();
  for (const g of grants) {
    if (!g.awardNumber) continue;
    const key = normalizeAwardNumber(g.awardNumber);
    const cur = index.get(key) ?? { abstract: null, phrText: null };
    index.set(key, { abstract: cur.abstract ?? g.abstract, phrText: cur.phrText ?? g.phrText });
  }
  return index;
}

/** cwid -> programCode, ONLY for memberships that already have one assigned.
 *  Deliberately narrower than "is a member" (`buildMembershipExistenceSet`) —
 *  a Meyer member with no program yet must still count as a member for
 *  `--members-only`, even though `planRow` has no program to hand them. */
export function buildMembershipIndex(memberships: { cwid: string; programCode: string | null }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const m of memberships) {
    if (m.programCode) index.set(m.cwid, m.programCode);
  }
  return index;
}

/** Every cwid with ANY Meyer `CenterMembership` row, program-assigned or not.
 *  This is the "is a member" test `--members-only` scopes against — separate
 *  from `buildMembershipIndex` because membership and program-assignment are
 *  different facts (see the module doc's PROGRAM ASSIGNMENT section). */
export function buildMembershipExistenceSet(memberships: { cwid: string }[]): Set<string> {
  return new Set(memberships.map((m) => m.cwid));
}

/** Scope rows to Meyer Cancer Center members for `--members-only`. Reuses the
 *  same award-number resolution `planRow` uses: only a UNIQUELY matched award
 *  number yields a cwid to check. A row with no resolved cwid (unmatched OR
 *  ambiguous) has no identity to confirm membership against, so it's skipped,
 *  not kept. */
export function filterMembersOnly(
  rows: readonly ImportRow[],
  awardIndex: Map<string, string | "ambiguous">,
  memberCwids: ReadonlySet<string>,
): { kept: ImportRow[]; skipped: number } {
  const kept: ImportRow[] = [];
  let skipped = 0;
  for (const row of rows) {
    const matched = awardIndex.get(normalizeAwardNumber(row.sourceAwardNumber));
    const grantCwid = matched && matched !== "ambiguous" ? matched : null;
    if (grantCwid && memberCwids.has(grantCwid)) {
      kept.push(row);
    } else {
      skipped += 1;
    }
  }
  return { kept, skipped };
}

/** Compose `--members-only` scoping with `--limit`, in that exact order — the
 *  ordering guarantee `--members-only` depends on (see the module doc's flag
 *  description). Pulled out of `main()` as a pure function so this ordering
 *  is unit-testable without exercising the rest of the run (DB import,
 *  Bedrock calls, process.argv). */
export function scopeAndLimitRows(
  allRows: readonly ImportRow[],
  opts: Pick<ImportOptions, "membersOnly" | "limit">,
  awardIndex: Map<string, string | "ambiguous">,
  memberships: { cwid: string }[],
): { rows: ImportRow[]; scopedCount: number; skipped: number } {
  let scopedRows: ImportRow[] = [...allRows];
  let skipped = 0;
  if (opts.membersOnly) {
    const memberCwids = buildMembershipExistenceSet(memberships);
    const result = filterMembersOnly(allRows, awardIndex, memberCwids);
    scopedRows = result.kept;
    skipped = result.skipped;
  }
  const rows = opts.limit != null ? scopedRows.slice(0, opts.limit) : scopedRows;
  return { rows, scopedCount: scopedRows.length, skipped };
}

/** Run `fn` over `items` with at most `limit` in flight at once. No new
 *  dependency — a small promise pool is a few lines; this batch has hundreds
 *  of Bedrock calls, serial would take far too long. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export type RowPlan = {
  row: ImportRow;
  grantCwid: string | null;
  /** One allocation, always summing to 100% — a `programCode: null` row is an
   *  explicit, visible gap, never omitted (omitting would silently break the
   *  "allocations sum to 100% of the award" invariant downstream). `source`
   *  is always `"membership"` — program assignment never comes from a model
   *  guess, so there is no other literal it could ever be. */
  allocation: { programCode: string | null; source: "membership" };
  cancerRelevantPercent: number | null;
  cancerRelevantRationale: string | null;
  /** `rule` = MCC's rubric decided it with no model call (`cancerRelevanceRule`). */
  cancerRelevantPercentSource: "llm" | "rule";
  /** Written with the percent; all null when inference failed. */
  provenance: {
    cancerRelevantModel: string | null;
    cancerRelevantPromptHash: string | null;
    cancerRelevantInputHash: string | null;
    cancerRelevantInferredAt: Date | null;
  };
  /** Deterministic (DT2A rule #4) -- never a model guess, never overridable,
   *  so unlike cancerRelevantPercent it always overwrites on a re-run. */
  isPeerReviewed: boolean;
};

const NCI_RATIONALE = "NCI award: 100% under MCC's rubric.";
const LYNCH_RATIONALE = "Lynch syndrome: 100% under MCC's rubric.";

/** MCC's rubric (10-01) cases that are ALWAYS 100% — decided here, before any
 *  Bedrock call (deterministic, like `cancer-center-peer-review.ts`). NCI =
 *  a CA infix on either award number, or a funding source naming the National
 *  Cancer Institute (a flow-through row may carry a non-NIH number). */
export function cancerRelevanceRule(
  row: Pick<ImportRow, "sourceAwardNumber" | "projectNumber" | "specificFundingSource" | "projectTitle">,
  text: { abstract: string | null; phrText: string | null },
): { model: "rule:nci" | "rule:lynch"; rationale: string } | null {
  if (
    parseNihAward(row.sourceAwardNumber).nihIc === "NCI" ||
    parseNihAward(row.projectNumber).nihIc === "NCI" ||
    /national cancer institute/i.test(row.specificFundingSource)
  ) {
    return { model: "rule:nci", rationale: NCI_RATIONALE };
  }
  if (/\blynch syndrome\b/i.test([row.projectTitle, text.abstract, text.phrText].join(" "))) {
    return { model: "rule:lynch", rationale: LYNCH_RATIONALE };
  }
  return null;
}

/** Decide one row's plan: resolve the program via Grant→CenterMembership only
 *  (never a model guess), and independently decide the cancer-relevant
 *  percent — MCC's rule when one applies, else Bedrock. Never throws — a
 *  Bedrock failure leaves the percent/rationale null (see
 *  `inferCancerFundingJudgments`'s own contract). */
export async function planRow(
  row: ImportRow,
  awardIndex: Map<string, string | "ambiguous">,
  membershipIndex: Map<string, string>,
  textIndex: Map<string, { abstract: string | null; phrText: string | null }> = new Map(),
): Promise<RowPlan> {
  const matched = awardIndex.get(normalizeAwardNumber(row.sourceAwardNumber));
  const grantCwid = matched && matched !== "ambiguous" ? matched : null;
  const membershipProgram = grantCwid ? (membershipIndex.get(grantCwid) ?? null) : null;
  const text =
    textIndex.get(normalizeAwardNumber(row.sourceAwardNumber)) ??
    textIndex.get(normalizeAwardNumber(row.projectNumber)) ?? { abstract: null, phrText: null };

  const allocation: RowPlan["allocation"] = { programCode: membershipProgram, source: "membership" };
  const base = {
    row,
    grantCwid,
    allocation,
    isPeerReviewed: isPeerReviewedFundingSource(row.specificFundingSource, row.nihAward),
  };

  const rule = cancerRelevanceRule(row, text);
  if (rule) {
    return {
      ...base,
      cancerRelevantPercent: 100,
      cancerRelevantRationale: rule.rationale,
      cancerRelevantPercentSource: "rule",
      provenance: {
        cancerRelevantModel: rule.model,
        cancerRelevantPromptHash: null,
        cancerRelevantInputHash: null,
        cancerRelevantInferredAt: new Date(),
      },
    };
  }

  const inference = await inferCancerFundingJudgments({
    projectTitle: row.projectTitle,
    specificFundingSource: row.specificFundingSource,
    nihActivityCode: row.nihActivityCode,
    abstract: text.abstract,
    phrText: text.phrText,
    pi: row.pi,
  });

  return {
    ...base,
    cancerRelevantPercent: inference?.cancerRelevantPercent ?? null,
    cancerRelevantRationale: inference?.cancerRelevantRationale ?? null,
    cancerRelevantPercentSource: "llm",
    provenance: {
      cancerRelevantModel: inference?.cancerRelevantModel ?? null,
      cancerRelevantPromptHash: inference?.cancerRelevantPromptHash ?? null,
      cancerRelevantInputHash: inference?.cancerRelevantInputHash ?? null,
      cancerRelevantInferredAt: inference?.cancerRelevantInferredAt ?? null,
    },
  };
}

export type ApplyCounts = {
  created: number;
  updated: number;
  membershipResolved: number;
  unresolvedProgram: number;
  percentSkippedHuman: number;
  /** A re-run's Bedrock call failed this cycle, but a prior cycle's value
   *  survived untouched — not a human override, just nothing new to write. */
  percentSkippedInferenceFailed: number;
  allocationsSkippedHuman: number;
  /** Rows given a prior cycle's reviewer percent (CARRY-FORWARD). */
  percentCarriedHuman: number;
};

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

/** Apply one row's plan: create the award fresh, or update an existing cycle
 *  row without clobbering a human override (see the module doc's NON-CLOBBER
 *  section). `--dry-run` reports the decision and writes nothing. */
export async function applyPlan(
  db: Nci2aImportDb,
  plan: RowPlan,
  opts: ImportOptions,
  counts: ApplyCounts,
  carried: number | null = null,
): Promise<void> {
  const { row, allocation } = plan;
  // A carried reviewer percent wins; the model's value still lands in *Ai.
  const percentData = {
    cancerRelevantPercent: carried ?? plan.cancerRelevantPercent,
    cancerRelevantPercentSource: carried != null ? "human" : plan.cancerRelevantPercentSource,
    cancerRelevantPercentAi: plan.cancerRelevantPercent,
    cancerRelevantRationale: plan.cancerRelevantRationale,
    ...plan.provenance,
  };
  if (allocation.programCode) counts.membershipResolved += 1;
  else counts.unresolvedProgram += 1;

  const existing = await db.cancerCenterFundingAward.findUnique({
    where: {
      centerCode_reportingCycle_institutionNumber: {
        centerCode: CENTER_CODE,
        reportingCycle: row.reportingCycle,
        institutionNumber: row.institutionNumber,
      },
    },
    include: { allocations: { select: { source: true } } },
  });

  const awardScalars = {
    sourceAwardNumber: row.sourceAwardNumber,
    grantCwid: plan.grantCwid,
    pi: row.pi,
    specificFundingSource: row.specificFundingSource,
    projectNumber: row.projectNumber,
    projectTitle: row.projectTitle,
    projectStartDate: new Date(`${row.projectStartDate}T00:00:00Z`),
    projectEndDate: new Date(`${row.projectEndDate}T00:00:00Z`),
    annualProjectDirectCosts: row.annualProjectDirectCosts,
    isPeerReviewed: plan.isPeerReviewed,
  };

  if (!existing) {
    if (opts.dryRun) {
      log(`  [dry-run] create institutionNumber=${row.institutionNumber} program=${allocation.programCode ?? "—"}(${allocation.source})${carried != null ? ` [percent carried: ${carried}]` : ""}`);
    } else {
      await db.cancerCenterFundingAward.create({
        data: {
          centerCode: CENTER_CODE,
          reportingCycle: row.reportingCycle,
          institutionNumber: row.institutionNumber,
          ...awardScalars,
          ...percentData,
          allocations: {
            create: [{ centerCode: CENTER_CODE, programCode: allocation.programCode, programPercent: 100, source: allocation.source }],
          },
        },
      });
    }
    counts.created += 1;
    if (carried != null) counts.percentCarriedHuman += 1;
    return;
  }

  // NOT just "isn't human-sourced" — a re-run whose Bedrock call fails THIS
  // cycle (plan.cancerRelevantPercent === null) must not erase a real value a
  // PRIOR successful cycle already wrote. Only overwrite when the new plan
  // actually produced a value, or there was nothing to lose in the first
  // place (existing is also null). Without this, a transient Bedrock timeout
  // on a re-run reverts an already-inferred row back to "not yet inferred".
  const notHuman = existing.cancerRelevantPercentSource !== "human";
  const hasNewValueOrNothingToLose =
    carried != null || plan.cancerRelevantPercent !== null || existing.cancerRelevantPercent == null;
  const touchPercent = notHuman && hasNewValueOrNothingToLose;
  if (!touchPercent) {
    if (!notHuman) counts.percentSkippedHuman += 1;
    else counts.percentSkippedInferenceFailed += 1;
  }

  const anyHumanAllocation = existing.allocations.some((a) => a.source === "human");
  if (anyHumanAllocation) counts.allocationsSkippedHuman += 1;

  if (opts.dryRun) {
    log(
      `  [dry-run] update institutionNumber=${row.institutionNumber}` +
        `${touchPercent ? "" : notHuman ? " [percent skipped: inference failed, keeping prior value]" : " [percent skipped: human override]"}` +
        `${anyHumanAllocation ? " [allocations skipped: human override]" : ""}`,
    );
    counts.updated += 1;
    return;
  }

  await db.cancerCenterFundingAward.update({
    where: { id: existing.id },
    data: {
      ...awardScalars,
      ...(touchPercent ? percentData : {}),
      ...(anyHumanAllocation
        ? {}
        : {
            allocations: {
              deleteMany: {},
              create: [{ centerCode: CENTER_CODE, programCode: allocation.programCode, programPercent: 100, source: allocation.source }],
            },
          }),
    },
  });
  counts.updated += 1;
  if (touchPercent && carried != null) counts.percentCarriedHuman += 1;
}

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  log(
    `NCI Table 2A import${opts.dryRun ? " [DRY RUN — no writes]" : ""}${opts.membersOnly ? " [members-only]" : ""}` +
      `${opts.limit != null ? ` [limit=${opts.limit}]` : ""} [concurrency=${opts.concurrency}]\n  source: ${opts.file}`,
  );

  const allRows = loadImportRows(opts.file);
  log(`Loaded ${allRows.length} row(s).`);

  // Imported lazily so the structural Nci2aImportDb type stays the contract and
  // the unit tests never load the real client. Fetched BEFORE --limit is
  // applied — --members-only (and the awardIndex it needs) must see every row.
  const { db } = await import("../../lib/db");
  const w = db.write as unknown as Nci2aImportDb;

  const [grants, memberships] = await Promise.all([
    w.grant.findMany({
      where: { awardNumber: { not: null } },
      select: { awardNumber: true, cwid: true, abstract: true, phrText: true },
    }),
    w.centerMembership.findMany({ where: { centerCode: CENTER_CODE }, select: { cwid: true, programCode: true } }),
  ]);
  const awardIndex = buildAwardNumberIndex(grants);
  const membershipIndex = buildMembershipIndex(memberships);
  const textIndex = buildGrantTextIndex(grants);
  log(`Indexed ${grants.length} grant award numbers, ${memberships.length} Meyer memberships.`);

  const { rows, scopedCount, skipped } = scopeAndLimitRows(allRows, opts, awardIndex, memberships);
  if (opts.membersOnly) {
    log(
      `--members-only: kept ${scopedCount}/${allRows.length} row(s); skipped ${skipped} ` +
        `(not a Meyer member, including rows whose award number didn't resolve to any cwid at all).`,
    );
  }
  if (opts.limit != null) log(`Processing first ${rows.length} of ${scopedCount} row(s).`);

  log(`Planning ${rows.length} row(s) (Bedrock calls, concurrency=${opts.concurrency})...`);
  const plans = await mapWithConcurrency(rows, opts.concurrency, (row) =>
    planRow(row, awardIndex, membershipIndex, textIndex),
  );

  const priorHuman = await w.cancerCenterFundingAward.findMany({
    where: { centerCode: CENTER_CODE, cancerRelevantPercentSource: "human" },
    select: { reportingCycle: true, institutionNumber: true, projectEndDate: true, cancerRelevantPercent: true },
  });
  const counts = emptyCounts();
  for (const plan of plans) {
    await applyPlan(w, plan, opts, counts, carriedHumanPercent(plan.row, priorHuman));
  }

  const ruleRows = plans.filter((p) => p.cancerRelevantPercentSource === "rule").length;
  const notInferred = plans.filter((p) => p.cancerRelevantPercent === null).length;
  log(
    `\nDone${opts.dryRun ? " (dry run)" : ""}. rule=${ruleRows} not-inferred=${notInferred}. created=${counts.created}, updated=${counts.updated}, ` +
      `program: membership=${counts.membershipResolved} unresolved=${counts.unresolvedProgram}, ` +
      `skipped-for-human-override: percent=${counts.percentSkippedHuman} allocations=${counts.allocationsSkippedHuman}, ` +
      `percent-skipped-failed-retry=${counts.percentSkippedInferenceFailed}, ` +
      `percent-carried-from-prior-cycle=${counts.percentCarriedHuman}.`,
  );

  await db.write.$disconnect();
};

// Run only when invoked directly (not when imported by the unit test).
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
