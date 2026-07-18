/**
 * Honors seed IMPORT — #1761. Run via `npm run etl:honors:import-seed`.
 *
 * One-time (re-runnable) backfill of the `honor` table from a curated JSON held
 * OUTSIDE the repo — the file pairs named faculty with honors and never lands
 * in the repo, a fixture, or an issue thread (see #1761 "Data handling").
 *
 *   1. Read + validate the JSON array at HONORS_SEED_PATH (etl/honors/seed-rows.ts).
 *      Any validation error aborts before the first write — fix the file.
 *   2. FK-gate: rows whose cwid has no `Scholar` are skipped + counted (misses
 *      are cheap; a mismatched write is not). `Honor.cwid` is NOT NULL + FK.
 *   3. Idempotent upsert keyed on (cwid, organization, name) — the key excludes
 *      `year` deliberately so a year correction updates in place (#1761).
 *      Status obeys `statusOnUpdate`: only a still-`pending` row accepts the
 *      file's status — a curator's queue decision survives any re-run.
 *   4. Record the run in `etl_run` under source="HonorsSeed-Import".
 *
 * Operator-run in-VPC (`run-task` on the env's sps-etl task), NOT part of
 * etl/orchestrate.ts — the seed changes only when the curated file does.
 *
 * Env:  HONORS_SEED_PATH   absolute path to the seed JSON (required — no
 *                          in-repo default on purpose)
 * Usage:
 *   npm run etl:honors:import-seed -- --dry-run   # parse + validate + counts only
 *   npm run etl:honors:import-seed
 */
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { parseSeedRows, statusOnUpdate } from "./seed-rows";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const start = Date.now();
  const path = process.env.HONORS_SEED_PATH;
  if (!path) throw new Error("HONORS_SEED_PATH is required (the seed file lives outside the repo)");

  const { rows, errors } = parseSeedRows(JSON.parse(readFileSync(path, "utf8")));
  if (errors.length) {
    for (const e of errors) console.error(e);
    throw new Error(`${errors.length} invalid row(s) — nothing imported; fix the file`);
  }
  const byStatus = rows.reduce<Record<string, number>>(
    (m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m),
    {},
  );
  console.log(`Parsed ${rows.length} rows: ${JSON.stringify(byStatus)}`);

  const cwids = [...new Set(rows.map((r) => r.cwid))];
  const present = new Set(
    (
      await db.read.scholar.findMany({ where: { cwid: { in: cwids } }, select: { cwid: true } })
    ).map((s) => s.cwid),
  );
  const missing = cwids.filter((c) => !present.has(c));
  const importable = rows.filter((r) => present.has(r.cwid));
  console.log(
    `FK gate: ${importable.length}/${rows.length} rows importable; ` +
      `${missing.length} cwid(s) absent from scholar: ${missing.join(", ") || "—"}`,
  );

  if (dryRun) {
    console.log("DRY-RUN: parsed + validated only, no DB writes.");
    return;
  }

  const run = await db.write.etlRun.create({
    data: { source: "HonorsSeed-Import", status: "running" },
  });
  try {
    let created = 0;
    let updated = 0;
    let statusPreserved = 0;
    for (const r of importable) {
      const existing = await db.write.honor.findFirst({
        where: { cwid: r.cwid, organization: r.organization, name: r.name },
        select: { id: true, status: true },
      });
      if (!existing) {
        await db.write.honor.create({ data: r });
        created += 1;
      } else {
        const status = statusOnUpdate(existing.status, r.status);
        if (status !== r.status) statusPreserved += 1;
        await db.write.honor.update({
          where: { id: existing.id },
          data: {
            year: r.year,
            category: r.category,
            status,
            showOnProfile: r.showOnProfile,
            source: r.source,
            sourceRef: r.sourceRef,
            enteredByCwid: r.enteredByCwid,
          },
        });
        updated += 1;
      }
    }
    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: created + updated },
    });
    console.log(
      `Import complete in ${Math.round((Date.now() - start) / 1000)}s: ` +
        `${created} created, ${updated} updated ` +
        `(${statusPreserved} kept an existing curator-decided status), ` +
        `${rows.length - importable.length} FK-skipped.`,
    );
  } catch (err) {
    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
