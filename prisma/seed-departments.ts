/**
 * Seed the `department` table from existing scholars' `primary_department`
 * values, then backfill `scholar.dept_code` so individual department pages
 * resolve correctly.
 *
 * This is a temporary bootstrap for environments where the ED LDAP ETL
 * (etl/ed/index.ts) has not been run. When the real ETL runs, it will
 * upsert with proper LDAP codes (overwriting these `code` values via the
 * matching name; safer to delete-and-re-seed-from-LDAP if collisions arise).
 *
 * Filters: only primary_department values with >= 30 active scholars are
 * promoted to a department. Below-threshold values (e.g. "Library",
 * "Administration", divisions miscoded as departments) stay null on
 * dept_code and don't appear in the Browse hub.
 *
 * Run: npx tsx prisma/seed-departments.ts
 */
import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../lib/generated/prisma/client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) });

const MIN_SCHOLAR_COUNT = 30;

// Excluded names: present in primary_department but conceptually belong
// elsewhere (centers/institutes, non-academic units).
const EXCLUDE_NAMES = new Set<string>([
  "Brain and Mind Research Institute",
  "Library",
  "Administration",
  "Hospital for Special Surgery",
  "Hospital Programs",
]);

function toCode(name: string): string {
  return name
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  // 1. Aggregate distinct primary_department + counts of active scholars.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (prisma.scholar.groupBy as any)({
    by: ["primaryDepartment"],
    where: {
      deletedAt: null,
      status: "active",
      primaryDepartment: { not: null },
    },
    _count: { _all: true },
    orderBy: { primaryDepartment: "asc" },
  })) as Array<{
    primaryDepartment: string | null;
    _count: { _all: number };
  }>;

  const candidates = rows
    .filter(
      (r) =>
        r.primaryDepartment !== null &&
        !EXCLUDE_NAMES.has(r.primaryDepartment) &&
        r._count._all >= MIN_SCHOLAR_COUNT,
    )
    .map((r) => ({
      name: r.primaryDepartment as string,
      count: r._count._all,
      code: toCode(r.primaryDepartment as string),
      slug: toSlug(r.primaryDepartment as string),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Promoting ${candidates.length} departments from scholar data`);

  let inserted = 0;
  let updated = 0;
  for (const c of candidates) {
    const existing = await prisma.department.findUnique({
      where: { code: c.code },
    });
    await prisma.department.upsert({
      where: { code: c.code },
      create: {
        code: c.code,
        name: c.name,
        slug: c.slug,
        scholarCount: c.count,
        source: "scholar_primary_department",
      },
      update: {
        name: c.name,
        slug: c.slug,
        scholarCount: c.count,
      },
    });
    existing ? updated++ : inserted++;
  }
  console.log(`Departments: ${inserted} new, ${updated} updated`);

  // 2. Backfill scholar.dept_code by name match. Skip scholars whose
  //    primary_department doesn't promote to a department row (sub-threshold
  //    or excluded names).
  const codeByName = new Map(candidates.map((c) => [c.name, c.code]));
  let backfilled = 0;
  for (const [name, code] of codeByName) {
    const result = await prisma.scholar.updateMany({
      where: {
        primaryDepartment: name,
        deletedAt: null,
        status: "active",
        deptCode: null,
      },
      data: { deptCode: code },
    });
    backfilled += result.count;
  }
  console.log(`Backfilled dept_code on ${backfilled} scholars`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
