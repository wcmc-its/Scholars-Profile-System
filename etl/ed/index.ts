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
import { prisma } from "../../lib/db";
import type { RoleCategory } from "@/lib/eligibility";
import { deriveSlug, nextAvailableSlug } from "@/lib/slug";
import {
  type EdFacultyEntry,
  fetchActiveFaculty,
  fetchDoctoralStudents,
  openLdap,
} from "@/lib/sources/ldap";

/**
 * Derive the role-category bucket for the algorithmic-surface eligibility carve.
 *
 * Spec source: design-spec-v1.7.1.md:352-356 describes the *policy intent* using a
 * leaf-level person-type taxonomy ("Full-Time WCMC Faculty", "Postdoc", "Fellow",
 * etc.) and a separate FTE=100 attribute.
 *
 * LDAP reality (probe 2026-05-04, debug session recent-contributions-hidden):
 *   - weillCornellEduPersonTypeCode is multi-valued, with the umbrella value
 *     "academic" first (~8,913 entries) and leaf-level codes carried later in
 *     the same array (e.g. "academic-faculty-weillfulltime",
 *     "academic-nonfaculty-postdoc", "academic-nonfaculty-postdoc-fellow").
 *   - weillCornellEduPrimaryPersonTypeCode is single-valued and carries the
 *     canonical leaf classification: "employee-faculty-new-york-fulltime",
 *     "employee-postdoc-new-york", "faculty-affiliated-non-employee", etc.
 *   - weillCornellEduFTE is NOT populated for any active scholar; the FTE=100
 *     signal is encoded into the type-code string itself ("-fulltime"/
 *     "-weillfulltime"). The strict fte === 100 check from the original
 *     implementation matched zero rows and tagged all 8,913 active scholars as
 *     "affiliated_faculty", which then dropped them from ELIGIBLE_ROLES and
 *     hid every algorithmic surface (Recent contributions, etc.).
 *
 * This implementation reads BOTH the scalar primary code and the multi-valued
 * array, applies the spec's policy buckets, and falls through to
 * "affiliated_faculty" only for genuinely affiliated entries.
 *
 * Order matters: doctoral_student fires before any faculty/postdoc check so
 * a PHD student pulled from ou=students with a residual personTypeCode does
 * not get re-classified.
 */
function deriveRoleCategory(f: EdFacultyEntry): RoleCategory {
  if (f.ou === "students" && f.degreeCode === "PHD") return "doctoral_student";

  const primary = f.primaryPersonTypeCode ?? "";
  const codes = f.personTypeCodes;
  const has = (needle: string) => codes.includes(needle);

  // Full-time faculty — the canonical signal is the scalar primary code
  // "employee-faculty-{location}-fulltime" (covers New York and Qatar campuses).
  // Fallback: the multi-valued array carries "academic-faculty-weillfulltime"
  // for any entry where the primary scalar is missing or stale.
  if (
    primary === "employee-faculty-new-york-fulltime" ||
    primary === "employee-faculty-qatar-fulltime" ||
    has("academic-faculty-weillfulltime")
  ) {
    return "full_time_faculty";
  }

  // Postdoc — scalar covers employee + non-employee variants; array fallback
  // handles entries where primary is null but the leaf code is present.
  if (
    primary === "employee-postdoc-new-york" ||
    primary === "affiliate-postdoc-non-employee" ||
    has("academic-nonfaculty-postdoc")
  ) {
    // The "-fellow" suffix in the array distinguishes research fellows from
    // career postdocs. Fellow takes precedence per spec §"Algorithmic surface
    // eligibility carve" (Postdoc + Fellow are listed separately).
    if (has("academic-nonfaculty-postdoc-fellow")) return "fellow";
    return "postdoc";
  }

  // Standalone fellow (no postdoc designation in the array) — keep the branch
  // for forward-compat in case the schema starts emitting a fellow-only code.
  if (has("academic-nonfaculty-postdoc-fellow")) return "fellow";

  // Affiliated faculty — the dominant bucket: voluntary, adjunct, courtesy,
  // emeritus, part-time, and the catch-all "faculty-affiliated-non-employee"
  // primary value. Per design-spec-v1.7.1.md:354 these are explicitly NOT
  // eligible-carve scholars.
  if (
    primary === "faculty-affiliated-non-employee" ||
    has("academic-faculty-voluntary") ||
    has("academic-faculty-adjunct") ||
    has("academic-faculty-courtesy") ||
    has("academic-faculty-emeritus") ||
    has("academic-faculty-weillparttime") ||
    has("academic-faculty-visiting")
  ) {
    return "affiliated_faculty";
  }

  // Non-faculty academic — research-track, lab-staff academic appointments
  // that are NOT postdoc / fellow.
  if (primary === "employee-academic-new-york" || has("academic-nonfaculty")) {
    return "non_faculty_academic";
  }

  // Instructor / Lecturer — discrete academic-faculty leaves.
  if (has("academic-faculty-instructor")) return "instructor";
  if (has("academic-faculty-lecturer")) return "lecturer";

  // Non-academic employees (rare in the active-faculty filter; usually filtered
  // out upstream, but the catch is defensive).
  if (primary === "employee-staff-new-york" || has("employee-nonacademic")) {
    return "non_academic";
  }

  // Catch-all: anything else gets "affiliated_faculty". This includes
  // "academic-prestart" (entry exists in ED but appointment hasn't started),
  // residual academic-only entries, and unknown leaves.
  return "affiliated_faculty";
}

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
    console.log(`ED returned ${facultyEntries.length} active academic entries.`);

    // Phase 2: doctoral students live under ou=students, not ou=people, so the
    // active-faculty filter excludes them. Pull them as a second branch and
    // merge before the upsert. Eligibility-carve consumers depend on this.
    let studentEntries: Awaited<ReturnType<typeof fetchDoctoralStudents>> = [];
    try {
      console.log("Fetching doctoral (PHD) students from ou=students...");
      studentEntries = await fetchDoctoralStudents(client);
      console.log(`ED returned ${studentEntries.length} doctoral students.`);
    } catch (err) {
      console.warn(
        `Doctoral student fetch skipped (ou=students unavailable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await client.unbind();

    const allEntries = [...facultyEntries, ...studentEntries];

    // Sort by CWID for deterministic collision ordering.
    allEntries.sort((a, b) => a.cwid.localeCompare(b.cwid));

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

    // Phase 3 — accumulate distinct (deptCode, deptName) and (divCode, deptCode, divName)
    // tuples while iterating scholars. These feed the Department + Division upsert block.
    const seenDepts = new Map<string, { code: string; name: string }>();
    const seenDivs = new Map<string, { code: string; deptCode: string; name: string }>();

    for (const f of allEntries) {
      incomingCwids.add(f.cwid);
      const existingScholar = existingByCwid.get(f.cwid);
      const roleCategory = deriveRoleCategory(f);

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
            roleCategory,
            // Slug is NOT regenerated on update if the name is unchanged. If it
            // changed, derive a new one and write the old to slug_history.
            ...(await maybeUpdatedSlug(existingScholar.slug, f.preferredName, f.cwid, existingSlugs)),
            ...(wasDeleted ? { deletedAt: null } : {}),
            // Phase 3 — D-01: populate org-unit FK columns from LDAP attributes.
            deptCode: f.deptCode ?? null,
            divCode: f.divCode ?? null,
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
            roleCategory,
            // Phase 3 — D-01:
            deptCode: f.deptCode ?? null,
            divCode: f.divCode ?? null,
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

      // Accumulate distinct department + division tuples for bulk upsert after the loop.
      if (f.deptCode && !seenDepts.has(f.deptCode)) {
        // Parse orgUnit for level1 name; format is "level2 · level1" per design spec line 906-920.
        const orgParts = (f.orgUnit ?? "").split(" · ");
        const deptName =
          orgParts.length >= 2
            ? orgParts[orgParts.length - 1]
            : (f.primaryDepartment ?? f.deptCode);
        seenDepts.set(f.deptCode, { code: f.deptCode, name: deptName });
      }
      if (f.divCode && f.deptCode && !seenDivs.has(f.divCode)) {
        const orgParts = (f.orgUnit ?? "").split(" · ");
        const divName = orgParts.length >= 2 ? orgParts[0] : f.divCode;
        seenDivs.set(f.divCode, { code: f.divCode, deptCode: f.deptCode, name: divName });
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

    // Phase 3 — Department + Division upsert from accumulated org-unit tuples.
    // Runs under the same "ED" source EtlRun (one run for the whole ED source per ETL-01).
    let deptUpserts = 0;
    for (const dept of seenDepts.values()) {
      const slug = deriveSlug(dept.name);
      await prisma.department.upsert({
        where: { code: dept.code },
        create: {
          code: dept.code,
          name: dept.name,
          slug,
          source: "ED",
          refreshedAt: new Date(),
        },
        update: {
          name: dept.name,
          slug,
          refreshedAt: new Date(),
        },
      });
      deptUpserts += 1;
    }
    console.log(`[ED] upserted ${deptUpserts} departments`);

    let divUpserts = 0;
    for (const div of seenDivs.values()) {
      const slug = deriveSlug(div.name);
      await prisma.division.upsert({
        where: { code: div.code },
        create: {
          code: div.code,
          deptCode: div.deptCode,
          name: div.name,
          slug,
          source: "ED",
          refreshedAt: new Date(),
        },
        update: {
          deptCode: div.deptCode,
          name: div.name,
          slug,
          refreshedAt: new Date(),
        },
      });
      divUpserts += 1;
    }
    console.log(`[ED] upserted ${divUpserts} divisions`);

    // Phase 3 — D-03 chair identification per department.
    // Match appointment.title startsWith "Chair" (covers "Chair", "Chairman", "Chairperson",
    // "Chairman and Professor", etc.). Per Pitfall 3: log distinct values matched for
    // post-launch audit. Pick the most-recent active (endDate IS NULL) appointment in
    // the department; tiebreak on isPrimary DESC then startDate DESC.
    const chairTitleVariants = new Set<string>();
    let chairAssignments = 0;
    for (const dept of seenDepts.values()) {
      const candidate = await prisma.appointment.findFirst({
        where: {
          // Scholars in this dept (joined via Scholar.deptCode FK).
          scholar: { deptCode: dept.code, deletedAt: null, status: "active" },
          // Chair-like title prefix. Case-insensitive match via Prisma `startsWith`.
          title: { startsWith: "Chair" },
          // Active appointment only.
          endDate: null,
        },
        orderBy: [{ isPrimary: "desc" }, { startDate: "desc" }],
        select: { cwid: true, title: true },
      });
      if (candidate) {
        chairTitleVariants.add(candidate.title);
        await prisma.department.update({
          where: { code: dept.code },
          data: { chairCwid: candidate.cwid },
        });
        chairAssignments += 1;
      }
    }
    console.log(`[ED] assigned chairs to ${chairAssignments}/${seenDepts.size} departments`);
    console.log(`[ED] distinct chair-title variants observed:`, [...chairTitleVariants]);

    // Phase 3 — scholarCount refresh per Department and Division.
    for (const dept of seenDepts.values()) {
      const count = await prisma.scholar.count({
        where: { deptCode: dept.code, deletedAt: null, status: "active" },
      });
      await prisma.department.update({ where: { code: dept.code }, data: { scholarCount: count } });
    }
    for (const div of seenDivs.values()) {
      const count = await prisma.scholar.count({
        where: { divCode: div.code, deletedAt: null, status: "active" },
      });
      await prisma.division.update({ where: { code: div.code }, data: { scholarCount: count } });
    }

    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: allEntries.length,
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
