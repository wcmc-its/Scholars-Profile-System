/**
 * Report 26's scoped row set — rebuilds `translational_portfolio_author_pub`
 * (plans/2026-11-28-report-26-precompute-plan.md in the Projects folder).
 *
 * One row per confirmed authorship of a research article, every scholar,
 * every year: the predicates report 26 adds to report 8's `scopeSql` that do
 * not depend on who the scholar is. Status, unit, role, institution and
 * centers stay live: readers join `scholar`. An author listed twice on one
 * paper is one row, first / last if any listing is.
 *
 * One transaction: DELETE, then INSERT … SELECT server side, so readers see
 * last night's rows until the commit. Refuses to commit (rolls back) a fill
 * that is empty or under `MIN_KEEP` of the current rows: a degraded read must
 * never wipe the table. `--allow-shrink` overrides for a deliberate drop.
 *
 * Runs nightly as `TranslationalPortfolioNightly` (cdk/lib/etl-stack.ts),
 * after Reciter (authorships) and Dynamodb (stages).
 *
 * Usage: npm run etl:translational-portfolio [-- --allow-shrink]
 */
import { db, disconnect } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { PORTFOLIO_ARTICLE_TYPES, stageCase } from "@/lib/edit/translational-stage-sql";
import { Prisma } from "@/lib/generated/prisma/client";

/** A new fill must keep at least this share of the current rows. */
export const MIN_KEEP = 0.5;

export const FILL_SQL = Prisma.sql`
  INSERT INTO translational_portfolio_author_pub (cwid, pmid, year, stage, is_first, is_last)
  SELECT pa.cwid, pa.pmid, p.year, ${stageCase()}, MAX(pa.is_first), MAX(pa.is_last)
    FROM publication_author pa
    JOIN publication p ON p.pmid = pa.pmid
   WHERE pa.is_confirmed = 1
     AND pa.cwid IS NOT NULL
     AND p.year IS NOT NULL
     AND p.publication_type IN (${Prisma.join([...PORTFOLIO_ARTICLE_TYPES])})
   GROUP BY pa.cwid, pa.pmid, p.year, p.translational_stage, p.translational_stage_confidence`;

/** Why a fill must not commit, or null. */
export function shrinkRefusal(current: number, next: number, allowShrink: boolean): string | null {
  if (allowShrink) return null;
  if (next === 0) return "the fill selected 0 rows; refusing to empty translational_portfolio_author_pub (pass --allow-shrink to clear it)";
  if (next < current * MIN_KEEP)
    return `the fill selected ${next} rows, under ${MIN_KEEP * 100}% of the current ${current}; refusing (pass --allow-shrink if the drop is deliberate)`;
  return null;
}

type Tx = Pick<typeof db.write, "$queryRaw" | "$executeRaw">;

/** The rebuild inside one transaction; throws (rolling back) on a refused fill. */
export async function fill(tx: Tx, allowShrink: boolean): Promise<number> {
  const [{ n }] = await tx.$queryRaw<{ n: bigint | number }[]>`SELECT COUNT(*) AS n FROM translational_portfolio_author_pub`;
  const current = Number(n);
  await tx.$executeRaw`DELETE FROM translational_portfolio_author_pub`;
  const next = await tx.$executeRaw(FILL_SQL);
  const why = shrinkRefusal(current, next, allowShrink);
  if (why) throw new Error(why);
  console.log(`[translational-portfolio] ${current} → ${next} rows`);
  return next;
}

async function main(): Promise<number> {
  const allowShrink = process.argv.includes("--allow-shrink");
  return db.write.$transaction((tx) => fill(tx, allowShrink), { maxWait: 60_000, timeout: 10 * 60_000 });
}

if (process.env.NODE_ENV !== "test") {
  withEtlRun("TranslationalPortfolio", main)
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(disconnect);
}
