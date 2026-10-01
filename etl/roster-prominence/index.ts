/**
 * Roster prominence ETL (#2596) — `npm run etl:roster-prominence`.
 *
 * Materializes `Scholar.rosterProminence` + `Scholar.rosterLeadershipTier` from
 * `computeProminence(client, "all")` (lib/api/prominence.ts). The formula and
 * weights stay there; this step is only the writer, so the stored column and
 * every in-app caller run the same code.
 *
 * One run:
 *   1. Score every non-deleted scholar (five whole-table reads).
 *   2. Read what `Scholar` holds now.
 *   3. Volume guards (`plan.ts`) — refuse a thin result BEFORE any write, so a
 *      short read can't scramble the roster sort order.
 *   4. Write only the rows that changed (deleted scholars are cleared to NULL),
 *      in one transaction, via raw UPDATE so `updated_at` is untouched — it
 *      drives the sitemap's lastModified, and a re-score is not a profile edit.
 *   5. `etl_run` source "RosterProminence" (freshness: nightly).
 *
 * Cadence: nightly (cdk/lib/etl-stack.ts RosterProminenceNightly), after Ed,
 * InfoEd and Dynamodb have refreshed its inputs. SPS-DB only.
 */
import { db } from "@/lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { computeProminence } from "@/lib/api/prominence";
import { Prisma } from "@/lib/generated/prisma/client";
import { assertRosterProminenceVolume, planRosterProminence, type ProminenceUpdate } from "./plan";

const CHUNK = 500;

function updateChunk(rows: readonly ProminenceUpdate[]): Prisma.Sql {
  const prom = rows.map((r) => Prisma.sql`WHEN ${r.cwid} THEN ${r.rosterProminence}`);
  const tier = rows.map((r) => Prisma.sql`WHEN ${r.cwid} THEN ${r.rosterLeadershipTier}`);
  return Prisma.sql`
    UPDATE scholar
    SET roster_prominence = CASE cwid ${Prisma.join(prom, " ")} END,
        roster_leadership_tier = CASE cwid ${Prisma.join(tier, " ")} END
    WHERE cwid IN (${Prisma.join(rows.map((r) => r.cwid))})
  `;
}

async function main(): Promise<number> {
  const computed = await computeProminence(db.write, "all");
  const stored = await db.write.scholar.findMany({
    select: { cwid: true, rosterProminence: true, rosterLeadershipTier: true },
  });

  assertRosterProminenceVolume(stored, computed);
  const updates = planRosterProminence(stored, computed);

  await db.write.$transaction(
    async (tx) => {
      for (let i = 0; i < updates.length; i += CHUNK) {
        await tx.$executeRaw(updateChunk(updates.slice(i, i + CHUNK)));
      }
    },
    { timeout: 120_000 },
  );

  console.log(
    `[RosterProminence] ${JSON.stringify({
      event: "roster_prominence_complete",
      scored: computed.size,
      scholarRows: stored.length,
      updated: updates.length,
    })}`,
  );
  return computed.size;
}

withEtlRun("RosterProminence", main)
  .catch((err) => {
    console.error("[RosterProminence] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
