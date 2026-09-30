/**
 * NCI Table 2a: fill `cancer_center_funding_award.cancer_relevant_percent_ai`
 * for rows a reviewer saved BEFORE that column existed (2026-09-25, one-shot
 * per DB).
 *
 * The migration `20260925120000_cancer_funding_award_percent_ai` copies the
 * current percent into the new column only where `source = 'llm'`: a
 * human-sourced value is not what the model said. That leaves the AI value
 * NULL on every row a reviewer had already saved or accepted, and the OSRA
 * import never writes it on a human row. Those rows would then read
 * "Confirmed" even where the reviewer changed the value, and drop out of the
 * "X of Y AI-suggested percentages reviewed" progress count.
 *
 * The AI value for such a row is in the audit log: every percent save or
 * accept writes a `cancer_funding_override` row whose `before_values` holds
 * `cancerRelevantPercent`. The EARLIEST such row for an award is the value
 * before any human touched it, i.e. the import's LLM value. (An
 * allocations-only save has no `cancerRelevantPercent` key and is skipped; a
 * null before-value means the row was not inferred, so there is no AI value
 * and the row stays NULL.)
 *
 * Writes only `cancer_relevant_percent_ai`, only where it is still NULL and
 * the row is still `source = 'human'`. Idempotent; safe to repeat.
 *
 *   --dry-run   report intended changes; write nothing.
 *
 * DB user: reads `scholars_audit.manual_edit_audit`, which the `etl` MySQL
 * user has no grant on (see 2026-08-14-core-14-research-informatics-owners).
 * Run it with a DB user that can SELECT that table (the app user); a dry run
 * fails loudly with a SELECT-denied error otherwise, before anything is
 * written. Dry-run first, then live:
 *   npx tsx scripts/backfills/2026-09-25-nci-2a-ai-percent-from-audit.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Prisma } from "../../lib/generated/prisma/client";

export type HumanRowWithoutAi = { id: string; cancerRelevantPercent: number | null };

export type OverrideAuditRow = {
  targetEntityId: string;
  /** JSON column: arrives as a string or an already-parsed object. */
  beforeValues: unknown;
};

export type AiFill = { id: string; ai: number; current: number | null };

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * The AI value per award: the `cancerRelevantPercent` before-value of the
 * earliest override row that carries one. `auditRows` must be oldest first.
 */
export function planAiFills(
  rows: ReadonlyArray<HumanRowWithoutAi>,
  auditRows: ReadonlyArray<OverrideAuditRow>,
): AiFill[] {
  const firstBefore = new Map<string, unknown>();
  for (const r of auditRows) {
    if (firstBefore.has(r.targetEntityId)) continue;
    const before = asObject(r.beforeValues);
    if (before && "cancerRelevantPercent" in before) {
      firstBefore.set(r.targetEntityId, before.cancerRelevantPercent);
    }
  }
  const fills: AiFill[] = [];
  for (const row of rows) {
    const v = firstBefore.get(row.id);
    const ai = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(ai)) continue;
    fills.push({ id: row.id, ai, current: row.cancerRelevantPercent });
  }
  return fills;
}

/** The slice of the Prisma client this backfill uses (a fake in tests). */
export type AiBackfillDb = {
  cancerCenterFundingAward: {
    findMany(args: {
      where: { cancerRelevantPercentSource: "human"; cancerRelevantPercentAi: null };
      select: { id: true; cancerRelevantPercent: true };
    }): Promise<Array<{ id: string; cancerRelevantPercent: unknown }>>;
    updateMany(args: {
      where: { id: string; cancerRelevantPercentSource: "human"; cancerRelevantPercentAi: null };
      data: { cancerRelevantPercentAi: number };
    }): Promise<{ count: number }>;
  };
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
};

export type AiBackfillResult = {
  humanWithoutAi: number;
  fills: AiFill[];
  written: number;
  dryRun: boolean;
};

export async function runAiBackfill(
  client: AiBackfillDb,
  opts: { dryRun: boolean },
  log: (m: string) => void = console.log,
): Promise<AiBackfillResult> {
  const found = await client.cancerCenterFundingAward.findMany({
    where: { cancerRelevantPercentSource: "human", cancerRelevantPercentAi: null },
    select: { id: true, cancerRelevantPercent: true },
  });
  const rows: HumanRowWithoutAi[] = found.map((r) => ({
    id: r.id,
    cancerRelevantPercent: r.cancerRelevantPercent == null ? null : Number(r.cancerRelevantPercent),
  }));
  log(`Human-sourced rows with no AI value: ${rows.length}`);
  if (rows.length === 0) return { humanWithoutAi: 0, fills: [], written: 0, dryRun: opts.dryRun };

  const audit = await client.$queryRaw<
    Array<{ target_entity_id: string; before_values: unknown }>
  >(Prisma.sql`
    SELECT target_entity_id, before_values
      FROM scholars_audit.manual_edit_audit
     WHERE action = 'cancer_funding_override'
       AND target_entity_type = 'cancer_funding_award'
       AND target_entity_id IN (${Prisma.join(rows.map((r) => r.id))})
     ORDER BY ts ASC, id ASC`);
  const fills = planAiFills(
    rows,
    audit.map((a) => ({ targetEntityId: a.target_entity_id, beforeValues: a.before_values })),
  );
  const corrected = fills.filter((f) => f.current !== f.ai).length;
  log(
    `From the audit log: ${fills.length} AI values (${corrected} Corrected, ` +
      `${fills.length - corrected} Confirmed); ${rows.length - fills.length} left NULL.`,
  );

  let written = 0;
  for (const f of fills) {
    log(`  ${f.id}: AI ${f.ai}%, now ${f.current ?? "none"}%`);
    if (opts.dryRun) continue;
    const { count } = await client.cancerCenterFundingAward.updateMany({
      where: { id: f.id, cancerRelevantPercentSource: "human", cancerRelevantPercentAi: null },
      data: { cancerRelevantPercentAi: f.ai },
    });
    written += count;
  }
  log(`Done${opts.dryRun ? " (dry run, nothing written)" : ""}: ${written} rows written.`);
  return { humanWithoutAi: rows.length, fills, written, dryRun: opts.dryRun };
}

const main = async () => {
  const { db } = await import("../../lib/db");
  const dryRun = process.argv.slice(2).includes("--dry-run");
  // On the writer: no replica lag between the read and the guarded writes.
  await runAiBackfill(db.write as unknown as AiBackfillDb, { dryRun });
  await db.write.$disconnect();
};

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
