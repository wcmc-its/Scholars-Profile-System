/**
 * Audit: every Prisma write must go through `db.write` (B16 / #115).
 *
 * Fails (exit 1) when production source contains:
 *   1. a write method (create/update/delete/upsert/…) called on the read
 *      client — `db.read.<model>.<write>` or the deprecated `prisma` alias,
 *      which is itself `db.read`;
 *   2. a raw write (`$executeRaw` / `$executeRawUnsafe`) on the read client;
 *   3. `new PrismaClient` outside `lib/db.ts` — every client must be one of
 *      the split pair constructed there.
 *
 * `$transaction` and `$queryRaw` are allowed on either client (read batches
 * are valid on `db.read`). Run via `npm run audit:db-writes`; wired into CI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib", "etl", "scripts", "seed", "prisma"];
// Generated client is full of write examples in JSDoc; this script holds the
// forbidden patterns as strings — both must be excluded from the scan.
const SKIP = ["lib/generated", "scripts/audit-db-writes.ts"];

const WRITE_METHODS = [
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
].join("|");

/** A write method invoked on the read client or its deprecated `prisma` alias. */
const READ_CLIENT_WRITE = new RegExp(
  `\\b(?:db\\.read|prisma)\\.[A-Za-z_$][\\w$]*\\.(?:${WRITE_METHODS})\\b`,
);
/** A raw write on the read client. `$queryRaw` (read) is intentionally allowed. */
const READ_CLIENT_RAW_WRITE = /\b(?:db\.read|prisma)\.\$executeRaw(?:Unsafe)?\b/;
const STRAY_CLIENT = /\bnew PrismaClient\b/;

type Violation = { file: string; line: number; text: string; rule: string };

function isSkipped(rel: string): boolean {
  return SKIP.some((s) => rel === s || rel.startsWith(s + "/"));
}

function collectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isSkipped(relative(ROOT, full))) continue;
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
}

const files: string[] = [];
for (const dir of SCAN_DIRS) {
  try {
    collectFiles(join(ROOT, dir), files);
  } catch {
    // directory absent in this checkout — skip
  }
}

const violations: Violation[] = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, i) => {
      const v = (rule: string) =>
        violations.push({ file: rel, line: i + 1, text: text.trim(), rule });
      if (READ_CLIENT_WRITE.test(text)) v("write method on the read client");
      if (READ_CLIENT_RAW_WRITE.test(text)) v("$executeRaw on the read client");
      if (rel !== "lib/db.ts" && STRAY_CLIENT.test(text))
        v("new PrismaClient outside lib/db.ts");
    });
}

if (violations.length > 0) {
  console.error(`✗ db-write audit failed — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
    console.error(`    ${v.text}`);
  }
  console.error(`\nWrites must use db.write; reads use db.read. See lib/db.ts.`);
  process.exit(1);
}

console.log(`✓ db-write audit passed — ${files.length} files scanned, all writes via db.write.`);
