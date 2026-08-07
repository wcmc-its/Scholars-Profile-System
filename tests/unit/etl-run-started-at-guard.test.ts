/**
 * Guardrail — an `etl_run` row must carry a real `startedAt`.
 *
 * `EtlRun.startedAt` is `DateTime @default(now())`, and that default is
 * evaluated by the DATABASE at INSERT time. Two write patterns exist across
 * `etl/`, and only one of them survives that default:
 *
 *   - `withEtlRun` (lib/etl-run.ts) opens the row `status: "running"` when the
 *     step begins and updates it at the end. `startedAt` defaults at the moment
 *     the run genuinely started, so it is correct by construction.
 *   - Ten steps instead write ONE terminal row at the end, from a private
 *     `recordRun` helper. Those omitted `startedAt` entirely, so it defaulted to
 *     the same instant as their explicit `completedAt`. Every such run recorded
 *     a zero-length duration — and a NEGATIVE one whenever the database clock
 *     led Node's, since the two endpoints came from different clocks.
 *
 * Nothing caught it, because nothing read the field: `etl_run` was consumed for
 * recency and status only. The /edit/etl-status board now shows a run duration,
 * which is what turned an unread column into a visible lie — thirty green rows
 * and ten of them claiming to have finished instantly.
 *
 * The fix is `startedAt: processStartedAt` from `lib/etl-run.ts`. This test
 * exists because the fix is per-file and invisible: a new terminal-row writer
 * that forgets it is green in every other test in this repo, and only shows up
 * as one more "not recorded" cell nobody is watching for.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ETL = path.resolve(__dirname, "../../etl");

/** Every `etl/<step>/index.ts` — the shape every ETL entrypoint uses. */
const entrypoints = readdirSync(ETL, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(ETL, e.name, "index.ts"))
  .filter((f) => {
    try {
      readFileSync(f);
      return true;
    } catch {
      return false;
    }
  });

/**
 * The argument text of each `etlRun.create(...)`, brace-matched rather than
 * regex-terminated. A regex ending on an indentation guess reads straight past
 * the end of a short create and swallows whatever follows: `etl/coi/index.ts`
 * opens its row correctly on one line, and a `\n  });` matcher captured the
 * *later* failure-path update with it and convicted an innocent file.
 */
const createArgs = (src: string): string[] => {
  const blocks: string[] = [];
  const NEEDLE = "etlRun.create(";
  for (let i = src.indexOf(NEEDLE); i !== -1; i = src.indexOf(NEEDLE, i + 1)) {
    let depth = 0;
    for (let j = i + NEEDLE.length - 1; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) {
        blocks.push(src.slice(i, j + 1));
        break;
      }
    }
  }
  return blocks;
};

/**
 * A terminal-row writer is one that passes `completedAt` INTO the create — it is
 * declaring the run finished in the same statement that opens the record.
 * `withEtlRun`'s create has no `completedAt` (it lands on the later update), so
 * this matches exactly the population at risk and skips the correct pattern.
 */
const createBlocks = (src: string): string[] =>
  createArgs(src).filter((block) => block.includes("completedAt:"));

describe("etl_run startedAt guard", () => {
  it("finds the terminal-row writers it is meant to police", () => {
    // If this drops to zero the matcher broke and every assertion below became
    // vacuous — the classic way a guardrail retires itself silently.
    const writers = entrypoints.filter((f) => createBlocks(readFileSync(f, "utf-8")).length > 0);
    expect(writers.length).toBeGreaterThanOrEqual(12);
  });

  it("never lets a terminal etl_run row fall back to the database's now()", () => {
    const offenders: string[] = [];
    for (const file of entrypoints) {
      const src = readFileSync(file, "utf-8");
      for (const block of createBlocks(src)) {
        if (!/startedAt:/.test(block)) {
          offenders.push(path.relative(ETL, file));
        }
      }
    }
    // If this fails on a step you just added: pass `startedAt: processStartedAt`
    // from `@/lib/etl-run`, or move the step onto `withEtlRun`. Do not widen the
    // matcher — an unmeasurable run reads as an instant one on the status board.
    expect(offenders).toEqual([]);
  });
});
