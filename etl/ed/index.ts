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
  type EdFacultyAppointment,
  type EdFacultyEntry,
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
      const rawDeptName =
        primary?.organization ?? f.primaryDepartment ?? f.orgUnit ?? null;
      const rawDivName = primary?.divName ?? null;
      const rawDivCode = primary?.divCode ?? null;

      // Promote level2 → dept when LDAP nests an academic unit (Library)
      // under a non-academic level1 (ITS). The level2 code becomes the
      // scholar's dept_code; no division on this scholar.
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
        divCode: rawDivCode,
        deptName,
        divName: rawDivName,
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
            primaryTitle: f.primaryTitle,
            primaryDepartment: f.primaryDepartment,
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
    // Match `Chair of {dept name}` exactly (or with a trailing space/comma
    // for multi-clause titles like "Chair of X and Y"). Crucially, we do NOT
    // restrict to scholars whose `deptCode = dept.code`: a scholar's primary
    // dept is sometimes Medicine while their chair role is in a different
    // unit (e.g. Crystal — primary Medicine, "Chair of Genetic Medicine").
    // Title-based matching attributes the role to the right dept regardless
    // of where LDAP marks the scholar's primary appointment.
    //
    // Tiebreak on isPrimary DESC then startDate DESC.
    const chairTitleVariants = new Set<string>();
    let chairAssignments = 0;
    for (const dept of seenDepts.values()) {
      const expected = `Chair of ${dept.name}`;
      const candidate = await prisma.appointment.findFirst({
        where: {
          scholar: { deletedAt: null, status: "active" },
          OR: [
            { title: expected },
            { title: { startsWith: `${expected} ` } },
            { title: { startsWith: `${expected},` } },
          ],
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
    console.log(`[ED] assigned chairs to ${chairAssignments}/${seenDepts.size} departments`);
    console.log(`[ED] distinct chair-title variants observed:`, [...chairTitleVariants]);

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
