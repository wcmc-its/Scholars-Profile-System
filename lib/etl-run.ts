import { db } from "@/lib/db";

/**
 * Record an `etl_run` row around a step's main() — the audit-table contract
 * the `etl:freshness` heartbeat reads (docs/etl-reliability-audit-2026-07-02.md,
 * PR-4). Most ETL modules inline this create/update pattern themselves; this
 * helper exists for the steps that predate the etl_run table (search:index,
 * revalidate, the weekly grant enrichers, ...) so they become
 * freshness-trackable without restructuring their mains.
 *
 * The wrapped fn's rejection is re-thrown after the 'failed' row is written,
 * so existing `.catch(...) -> process.exit(1)` entrypoints keep their
 * non-zero-exit semantics (which drive the Step Functions Catch -> SNS path).
 * A fn that resolves to a number has it recorded as rowsProcessed.
 */
export async function withEtlRun(
  source: string,
  fn: () => Promise<number | void>,
): Promise<void> {
  const run = await db.write.etlRun.create({
    data: { source, status: "running" },
  });
  try {
    const rows = await fn();
    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: typeof rows === "number" ? rows : undefined,
      },
    });
  } catch (err) {
    // Guard the failure-status write: if it throws too (commonly the SAME DB
    // outage that felled `fn`), it must not replace `err` — that would mask the
    // real failure cause AND, because the update never lands, silently strand
    // the row as 'running'. Log the strand loudly and always re-throw the
    // ORIGINAL error so the `.catch(...) -> process.exit(1)` entrypoints and the
    // Step Functions Catch -> SNS path still fire on the true cause.
    try {
      await db.write.etlRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      });
    } catch (statusErr) {
      console.error(
        `[etl-run] could not mark run ${run.id} (${source}) as failed; ` +
          `row may be stranded as 'running'`,
        statusErr,
      );
    }
    throw err;
  }
}
