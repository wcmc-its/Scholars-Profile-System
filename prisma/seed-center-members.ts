/**
 * Seed `center_membership` from CWID list files in `data/center-members/`.
 *
 * Each file is named `<center-slug>.txt`, one CWID per line, optional
 * `cwid` header line. Comments (lines starting with `#`) and blank lines
 * are skipped. CWIDs are matched case-insensitively to scholar.cwid.
 *
 * Behavior:
 *   - Unknown CWIDs (no scholar match) are listed and skipped.
 *   - Re-running is safe: existing (centerCode, cwid) pairs are upserted.
 *   - After processing, `center.scholarCount` is refreshed for every
 *     center that had a file.
 *
 * Run: npx tsx prisma/seed-center-members.ts
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../lib/generated/prisma/client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) });

const MEMBERS_DIR = path.join(process.cwd(), "data", "center-members");

function parseCwids(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && l.toLowerCase() !== "cwid")
    .map((l) => l.toLowerCase());
}

async function main() {
  let entries: string[] = [];
  try {
    entries = await readdir(MEMBERS_DIR);
  } catch (e) {
    console.log(`No ${MEMBERS_DIR} directory; nothing to do`);
    return;
  }
  const txtFiles = entries.filter((f) => f.endsWith(".txt"));
  if (txtFiles.length === 0) {
    console.log("No .txt files in data/center-members/");
    return;
  }

  const allActiveCwids = (await prisma.scholar.findMany({
    where: { deletedAt: null },
    select: { cwid: true },
  })) as Array<{ cwid: string }>;
  const knownCwids = new Set(allActiveCwids.map((s) => s.cwid.toLowerCase()));

  for (const file of txtFiles) {
    const slug = file.replace(/\.txt$/, "");
    const center = await prisma.center.findUnique({ where: { slug } });
    if (!center) {
      console.warn(`SKIP ${file}: no center with slug "${slug}"`);
      continue;
    }

    const filePath = path.join(MEMBERS_DIR, file);
    const content = await readFile(filePath, "utf8");
    const cwids = parseCwids(content);

    const matchedSet = new Set<string>();
    const unmatchedSet = new Set<string>();
    let duplicates = 0;
    for (const c of cwids) {
      if (knownCwids.has(c)) {
        if (matchedSet.has(c)) duplicates++;
        else matchedSet.add(c);
      } else {
        unmatchedSet.add(c);
      }
    }
    const matched = Array.from(matchedSet);
    const unmatched = Array.from(unmatchedSet);

    // Idempotent insert: clear+repopulate keeps the table in sync with the
    // file (so removing a CWID from the file removes it on next run).
    await prisma.centerMembership.deleteMany({ where: { centerCode: center.code } });
    if (matched.length > 0) {
      await prisma.centerMembership.createMany({
        data: matched.map((cwid) => ({
          centerCode: center.code,
          cwid,
          source: "file:" + file,
        })),
      });
    }
    await prisma.center.update({
      where: { code: center.code },
      data: { scholarCount: matched.length, refreshedAt: new Date() },
    });

    console.log(
      `${slug}: ${matched.length} matched, ${unmatched.length} unmatched, ${duplicates} duplicates skipped (of ${cwids.length} lines)`,
    );
    if (unmatched.length > 0) {
      console.log(`  unmatched (first 10): ${unmatched.slice(0, 10).join(", ")}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
