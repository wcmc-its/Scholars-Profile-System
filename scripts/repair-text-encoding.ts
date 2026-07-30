/**
 * One-time repair of encoding damage in stored text (`lib/text/repair-encoding.ts`).
 * Reported 2026-07-30: the public profile Overview rendered "Dr. Zarnegar[box]s
 * primary clinical interests" because `scholar.overview` held U+0092 where a
 * right single quote belonged.
 *
 *   npx tsx scripts/repair-text-encoding.ts                     # dry-run
 *   npx tsx scripts/repair-text-encoding.ts --apply
 *   npx tsx scripts/repair-text-encoding.ts --double-encoding --apply
 *   npx tsx scripts/repair-text-encoding.ts --table=scholar
 *
 * Two passes, deliberately separate — see `lib/text/repair-encoding.ts`:
 *
 *   default            cp1252 mojibake + invisible junk. Safe; rows that are
 *                      double-encoded are HELD, never half-fixed.
 *   --double-encoding  the latin1/cp1252 round-trip. Opt-in, because the
 *                      signature can occur in genuine text (e.g. a Czech name).
 *
 * 🔴 **Columns are enumerated from `information_schema`, never hand-listed.**
 * The first version of this script carried a hand-kept list built from a LOCAL
 * scan, and local is not prod for any ETL-fed table: it missed 5 columns / 14
 * rows. Restricting that enumeration to the text types then missed the `json`
 * columns — including `scholar_family.exemplar_contexts`, which feeds the
 * people index's `methodContext` — for another 22 rows. Both layers only
 * surfaced after the previous pass had reported "clean".
 *
 * A repaired DB is still not a repaired index: rerun `npm run search:index:*`
 * and verify by reading `_source` back, not by re-scanning Aurora.
 *
 * Identifiers are interpolated into raw SQL. They come from `information_schema`
 * for this connection's own schema, never from user input.
 */
import { db } from "@/lib/db";
import {
  hasDoubleEncoding,
  hasEncodingDefect,
  repairDoubleEncoding,
  repairEncoding,
} from "@/lib/text/repair-encoding";

const TEXT_TYPES = ["char", "varchar", "text", "tinytext", "mediumtext", "longtext"];

/**
 * UTF-8 byte prefilter so the scan does not stream every abstract in the corpus
 * through node. Deliberately over-matches (HEX() has no byte separators, so a
 * pattern can straddle a boundary) — the code-point test is the real check.
 *   C2 80..9F = U+0080..009F   C2 AD = U+00AD        E2 80 8B = U+200B
 *   E2 81 A0  = U+2060         EF BB BF = U+FEFF     EF BF BD = U+FFFD
 *   single-byte C0 controls and DEL
 */
const HEX_PREFILTER =
  "C2(8[0-9A-F]|9[0-9A-F]|AD)|E2808B|E281A0|EFBBBF|EFBFBD|0[0-8]|0[BC]|0[EF]|1[0-9A-F]|7F";

/** Double-encoding shows as a UTF-8 lead byte U+00C2-U+00F4, i.e. C3 82..C3 B4. */
const HEX_PREFILTER_DOUBLE = "C3(8[2-9A-F]|9[0-9A-F]|A[0-9A-F]|B[0-4])";

type Column = { table: string; column: string; pk: string | null; isJson: boolean };

async function targets(schema: string): Promise<Column[]> {
  const rows = (await db.write.$queryRawUnsafe(
    `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.DATA_TYPE AS d,
            (SELECT k.COLUMN_NAME FROM information_schema.COLUMNS k
              WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
                AND k.COLUMN_KEY = 'PRI' LIMIT 1) AS pk
       FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = ?
        AND c.DATA_TYPE IN (${[...TEXT_TYPES, "json"].map(() => "?").join(",")})
      ORDER BY c.TABLE_NAME, c.COLUMN_NAME`,
    schema,
    ...TEXT_TYPES,
    "json",
  )) as { t: string; c: string; d: string; pk: string | null }[];
  return rows.map((r) => ({ table: r.t, column: r.c, pk: r.pk, isJson: r.d === "json" }));
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const doubleMode = process.argv.includes("--double-encoding");
  const only = process.argv.find((a) => a.startsWith("--table="))?.slice("--table=".length);

  const repair = doubleMode ? repairDoubleEncoding : repairEncoding;
  const detect = doubleMode ? hasDoubleEncoding : hasEncodingDefect;
  const prefilter = doubleMode ? HEX_PREFILTER_DOUBLE : HEX_PREFILTER;

  const [{ s: schema }] = (await db.write.$queryRawUnsafe("SELECT DATABASE() AS s")) as {
    s: string;
  }[];

  console.log(`schema: ${schema}`);
  console.log(`pass:   ${doubleMode ? "DOUBLE-ENCODING round-trip" : "cp1252 + invisibles"}`);
  console.log(apply ? "MODE:   APPLY (writes)" : "MODE:   dry-run — pass --apply to write");

  const cols = (await targets(schema)).filter((c) => !only || c.table === only);
  console.log(`scanning ${cols.length} columns\n`);

  let found = 0;
  let written = 0;
  const skipped: string[] = [];

  for (const { table, column, pk, isJson } of cols) {
    // A json column is CAST to CHAR so the same code-point test applies; the
    // repair runs over the RAW document text, where every code point it touches
    // is non-structural, so the document survives byte-for-byte otherwise.
    const expr = isJson ? `CAST(\`${column}\` AS CHAR)` : `\`${column}\``;
    let rows: { k: string | number | null; v: string }[];
    try {
      rows = (await db.write.$queryRawUnsafe(
        `SELECT ${pk ? `\`${pk}\`` : "NULL"} AS k, ${expr} AS v FROM \`${table}\`
          WHERE \`${column}\` IS NOT NULL AND HEX(${expr}) REGEXP ?`,
        prefilter,
      )) as { k: string | number | null; v: string }[];
    } catch (e) {
      skipped.push(`${table}.${column} (${(e as Error).message.slice(0, 60)})`);
      continue;
    }

    const dirty = rows.filter((r) => detect(String(r.v)));
    if (dirty.length === 0) continue;
    if (!pk) {
      skipped.push(`${table}.${column} — ${dirty.length} row(s) but NO primary key`);
      continue;
    }
    found += dirty.length;

    const before = String(dirty[0].v);
    const at = [...before].findIndex((ch, n) => detect([...before].slice(n, n + 4).join("")));
    const win = (s: string) => JSON.stringify([...s].slice(Math.max(0, at - 30), at + 30).join(""));
    console.log(`  ${table}.${column}: ${dirty.length} row(s)`);
    console.log(`      [${dirty[0].k}] ${win(before)}`);
    console.log(`        ->  ${win(repair(before))}`);

    if (!apply) continue;
    for (const r of dirty) {
      const fixed = repair(String(r.v));
      // Never write a document that stopped being valid JSON.
      if (isJson) JSON.parse(fixed);
      await db.write.$executeRawUnsafe(
        `UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${pk}\` = ?`,
        fixed,
        r.k,
      );
      written += 1;
    }
    console.log(`      written: ${dirty.length}`);
  }

  for (const s of skipped) console.log(`  SKIP ${s}`);
  console.log(`\nTOTAL: ${found} row(s); ${apply ? `${written} written` : "0 written (dry-run)"}`);
  if (apply && written > 0) {
    console.log("NOTE: rerun npm run search:index:{people,publications,funding},");
    console.log("      then verify by reading _source back out of the index.");
  }
  await db.write.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await db.write.$disconnect();
  process.exit(1);
});
