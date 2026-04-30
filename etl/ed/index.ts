/**
 * ED LDAP ETL — Phase 4a.
 *
 * Pulls active academic faculty from the WCM Enterprise Directory and writes
 * them to the Scholar table. ED is the chain head per Q5'; it produces the
 * canonical CWID set that downstream ETLs join to.
 *
 * Behavior per the design decisions:
 *   - One row per CWID. Records without a CWID skipped.
 *   - Slug derived from preferredName via lib/slug.ts (Q3').
 *   - Collision suffixing in CWID-creation order (older scholars keep
 *     unsuffixed slug; new arrivals get -2, -3, ...). For a fresh ETL,
 *     CWID-lex order is a reasonable proxy for created_at.
 *   - Soft-delete (Q4'): scholars present last run but missing this run get
 *     deletedAt=now(). Reactivated scholars (deletedAt cleared on reappearance).
 *   - Schema-stable: drops only scholar-row data, NOT the publication/grant
 *     tables (those are owned by their respective ETLs).
 *
 * Production: replace this with a Lambda triggered nightly via EventBridge.
 *
 * Usage: `npm run etl:ed`
 */
import { prisma } from "@/lib/db";
import { deriveSlug, nextAvailableSlug } from "@/lib/slug";
import { fetchActiveFaculty, openLdap } from "@/lib/sources/ldap";

async function main() {
  const start = new Date();
  const run = await prisma.etlRun.create({
    data: { source: "ED", status: "running" },
  });

  try {
    console.log("Connecting to ED LDAP...");
    const client = await openLdap();

    console.log("Fetching active academic faculty (this can take a moment)...");
    const facultyEntries = await fetchActiveFaculty(client);
    await client.unbind();
    console.log(`ED returned ${facultyEntries.length} active academic entries.`);

    // Sort by CWID for deterministic collision ordering.
    facultyEntries.sort((a, b) => a.cwid.localeCompare(b.cwid));

    // Existing scholars and slugs from the DB.
    const existing = await prisma.scholar.findMany({
      select: { cwid: true, slug: true, deletedAt: true, createdAt: true },
    });
    const existingByCwid = new Map(existing.map((s) => [s.cwid, s]));
    const existingSlugs = new Set(existing.map((s) => s.slug));

    let created = 0;
    let updated = 0;
    let reactivated = 0;
    const incomingCwids = new Set<string>();

    for (const f of facultyEntries) {
      incomingCwids.add(f.cwid);
      const existingScholar = existingByCwid.get(f.cwid);

      if (existingScholar) {
        // Update in place; reactivate if soft-deleted.
        const wasDeleted = !!existingScholar.deletedAt;
        await prisma.scholar.update({
          where: { cwid: f.cwid },
          data: {
            preferredName: f.preferredName,
            fullName: f.fullName,
            primaryTitle: f.primaryTitle,
            primaryDepartment: f.primaryDepartment,
            email: f.email,
            // Slug is NOT regenerated on update if the name is unchanged. If it
            // changed, derive a new one and write the old to slug_history.
            ...(await maybeUpdatedSlug(existingScholar.slug, f.preferredName, f.cwid, existingSlugs)),
            ...(wasDeleted ? { deletedAt: null } : {}),
          },
        });
        if (wasDeleted) reactivated += 1;
        updated += 1;
      } else {
        // New scholar.
        const baseSlug = deriveSlug(f.preferredName) || f.cwid.toLowerCase();
        const slug = nextAvailableSlug(baseSlug, existingSlugs);
        existingSlugs.add(slug);

        await prisma.scholar.create({
          data: {
            cwid: f.cwid,
            preferredName: f.preferredName,
            fullName: f.fullName,
            primaryTitle: f.primaryTitle,
            primaryDepartment: f.primaryDepartment,
            email: f.email,
            slug,
            // ED ETL doesn't have appointment date detail in the basic search;
            // a richer query will add appointments in a follow-up. Insert a
            // placeholder primary appointment so the profile renders.
            appointments: {
              create: [
                {
                  title: f.primaryTitle ?? "Faculty",
                  organization: f.primaryDepartment ?? "Weill Cornell Medicine",
                  startDate: null,
                  endDate: null,
                  isPrimary: true,
                  isInterim: false,
                  externalId: `ED-${f.cwid}-1`,
                },
              ],
            },
          },
        });
        created += 1;
      }
    }

    // Soft-delete: scholars in DB but not in ED this run.
    const departed = existing.filter(
      (s) => !s.deletedAt && !incomingCwids.has(s.cwid),
    );
    let softDeleted = 0;
    for (const s of departed) {
      await prisma.scholar.update({
        where: { cwid: s.cwid },
        data: { deletedAt: new Date() },
      });
      softDeleted += 1;
    }

    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: facultyEntries.length,
      },
    });

    const elapsed = Math.round((Date.now() - start.getTime()) / 1000);
    console.log(
      `ED ETL complete in ${elapsed}s: created=${created}, updated=${updated}, reactivated=${reactivated}, soft-deleted=${softDeleted}`,
    );
  } catch (err) {
    await prisma.etlRun.update({
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

async function maybeUpdatedSlug(
  currentSlug: string,
  newName: string,
  cwid: string,
  existingSlugs: Set<string>,
): Promise<{ slug?: string }> {
  const newBase = deriveSlug(newName) || cwid.toLowerCase();
  // If the current slug matches the derived base (or a base-N suffix variant),
  // nothing to do. Otherwise the name changed in a slug-affecting way.
  const base = currentSlug.replace(/-\d+$/, "");
  if (base === newBase) return {};

  const newSlug = nextAvailableSlug(newBase, existingSlugs);
  if (newSlug === currentSlug) return {};

  // Record the old slug in history; emit the new slug.
  await prisma.slugHistory.upsert({
    where: { oldSlug: currentSlug },
    update: { currentCwid: cwid },
    create: { oldSlug: currentSlug, currentCwid: cwid },
  });
  existingSlugs.delete(currentSlug);
  existingSlugs.add(newSlug);
  return { slug: newSlug };
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
