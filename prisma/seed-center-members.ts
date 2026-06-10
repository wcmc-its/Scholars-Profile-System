/**
 * RETIRED / SCOPED (#540 Phase 9). Seed `center_membership` from CWID list files
 * in `data/center-members/`.
 *
 * The unit-curation cutover supersedes file-based roster curation — centers are
 * now manually-owned and their rosters are edited through `/edit/center/*`. The
 * `data/center-members/*.txt` files are deleted, so this loader is dormant (no
 * input → "nothing to do"). It is kept, but **scoped to `source='file:*'` rows**
 * so a stray re-run can never delete a UI-added (`source='manual'`/`manual-ui`)
 * roster entry (edge case 26 in docs/unit-curation-spec.md). The one-shot
 * migration of legacy `file:*` rows to the manual layer lives in
 * `scripts/backfills/2026-06-10-import-unit-curation.ts`.
 *
 * Each file is named `<center-slug>.txt`, one CWID per line, optional
 * `cwid` header line. Comments (lines starting with `#`) and blank lines
 * are skipped. CWIDs are matched case-insensitively to scholar.cwid.
 *
 * Behavior:
 *   - Unknown CWIDs (no scholar match) are listed and skipped.
 *   - Re-running is safe: only this loader's own `source='file:*'` rows are
 *     cleared+repopulated; manual UI rows are preserved.
 *
 * Run: npx tsx prisma/seed-center-members.ts
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../lib/db";

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

  const allActiveCwids = (await db.write.scholar.findMany({
    where: { deletedAt: null },
    select: { cwid: true },
  })) as Array<{ cwid: string }>;
  const knownCwids = new Set(allActiveCwids.map((s) => s.cwid.toLowerCase()));

  for (const file of txtFiles) {
    const slug = file.replace(/\.txt$/, "");
    const center = await db.write.center.findUnique({ where: { slug } });
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
    // file (so removing a CWID from the file removes it on next run). Scoped to
    // this loader's own `source='file:*'` rows (#540 edge case 26) so a re-run
    // never deletes a UI-added (`source='manual'`/`manual-ui`) membership.
    await db.write.centerMembership.deleteMany({
      where: { centerCode: center.code, source: { startsWith: "file:" } },
    });
    if (matched.length > 0) {
      await db.write.centerMembership.createMany({
        data: matched.map((cwid) => ({
          centerCode: center.code,
          cwid,
          source: "file:" + file,
        })),
      });
    }
    // refreshedAt is bumped, but scholarCount is NOT overwritten here: with UI
    // (`manual`) rows now co-existing, only the curation write path knows the
    // true total. The backfill / roster endpoints own scholarCount post-cutover.
    await db.write.center.update({
      where: { code: center.code },
      data: { refreshedAt: new Date() },
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
  .finally(() => db.write.$disconnect());
