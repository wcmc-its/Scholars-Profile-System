/**
 * COI-gap DIAGNOSTIC export (internal analysis tool — read-only, writes nothing).
 *
 * Re-runs the matcher across scholars with `includeSuppressed` and emits one
 * JSONL row per extracted entity — surfaced AND suppressed — with the full
 * diagnostics the `coi_gap_candidate` table discards (nearest disclosure, fuzzy
 * score, tier reason, failure-mode guess, token diff vs the nearest disclosure).
 * Use it to measure the real near-miss distribution and the predictable
 * normalization gaps (corp suffixes beyond the strip-list, proper-noun casing,
 * word order) before tuning generation/matching or persisting the diagnostics.
 *
 * Internal output → the numeric score is intentionally present (this is not the
 * scholar-facing surface, which stays tier-only).
 *
 * JSONL → an `--out` file (default ./coi-gap-diagnostic.jsonl); a human summary →
 * the console. A file, not stdout, so the JSONL is never polluted by npm's run
 * banner. Use `--out -` to force stdout. So:
 *   npm run etl:coi-gap:diagnose -- --sample 200                  # → ./coi-gap-diagnostic.jsonl
 *   npm run etl:coi-gap:diagnose -- --cwid abc1001 --out one.jsonl
 *   npm run etl:coi-gap:diagnose -- --all --threshold 0.5 --out all.jsonl  # what-if
 */
import { createWriteStream } from "node:fs";

import { db } from "../../lib/db";
import { loadCoiInputs } from "@/lib/coi-gap/compute";
import { diagnoseScholar, summarize, type DiagnosticRow } from "@/lib/coi-gap/diagnose";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ALL = process.argv.includes("--all");
const CWID = arg("cwid");
const SAMPLE = Number(arg("sample") ?? "200");
const THRESHOLD = arg("threshold") ? Number(arg("threshold")) : undefined;
const OUT = arg("out") ?? "coi-gap-diagnostic.jsonl";
const CONCURRENCY = 10;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function targetCwids(): Promise<string[]> {
  if (CWID) return [CWID];
  const all = await db.read.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: { cwid: true },
    orderBy: { cwid: "asc" },
  });
  const cwids = all.map((s) => s.cwid);
  return ALL ? cwids : cwids.slice(0, SAMPLE);
}

async function main() {
  const cwids = await targetCwids();
  const toStdout = OUT === "-";
  const out = toStdout ? process.stdout : createWriteStream(OUT, { encoding: "utf8" });
  process.stderr.write(
    `COI-Gap diagnose: ${cwids.length} scholars${THRESHOLD != null ? ` (threshold=${THRESHOLD})` : ""} → ${
      toStdout ? "stdout" : OUT
    }…\n`,
  );

  const rows: DiagnosticRow[] = [];
  let scanned = 0;
  async function one(cwid: string): Promise<void> {
    const inputs = await loadCoiInputs(cwid);
    scanned++;
    if (!inputs || inputs.statements.length === 0) return;
    const r = diagnoseScholar({
      cwid,
      scholar: inputs.scholar,
      disclosed: inputs.disclosed,
      statements: inputs.statements,
      nearDisclosedThreshold: THRESHOLD,
    });
    for (const row of r) out.write(`${JSON.stringify(row)}\n`);
    rows.push(...r);
    if (scanned % 200 === 0) process.stderr.write(`  …${scanned}/${cwids.length}\n`);
  }
  for (const batch of chunks(cwids, CONCURRENCY)) {
    await Promise.all(batch.map(one));
  }
  if (!toStdout) await new Promise<void>((res) => (out as ReturnType<typeof createWriteStream>).end(res));

  const sum = summarize(rows, THRESHOLD ?? 0.6);
  process.stderr.write(
    `\n=== summary (${rows.length} rows → ${toStdout ? "stdout" : OUT}) ===\n${JSON.stringify(sum, null, 2)}\n`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.read.$disconnect();
  });
