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
import { promises as fs } from "node:fs";
import path from "node:path";

import { prisma } from "../../lib/db";
import { detectDivisionChief, type ChiefVerdict } from "./chief-detection";
import { DEPARTMENT_CATEGORIES } from "@/lib/department-categories";
import type { RoleCategory } from "@/lib/eligibility";
import { deriveSlug, nextAvailableSlug } from "@/lib/slug";
import {
  collapseEmployeeRecordsByCwid,
  type EdFacultyAppointment,
  type EdFacultyEntry,
  fetchActiveEmployeeRecords,
  fetchActiveFaculty,
  fetchActiveFacultyAppointments,
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

/** Detect whether the scholar likely has a public physician profile at
 *  weillcornell.org. ED LDAP carries clinical signals as multi-valued person-
 *  type codes — "affiliate-nyp-clinical" and "affiliate-nyp-*-credentialed"
 *  are reliable proxies for "is a clinician with a Cornell Health profile".
 *  Pure researchers / non-clinical faculty don't carry these codes, so the
 *  link defaults to absent (design spec v1.7.1 absence-as-default rule). */
function inferHasClinicalProfile(personTypeCodes: string[]): boolean {
  return personTypeCodes.some((c) => /clinical|credentialed/i.test(c));
}

/**
 * Replace the scholar's ED-source appointments with the structured rows from
 * the WOOFA SOR (`ou=faculty,ou=sors`). Caller passes the per-scholar slice
 * of `fetchActiveFacultyAppointments()` output (already filtered to status =
 * faculty:active). Each row carries its own department, real start/end dates,
 * and `isPrimary` flag — much richer than the multi-valued `title` attribute
 * on the person entry, which mixed clinical/admin roles in alongside academic
 * appointments and had no per-row dates or status.
 *
 * Idempotent: deletes ED-source appointments for this scholar first. Other
 * sources' appointments (none today, but ASMS may add historical rows later)
 * are preserved. Scholars with no SOR rows (rare — typically PHD students
 * pulled in via the ou=students branch) end up with zero appointments and
 * the profile sidebar simply omits the section.
 */
async function refreshEdAppointments(
  cwid: string,
  appts: EdFacultyAppointment[],
): Promise<void> {
  await prisma.appointment.deleteMany({
    where: { cwid, source: "ED" },
  });
  if (appts.length === 0) return;

  await prisma.appointment.createMany({
    data: appts.map((a) => ({
      cwid: a.cwid,
      title: a.title,
      organization: a.organization ?? "Weill Cornell Medicine",
      startDate: a.startDate,
      endDate: a.endDate,
      isPrimary: a.isPrimary,
      isInterim: false,
      externalId: a.externalId,
      source: "ED",
    })),
  });
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

    console.log("Fetching active faculty appointments from ou=faculty SOR...");
    const facultyAppointments = await fetchActiveFacultyAppointments(client);
    console.log(`ED returned ${facultyAppointments.length} active faculty appointment rows.`);
    const appointmentsByCwid = new Map<string, EdFacultyAppointment[]>();
    for (const a of facultyAppointments) {
      const arr = appointmentsByCwid.get(a.cwid) ?? [];
      arr.push(a);
      appointmentsByCwid.set(a.cwid, arr);
    }


    // Phase 4 — employee SOR for the manager graph. Used by:
    //   - postdoc mentor lookup (issue #5)
    //   - division-chief detection (issue #16, Path B)
    // Best-effort: a fetch failure should not abort the whole ETL — chief
    // detection and the manual override pass still run, the former just
    // skips Path B and the override file fills in.
    console.log("Fetching active employee SOR records from ou=employees SOR...");
    let employeeRecords: Awaited<ReturnType<typeof fetchActiveEmployeeRecords>> = [];
    try {
      employeeRecords = await fetchActiveEmployeeRecords(client);
      console.log(`ED returned ${employeeRecords.length} active employee SOR records.`);
    } catch (err) {
      console.warn(
        `Employee SOR fetch skipped (ou=employees,ou=sors unavailable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const employeeByCwid = collapseEmployeeRecordsByCwid(employeeRecords);
    const managerByCwid = new Map<string, string | null>();
    for (const [cwid, rec] of employeeByCwid) {
      managerByCwid.set(cwid, rec.managerCwid);
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
    // tuples that feed the Department + Division upsert block. We populate
    // these in a pre-pass over allEntries / appointmentsByCwid so the dept
    // and division rows exist BEFORE any Scholar row references them via
    // FK (otherwise scholar.update fails with P2003 ForeignKeyConstraintViolation).
    const seenDepts = new Map<string, { code: string; name: string }>();
    const seenDivs = new Map<string, { code: string; deptCode: string; name: string }>();

    /**
     * Pick the row whose org-unit codes should drive Scholar.deptCode/divCode.
     *
     * `appts` is already filtered to weillCornellEduStatus=faculty:active by
     * the LDAP search — every row here is an active appointment. We do NOT
     * additionally filter on endDate: many active appointments have a real
     * future end date (e.g. ccole's primary in Medicine ends 2026-06-30,
     * not the 2099 indefinite sentinel that parses to null).
     *
     * Selection precedence:
     *   1. A chair-titled appointment (title starts with "Chair") — dept
     *      chair affiliation is the strongest signal of which dept the
     *      scholar represents, even when LDAP marks a different appointment
     *      as PrimaryEntry=TRUE (e.g. Ronald Crystal's LDAP primary is
     *      Medicine but he chairs Genetic Medicine — defer to GM).
     *   2. The LDAP-flagged primary (`weillCornellEduPrimaryEntry=TRUE`).
     *   3. First active appointment.
     *   null when the scholar has zero active appointments (e.g. PHD
     *   students under ou=students).
     */
    function pickPrimaryActiveAppt(
      appts: EdFacultyAppointment[],
    ): EdFacultyAppointment | null {
      const chair = appts.find((a) => /^Chair/i.test(a.title));
      if (chair) return chair;
      const primary = appts.find((a) => a.isPrimary);
      return primary ?? appts[0] ?? null;
    }

    /** Org-unit names that LDAP returns as the level1 unit but which are
     *  not academic departments (admin units, support orgs). Scholars whose
     *  primary appointment is in one of these get null dept_code/div_code
     *  so they don't appear under a fake dept on /browse. */
    const EXCLUDED_DEPT_NAMES = new Set<string>([
      "Information Technologies and Services",
      "Administration & Finance",
    ]);

    /** Level2 names that should be promoted to dept (level1) status. The
     *  WCM Library appears as level2 under Information Technologies and
     *  Services in LDAP, but is an academic dept in its own right.
     *  Scholars whose primary appointment has level2 == one of these get
     *  level2 used as their dept (level2 code → deptCode, level2 name →
     *  deptName) and no division. */
    const PROMOTE_LEVEL2_TO_DEPT = new Set<string>(["Library"]);

    /** Manual rename map: LDAP returns these org-unit names, but the
     *  display should reflect the WCM academic department they roll up
     *  under. The level1 code is preserved (so scholar.deptCode stays
     *  stable) — only the display name + slug change. */
    const DEPT_NAME_OVERRIDES: Record<string, string> = {
      // WCM faculty at HSS are members of the Orthopaedic Surgery dept;
      // HSS is the affiliate hospital, not an academic dept.
      "Hospital for Special Surgery": "Orthopaedic Surgery",
    };

    /** Level2 org-unit names that LDAP returns under academic depts but which
     *  are admin/operational slices, not research divisions. Scholars whose
     *  primary appointment has level2 == one of these get null divCode/divName
     *  (they roll up to the parent dept directly), and no Division row is
     *  created. Mirrors the EXCLUDED_DEPT_NAMES pattern at the dept level —
     *  name-based, no regex, fail-closed: missing one name is one PR; an
     *  overzealous filter silently hides real divisions. */
    const EXCLUDED_DIV_NAMES = new Set<string>([
      "Administration",
    ]);

    /** Resolve the (deptCode, divCode, deptName, divName) tuple a single
     *  scholar should land at — same logic the scholar loop uses below. */
    function resolveOrgUnit(f: EdFacultyEntry): {
      deptCode: string | null;
      divCode: string | null;
      deptName: string | null;
      divName: string | null;
    } {
      const appts = appointmentsByCwid.get(f.cwid) ?? [];
      const primary = pickPrimaryActiveAppt(appts);
      // `f.primaryDepartment` (the person-entry weillCornellEduPrimaryDepartment)
      // mirrors the employee SOR's org assignment, which can be a lab/center
      // (e.g. "Jedd Wolchok Lab"). When the WOOFA faculty SOR has no active
      // primary row we render `f.orgUnit` (the level1 academic dept on the
      // person entry) or null, NOT the employee-side label.
      const rawDeptName =
        primary?.organization ?? f.orgUnit ?? null;
      const rawDivName = primary?.divName ?? null;
      const rawDivCode = primary?.divCode ?? null;

      // Strip excluded admin-style level2 units (e.g. "Administration") so no
      // Division row is created and the scholar rolls up to the parent dept.
      const isExcludedDiv = !!(rawDivName && EXCLUDED_DIV_NAMES.has(rawDivName));
      const effectiveDivName = isExcludedDiv ? null : rawDivName;
      const effectiveDivCode = isExcludedDiv ? null : rawDivCode;

      // Promote level2 → dept when LDAP nests an academic unit (Library)
      // under a non-academic level1 (ITS). The level2 code becomes the
      // scholar's dept_code; no division on this scholar. Promotion uses
      // the RAW level2 name so an academic unit isn't dropped by the
      // excluded-div filter.
      if (rawDivName && PROMOTE_LEVEL2_TO_DEPT.has(rawDivName) && rawDivCode) {
        return {
          deptCode: rawDivCode,
          divCode: null,
          deptName: rawDivName,
          divName: null,
        };
      }

      if (rawDeptName && EXCLUDED_DEPT_NAMES.has(rawDeptName)) {
        return { deptCode: null, divCode: null, deptName: null, divName: null };
      }

      const deptName = rawDeptName
        ? (DEPT_NAME_OVERRIDES[rawDeptName] ?? rawDeptName)
        : null;

      return {
        deptCode: primary?.deptCode ?? f.deptCode ?? null,
        divCode: effectiveDivCode,
        deptName,
        divName: effectiveDivName,
      };
    }

    // Pre-pass: collect every (deptCode, divCode) combination + per-code
    // scholar tally so the Department + Division upserts can run BEFORE the
    // scholar loop creates FK references.
    const deptScholarTally = new Map<string, number>();
    for (const f of allEntries) {
      const { deptCode, divCode, deptName, divName } = resolveOrgUnit(f);
      if (deptCode && !seenDepts.has(deptCode)) {
        seenDepts.set(deptCode, { code: deptCode, name: deptName ?? deptCode });
      }
      if (deptCode) {
        deptScholarTally.set(deptCode, (deptScholarTally.get(deptCode) ?? 0) + 1);
      }
      if (divCode && deptCode && !seenDivs.has(divCode)) {
        seenDivs.set(divCode, {
          code: divCode,
          deptCode,
          name: divName ?? divCode,
        });
      }
    }

    // Consolidation: WCM LDAP returns parallel codes for the same conceptual
    // department (e.g. "Medicine" appears as N1280, N1871, N1460, N1030,
    // N1020, N1876, N1050, N1933 — historical / sub-org-unit codes from
    // expired or fringe appointments that share the dept name). We collapse
    // to the canonical code per name (the one with the most scholars) and
    // remap every aliased code in seenDepts/seenDivs/scholar deptCode.
    const deptAlias = new Map<string, string>();
    {
      const byName = new Map<string, string[]>();
      for (const dept of seenDepts.values()) {
        const key = dept.name.trim().toLowerCase();
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key)!.push(dept.code);
      }
      for (const codes of byName.values()) {
        if (codes.length <= 1) continue;
        const canonical = codes.reduce((best, c) =>
          (deptScholarTally.get(c) ?? 0) > (deptScholarTally.get(best) ?? 0)
            ? c
            : best,
        );
        for (const c of codes) {
          if (c !== canonical) deptAlias.set(c, canonical);
        }
      }
    }
    if (deptAlias.size > 0) {
      console.log(
        `[ED] consolidating ${deptAlias.size} duplicate-name dept codes into canonicals`,
      );
      // Drop aliased dept rows from upsert set.
      for (const aliasedCode of deptAlias.keys()) {
        seenDepts.delete(aliasedCode);
      }
      // Re-point divisions whose parent was an aliased code.
      for (const div of seenDivs.values()) {
        const remap = deptAlias.get(div.deptCode);
        if (remap) div.deptCode = remap;
      }
    }
    function canonicalDeptCode(code: string | null): string | null {
      if (!code) return null;
      return deptAlias.get(code) ?? code;
    }

    // Upsert dept + division rows now (before scholar updates would
    // FK-reference them). Slug collisions (two distinct codes producing the
    // same name-derived slug — e.g. legacy "1280000000" vs modern "N1280"
    // both → "medicine") are disambiguated by appending the code suffix
    // to whichever row is upserted second.
    const usedDeptSlugs = new Set<string>();
    let deptUpsertsPre = 0;
    for (const dept of seenDepts.values()) {
      let slug = deriveSlug(dept.name) || dept.code.toLowerCase();
      if (usedDeptSlugs.has(slug)) {
        slug = `${slug}-${dept.code.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      }
      usedDeptSlugs.add(slug);
      const seedCategory = DEPARTMENT_CATEGORIES[dept.code] ?? "clinical";
      await prisma.department.upsert({
        where: { code: dept.code },
        create: {
          code: dept.code,
          name: dept.name,
          slug,
          category: seedCategory,
          source: "ED",
          refreshedAt: new Date(),
        },
        update: {
          // INTENTIONALLY does NOT update `category` — manual reclassification
          // (UPDATE department SET category = '...' WHERE code = '...') sticks
          // across ETL refreshes. The seed map only seeds new rows on CREATE.
          name: dept.name,
          slug,
          refreshedAt: new Date(),
        },
      });
      deptUpsertsPre += 1;
    }
    const usedDivSlugs = new Set<string>();
    let divUpsertsPre = 0;
    for (const div of seenDivs.values()) {
      let slug = deriveSlug(div.name) || div.code.toLowerCase();
      if (usedDivSlugs.has(slug)) {
        slug = `${slug}-${div.code.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      }
      usedDivSlugs.add(slug);
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
      divUpsertsPre += 1;
    }
    console.log(
      `[ED] pre-upserted ${deptUpsertsPre} departments, ${divUpsertsPre} divisions`,
    );

    for (const f of allEntries) {
      incomingCwids.add(f.cwid);
      const existingScholar = existingByCwid.get(f.cwid);
      const roleCategory = deriveRoleCategory(f);

      // SOR is authoritative for dept + division (probe 2026-05-06: only the
      // SOR child role records carry `weillCornellEduOrgUnit;level2` for the
      // division name + code). Same resolution as the pre-pass above, then
      // remap through the duplicate-name dept consolidation.
      const resolved = resolveOrgUnit(f);
      const effectiveDeptCode = canonicalDeptCode(resolved.deptCode);
      const effectiveDivCode = resolved.divCode;
      // The legacy `Scholar.primaryDepartment` text column drives the profile
      // sidebar's third line and search-result subtitles. Without this, the
      // unresolved person-entry value (e.g. "Jedd Wolchok Lab" — the employee
      // SOR org assignment) leaks through. Use the same resolved deptName the
      // FK uses, falling back to null when no academic dept is identifiable.
      const primaryDepartmentDisplay = resolved.deptName ?? null;

      if (existingScholar) {
        // Update in place; reactivate if soft-deleted.
        const wasDeleted = !!existingScholar.deletedAt;
        await prisma.scholar.update({
          where: { cwid: f.cwid },
          data: {
            preferredName: f.preferredName,
            fullName: f.fullName,
            postnominal: f.degree?.trim() || null,
            primaryTitle: f.primaryTitle,
            primaryDepartment: primaryDepartmentDisplay,
            email: f.email,
            roleCategory,
            // Slug is NOT regenerated on update if the name is unchanged. If it
            // changed, derive a new one and write the old to slug_history.
            ...(await maybeUpdatedSlug(existingScholar.slug, f.preferredName, f.cwid, existingSlugs)),
            ...(wasDeleted ? { deletedAt: null } : {}),
            // Phase 3 — D-01 / probe 2026-05-06: dept + div sourced from
            // SOR primary active appointment (level1/level2 subtypes).
            deptCode: effectiveDeptCode,
            divCode: effectiveDivCode,
            hasClinicalProfile: inferHasClinicalProfile(f.personTypeCodes),
          },
        });
        await refreshEdAppointments(f.cwid, appointmentsByCwid.get(f.cwid) ?? []);
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
            postnominal: f.degree?.trim() || null,
            primaryTitle: f.primaryTitle,
            primaryDepartment: primaryDepartmentDisplay,
            email: f.email,
            slug,
            roleCategory,
            // Phase 3 — D-01 / probe 2026-05-06: dept + div sourced from SOR.
            deptCode: effectiveDeptCode,
            divCode: effectiveDivCode,
            hasClinicalProfile: inferHasClinicalProfile(f.personTypeCodes),
            // Appointments are populated by refreshEdAppointments below — one
            // row per LDAP `title` value. ED LDAP only returns current-state
            // titles (no historical appointments), so every row written here
            // has endDate=null / isActive=true.
          },
        });
        await refreshEdAppointments(f.cwid, appointmentsByCwid.get(f.cwid) ?? []);
        created += 1;
      }

      // Dept + division rows already upserted in the pre-pass above.
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

    console.log(
      `[ED] upserted ${deptUpsertsPre} departments (pre-pass), ${divUpsertsPre} divisions`,
    );

    // Phase 3 — D-03 chair identification per department.
    //
    // Match `Chair of {dept name}` as a standalone phrase anywhere in the
    // appointment title. Covers:
    //   - direct:    "Chair of Medicine"
    //   - prefixed:  "Chair of Medicine, Affiliate Hospital"
    //   - endowed:   "Sanford I. Weill Chair of Medicine"
    //   - acting:    "Acting Chair of Cell and Developmental Biology"
    // Excludes vice / associate / deputy / assistant chairs explicitly —
    // those carry "Chair of X" too but are not the dept chair.
    //
    // Issue #58 — administrative depts (Library) are led by a Director, not
    // a Chair. For dept.category === "administrative" we additionally match
    // "Director of {name}" with the same shape. Restricting the director
    // path to admin depts avoids accidentally picking up center directors
    // as dept leaders for clinical / basic / mixed departments.
    //
    // Crucially, we do NOT restrict to scholars whose `deptCode = dept.code`:
    // a scholar's primary dept is sometimes Medicine while their chair role
    // is in a different unit (e.g. Crystal — primary Medicine, "Chair of
    // Genetic Medicine"). Title-based matching attributes the role to the
    // right dept regardless of where LDAP marks the scholar's primary
    // appointment.
    //
    // Tiebreak on isPrimary DESC then startDate DESC.
    const chairTitleVariants = new Set<string>();
    let chairAssignments = 0;
    for (const dept of seenDepts.values()) {
      // Look up category so we know whether to match "Chair of X" or
      // "Director of X". Falls back to "clinical" for depts the seed file
      // doesn't know about; same default the upsert step uses.
      const persisted = await prisma.department.findUnique({
        where: { code: dept.code },
        select: { category: true },
      });
      const category = persisted?.category ?? "clinical";
      const leaderWord = category === "administrative" ? "Director" : "Chair";
      const expected = `${leaderWord} of ${dept.name}`;
      const exclusions: { title: { contains: string } }[] = [];
      if (leaderWord === "Chair") {
        exclusions.push(
          { title: { contains: "Vice Chair" } },
          { title: { contains: "Vice-Chair" } },
          { title: { contains: "Associate Chair" } },
          { title: { contains: "Deputy Chair" } },
          { title: { contains: "Assistant Chair" } },
        );
      } else {
        // Director path — same shape; exclude vice/deputy/etc directors so
        // we land on the principal Director appointment.
        exclusions.push(
          { title: { contains: "Vice Director" } },
          { title: { contains: "Associate Director" } },
          { title: { contains: "Deputy Director" } },
          { title: { contains: "Assistant Director" } },
        );
      }
      const candidate = await prisma.appointment.findFirst({
        where: {
          scholar: { deletedAt: null, status: "active" },
          OR: [
            { title: expected },                              // exact
            { title: { startsWith: `${expected} ` } },        // "<L> of X ..."
            { title: { startsWith: `${expected},` } },        // "<L> of X, ..."
            { title: { endsWith: ` ${expected}` } },          // "... <L> of X" (endowed / acting)
            { title: { contains: ` ${expected} ` } },         // "... <L> of X ..."
            { title: { contains: ` ${expected},` } },         // "... <L> of X, ..."
          ],
          NOT: exclusions,
          endDate: null,
        },
        orderBy: [{ isPrimary: "desc" }, { startDate: "desc" }],
        select: { cwid: true, title: true },
      });
      // Ensure we always clear stale assignments first — if no candidate
      // matches this run, the dept gets chair_cwid=null instead of keeping
      // the wrong scholar from a prior run.
      await prisma.department.update({
        where: { code: dept.code },
        data: { chairCwid: candidate?.cwid ?? null },
      });
      if (candidate) {
        chairTitleVariants.add(candidate.title);
        chairAssignments += 1;
      }
    }
    console.log(`[ED] assigned leaders to ${chairAssignments}/${seenDepts.size} departments`);
    console.log(`[ED] distinct leader-title variants observed:`, [...chairTitleVariants]);

    // Issue #58 — admin-dept leader overrides. The chair/director regex above
    // only fires when the SOR appointment title carries "Director of {dept}".
    // For admin depts where the SOR title is something else (e.g. "Librarian"
    // for tew2004 in Library), apply a hand-curated CWID. The override only
    // runs for depts whose detection pass returned null, so once the upstream
    // SOR title is corrected the override quietly drops out.
    const ADMIN_DEPT_LEADER_OVERRIDES: Record<string, string> = {
      N1932: "tew2004", // Library — Terrie Rose Wheeler, "Director of Library"
    };
    let adminOverridesApplied = 0;
    for (const [code, cwid] of Object.entries(ADMIN_DEPT_LEADER_OVERRIDES)) {
      const dept = await prisma.department.findUnique({
        where: { code },
        select: { code: true, category: true, chairCwid: true },
      });
      if (!dept || dept.category !== "administrative") continue;
      if (dept.chairCwid) continue;
      const scholar = await prisma.scholar.findUnique({
        where: { cwid },
        select: { cwid: true, deletedAt: true, status: true },
      });
      if (!scholar || scholar.deletedAt || scholar.status !== "active") {
        console.warn(
          `[ED] admin-dept leader override skipped — cwid '${cwid}' not active in scholar table (dept ${code})`,
        );
        continue;
      }
      await prisma.department.update({
        where: { code },
        data: { chairCwid: cwid },
      });
      adminOverridesApplied += 1;
    }
    // Issue #5 — postdoctoral mentor pass. For every active postdoc whose
    // employee-SOR record carries a manager DN, record the manager's CWID on
    // Scholar.postdoctoralMentorCwid — but only if the mentor is also in the
    // scholar table (the self-FK requires it). Run after the main upsert
    // loop so faculty mentors are guaranteed present. Always write — even
    // when the value is null — so a postdoc whose mentor changes (or
    // graduates out) gets the field cleared on the next run.
    {
      const postdocs = await prisma.scholar.findMany({
        where: { roleCategory: "postdoc", deletedAt: null, status: "active" },
        select: { cwid: true },
      });
      const knownCwids = new Set(
        (
          await prisma.scholar.findMany({
            where: { deletedAt: null, status: "active" },
            select: { cwid: true },
          })
        ).map((s) => s.cwid),
      );
      let mentorAssignments = 0;
      let mentorOrphans = 0;
      for (const p of postdocs) {
        const managerCwid = managerByCwid.get(p.cwid) ?? null;
        let nextMentorCwid: string | null = null;
        if (managerCwid && knownCwids.has(managerCwid)) {
          nextMentorCwid = managerCwid;
        } else if (managerCwid) {
          mentorOrphans += 1;
        }
        await prisma.scholar.update({
          where: { cwid: p.cwid },
          data: { postdoctoralMentorCwid: nextMentorCwid },
        });
        if (nextMentorCwid) mentorAssignments += 1;
      }
      // Clear stale mentor pointers on non-postdocs in case roleCategory
      // flipped postdoc → faculty between runs.
      const cleared = await prisma.scholar.updateMany({
        where: {
          NOT: { roleCategory: "postdoc" },
          postdoctoralMentorCwid: { not: null },
        },
        data: { postdoctoralMentorCwid: null },
      });
      console.log(
        `[ED] postdoctoral mentor: ${mentorAssignments} assigned across ${postdocs.length} active postdocs (` +
          `${mentorOrphans} manager DNs not in scholar table; ${cleared.count} stale pointers cleared)`,
      );
    }

    if (adminOverridesApplied > 0) {
      console.log(
        `[ED] applied ${adminOverridesApplied} admin-dept leader override(s) (issue #58)`,
      );
    }

    // Phase 4 — D-04 division chief detection (issue #16).
    //
    // Path B (manager-graph): for each division, the chief is the faculty
    // member whose employee-SOR `manager` equals the parent department's
    // chair CWID. Disambiguate ties by:
    //   1. reportee count — # of fellow division members whose manager is
    //      this candidate. The chief manages the most people in the division.
    //   2. primary-appointment count in this division — distinguishes a
    //      genuine in-division chief from a cross-appointed member.
    //   3. earliest start date in this division — longest tenure as a
    //      stability proxy.
    //
    // Disable with SCHOLARS_DISABLE_CHIEF_DETECTION=true if the probe
    // (etl/ed/probe-chiefs.ts) shows manager-graph is too noisy at WCM.
    // Path C (override file) still runs after, so manual entries always win.
    const chiefDetectionDisabled =
      process.env.SCHOLARS_DISABLE_CHIEF_DETECTION === "true";

    // Build division → set-of-CWIDs index from active faculty appointments.
    const divisionMembers = new Map<string, Set<string>>();
    for (const a of facultyAppointments) {
      if (!a.divCode) continue;
      const set = divisionMembers.get(a.divCode) ?? new Set<string>();
      set.add(a.cwid);
      divisionMembers.set(a.divCode, set);
    }

    const divisionsForChief = await prisma.division.findMany({
      select: { code: true, deptCode: true },
    });
    const deptChairs = new Map<string, string | null>();
    for (const d of await prisma.department.findMany({
      select: { code: true, chairCwid: true },
    })) {
      deptChairs.set(d.code, d.chairCwid);
    }

    const chiefVerdictTally: Record<ChiefVerdict, number> = {
      HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0, GAP: 0,
    };
    let chiefAssignments = 0;
    if (!chiefDetectionDisabled && employeeRecords.length > 0) {
      for (const div of divisionsForChief) {
        const parentChair = deptChairs.get(div.deptCode) ?? null;
        const members = Array.from(divisionMembers.get(div.code) ?? []);
        const result = detectDivisionChief({
          divCode: div.code,
          members,
          parentChairCwid: parentChair,
          managerByCwid,
          appointmentsByCwid,
        });
        chiefVerdictTally[result.verdict] += 1;
        // Threshold gate: only HIGH and MEDIUM auto-write the pick.
        // LOW/NONE/GAP all clear to null — the override file (Path C) is
        // the escape hatch for divisions Path B can't decide on.
        await prisma.division.update({
          where: { code: div.code },
          data: { chiefCwid: result.valueToWrite },
        });
        if (result.valueToWrite) chiefAssignments += 1;
      }
      console.log(
        `[ED] Path B: assigned chiefs to ${chiefAssignments}/${divisionsForChief.length} divisions ` +
          `(verdicts — HIGH=${chiefVerdictTally.HIGH} MEDIUM=${chiefVerdictTally.MEDIUM} ` +
          `LOW=${chiefVerdictTally.LOW} NONE=${chiefVerdictTally.NONE} GAP=${chiefVerdictTally.GAP})`,
      );
    } else {
      console.log(
        `[ED] Path B chief detection skipped (` +
          (chiefDetectionDisabled
            ? "SCHOLARS_DISABLE_CHIEF_DETECTION=true"
            : "no employee SOR data") +
          ")",
      );
      // Even when Path B is skipped, clear stale chief assignments before
      // the override pass writes — keeps the table consistent with intent.
      if (!chiefDetectionDisabled) {
        await prisma.division.updateMany({ data: { chiefCwid: null } });
      }
    }

    // Phase 4 — D-04 division chief manual overrides (Path C, always-on).
    //
    // Reads data/division-chiefs.txt (TSV: divCode<TAB>cwid<TAB>notes) and
    // upserts Division.chiefCwid. A cwid of `-` clears the slot (vacancy).
    // Overrides always win over Path B — they're the escape hatch for
    // co-chiefs, vacancies, acting/interim cases, and any ambiguity Path B
    // can't resolve.
    const overridePath = path.resolve("data/division-chiefs.txt");
    const overrideRows: Array<{ divCode: string; cwid: string | null; note: string }> = [];
    try {
      const content = await fs.readFile(overridePath, "utf8");
      for (const rawLine of content.split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const parts = line.split("\t");
        const divCode = parts[0]?.trim();
        const cwidRaw = parts[1]?.trim();
        if (!divCode || !cwidRaw) continue;
        const cwid =
          cwidRaw === "-" ? null : cwidRaw.toLowerCase();
        const note = parts.slice(2).join("\t").trim();
        overrideRows.push({ divCode, cwid, note });
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }

    if (overrideRows.length > 0) {
      const knownDivCodes = new Set(divisionsForChief.map((d) => d.code));
      const knownScholarCwids = new Set(
        (await prisma.scholar.findMany({ select: { cwid: true } })).map(
          (s) => s.cwid,
        ),
      );
      let overrideApplied = 0;
      let overrideSkipped = 0;
      for (const row of overrideRows) {
        if (!knownDivCodes.has(row.divCode)) {
          console.warn(
            `[ED] division-chiefs override skipped — division ${row.divCode} not found`,
          );
          overrideSkipped += 1;
          continue;
        }
        if (row.cwid && !knownScholarCwids.has(row.cwid)) {
          console.warn(
            `[ED] division-chiefs override skipped — cwid '${row.cwid}' not in scholar table (div ${row.divCode})`,
          );
          overrideSkipped += 1;
          continue;
        }
        await prisma.division.update({
          where: { code: row.divCode },
          data: { chiefCwid: row.cwid },
        });
        overrideApplied += 1;
      }
      console.log(
        `[ED] Path C: applied ${overrideApplied}/${overrideRows.length} division-chiefs overrides ` +
          `(${overrideSkipped} skipped)`,
      );
    }

    // Phase 3 — scholarCount refresh.
    //
    // Iterate EVERY dept/division row in the DB (not just those seen this
    // run) so stale rows from prior runs — codes that no scholar resolves
    // to anymore after a picker change — get scholar_count=0 and qualify
    // for the prune step below. Without this, the prior-run counts persist
    // forever and the orphans never get cleaned up.
    const allDepts = await prisma.department.findMany({ select: { code: true } });
    for (const dept of allDepts) {
      const count = await prisma.scholar.count({
        where: { deptCode: dept.code, deletedAt: null, status: "active" },
      });
      await prisma.department.update({
        where: { code: dept.code },
        data: { scholarCount: count },
      });
    }
    const allDivs = await prisma.division.findMany({ select: { code: true } });
    for (const div of allDivs) {
      const count = await prisma.scholar.count({
        where: { divCode: div.code, deletedAt: null, status: "active" },
      });
      await prisma.division.update({
        where: { code: div.code },
        data: { scholarCount: count },
      });
    }

    // Cleanup: remove dept + division rows that no scholar references (these
    // are the codes that got consolidated into canonicals via deptAlias, plus
    // any historical rows from prior runs that are now orphaned).
    if (deptAlias.size > 0) {
      const aliasedCodes = Array.from(deptAlias.keys());
      // Divisions whose parent was aliased had deptCode rewritten in the
      // pre-pass; only the dept rows themselves need deleting.
      const deletedDepts = await prisma.department.deleteMany({
        where: { code: { in: aliasedCodes } },
      });
      console.log(
        `[ED] consolidated ${deletedDepts.count} duplicate-name dept rows`,
      );
    }
    // Belt + suspenders: any dept or division row with zero scholars referencing
    // it after the refresh is dead weight.
    const orphanDepts = await prisma.department.deleteMany({
      where: { scholarCount: 0, source: "ED" },
    });
    const orphanDivs = await prisma.division.deleteMany({
      where: { scholarCount: 0, source: "ED" },
    });
    console.log(
      `[ED] pruned ${orphanDepts.count} empty depts, ${orphanDivs.count} empty divisions`,
    );

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
