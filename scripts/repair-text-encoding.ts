/**
 * One-time repair of cp1252 mojibake and invisible junk in stored text
 * (`lib/text/repair-encoding.ts`). Reported 2026-07-30: the public profile
 * Overview rendered "Dr. Zarnegar[box]s primary clinical interests" because
 * `scholar.overview` holds U+0092 where a right single quote belonged.
 *
 * Dry-run by default — prints per-column counts and the first few repairs.
 * `--apply` writes. `--table=<name>` limits the pass to one table.
 *
 *   npx tsx scripts/repair-text-encoding.ts
 *   npx tsx scripts/repair-text-encoding.ts --apply
 *
 * Ingest boundaries are already repaired in code (etl/reciter, etl/infoed,
 * etl/reporter, etl/reporter-grants, etl/nsf, etl/tools, the two COI loaders,
 * and `sanitizeOverviewHtml`), so the ETL-owned columns below also self-heal on
 * their next run — this script only closes the gap sooner, and is the ONLY fix
 * for `scholar.overview`, which no nightly job rewrites.
 *
 * SQL is raw + column-name-interpolated: the identifiers are the literal table
 * below, never user input.
 */
import { db } from "@/lib/db";
import { hasEncodingDefect, repairEncoding } from "@/lib/text/repair-encoding";

/** [table, primary key, text column] — the columns that carried the defect on
 *  2026-07-30 (local scan; prod/staging counts differ for the ETL-fed ones). */
const TARGETS: [string, string, string][] = [
  ["scholar", "cwid", "overview"],
  ["publication", "pmid", "title"],
  ["publication", "pmid", "abstract"],
  ["publication_conflict_statement", "pmid", "statement_text"],
  ["coi_gap_candidate", "id", "source_sentence"],
  ["grant", "id", "title"],
  ["grant", "id", "abstract"],
  ["grant", "id", "award_number"],
  ["scholar_tool", "id", "tool_name"],
  ["scholar_tool", "id", "sample_context"],
  ["field_override", "id", "value"],
  ["overview_generation", "id", "text"],
];

/**
 * UTF-8 byte prefilter so the scan does not stream every abstract in the corpus
 * through node. Deliberately over-matches (HEX() has no byte separators, so a
 * pattern can straddle a boundary) — `hasEncodingDefect` is the real test.
 *   C2 80..9F = U+0080..009F   C2 AD = U+00AD        E2 80 8B = U+200B
 *   E2 81 A0  = U+2060         EF BB BF = U+FEFF     EF BF BD = U+FFFD
 *   single-byte C0 controls and DEL
 */
const HEX_PREFILTER =
  "C2(8[0-9A-F]|9[0-9A-F]|AD)|E2808B|E281A0|EFBBBF|EFBFBD|0[0-8]|0[BC]|0[EF]|1[0-9A-F]|7F";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const only = process.argv.find((a) => a.startsWith("--table="))?.slice("--table=".length);

  console.log(apply ? "MODE: APPLY (writes)" : "MODE: dry-run (no writes) — pass --apply to write");

  let totalFound = 0;
  let totalWritten = 0;

  for (const [table, pk, col] of TARGETS) {
    if (only && table !== only) continue;

    const rows = (await db.write.$queryRawUnsafe(
      `SELECT \`${pk}\` AS k, \`${col}\` AS v FROM \`${table}\`
       WHERE \`${col}\` IS NOT NULL AND HEX(\`${col}\`) REGEXP ?`,
      HEX_PREFILTER,
    )) as { k: string | number; v: string }[];

    const dirty = rows.filter((r) => hasEncodingDefect(String(r.v)));
    if (dirty.length === 0) {
      console.log(`  ${table}.${col}: clean`);
      continue;
    }
    totalFound += dirty.length;
    console.log(`  ${table}.${col}: ${dirty.length} row(s) to repair`);

    for (const r of dirty.slice(0, 3)) {
      const before = String(r.v);
      const i = [...before].findIndex((ch) => hasEncodingDefect(ch));
      const window = (s: string, at: number) =>
        JSON.stringify([...s].slice(Math.max(0, at - 30), at + 30).join(""));
      console.log(`      [${r.k}] ${window(before, i)}`);
      console.log(`        ->  ${window(repairEncoding(before), i)}`);
    }
    if (dirty.length > 3) console.log(`      … ${dirty.length - 3} more`);

    if (!apply) continue;
    for (const r of dirty) {
      await db.write.$executeRawUnsafe(
        `UPDATE \`${table}\` SET \`${col}\` = ? WHERE \`${pk}\` = ?`,
        repairEncoding(String(r.v)),
        r.k,
      );
      totalWritten += 1;
    }
    console.log(`      written: ${dirty.length}`);
  }

  console.log(
    `\nTOTAL: ${totalFound} row(s) with a defect; ${apply ? `${totalWritten} written` : "0 written (dry-run)"}`,
  );
  if (apply && totalWritten > 0) {
    console.log("NOTE: reindex OpenSearch so search sees the repaired text.");
  }
  await db.write.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await db.write.$disconnect();
  process.exit(1);
});
