/**
 * LDAP connection helper for the ED ETL.
 *
 * Env vars use a SCHOLARS_LDAP_* namespace to avoid colliding with other
 * tooling that might also be reading LDAP_* in the user's shell. Defaults
 * mirror ReCiter-Institutional-Client conventions:
 *
 *   SCHOLARS_LDAP_URL              (required) — full ldaps://host:port
 *   SCHOLARS_LDAP_BIND_PASSWORD    (required) — password for the bind DN
 *   SCHOLARS_LDAP_BIND_DN          (optional) — defaults to inst.client service DN
 *   SCHOLARS_LDAP_SEARCH_BASE      (optional) — defaults to ou=people,...
 *   SCHOLARS_LDAP_ACTIVE_FILTER    (optional) — defaults to active-academic filter
 */
import { Client } from "ldapts";

export const DEFAULT_BIND_DN = "cn=reciter,ou=binds,dc=weill,dc=cornell,dc=edu";
export const DEFAULT_SEARCH_BASE = "ou=people,dc=weill,dc=cornell,dc=edu";
export const DEFAULT_STUDENT_SEARCH_BASE =
  "ou=students,dc=weill,dc=cornell,dc=edu";
export const DEFAULT_ACTIVE_FILTER =
  "(&(objectClass=eduPerson)(weillCornellEduPersonTypeCode=academic))";
/** Phase 2 — only doctoral students (PHD degree code) feed the eligibility carve. */
export const DEFAULT_DOCTORAL_STUDENT_FILTER =
  "(weillCornellEduDegreeCode=PHD)";

/** Attributes we pull on the active-faculty search. */
export const ED_FACULTY_ATTRIBUTES = [
  "weillCornellEduCWID",
  "weillCornellEduPrimaryTitle",
  "weillCornellEduMiddleName",
  "weillCornellEduPersonTypeCode",
  "weillCornellEduDepartment",
  "givenName",
  "sn",
  "cn",
  "mail",
  "ou",
  "title",
  "departmentNumber",
  "weillCornellEduFTE",         // Phase 2 — drives full_time_faculty derivation
  "weillCornellEduDegreeCode",  // Phase 2 — drives doctoral_student derivation
  // Phase 3 — D-02 org-unit attributes for Department/Division population.
  // Attribute names match the WCM LDAP schema per design-spec-v1.7.1 and PATTERNS.md.
  // Empirical probe in 03-LDAP-PROBE.md (Plan 02 Task 4) confirms which attributes
  // return non-empty values; if that probe reveals different attribute names, update
  // the projectEntries() mapping below and add an inline comment citing the probe.
  // Probe 2026-05-03 (03-LDAP-PROBE.md): weillCornellEduOrgUnitCode is the authoritative
  // org-unit attribute (refactored schema). weillCornellEduDepartmentCode is a 10-digit
  // legacy numeric code (populated but not the stable org-unit join key).
  "weillCornellEduOrgUnit",      // human-readable org-unit name (e.g. "General Internal Medicine")
  "weillCornellEduOrgUnitCode",  // stable org-unit code — use for deptCode join key
] as const;

export type EdFacultyEntry = {
  cwid: string;
  preferredName: string;
  fullName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  email: string | null;
  // Phase 2 — feeds deriveRoleCategory in etl/ed/index.ts.
  personTypeCode: string | null;
  fte: number | null;
  ou: string;
  degreeCode: string | null;
  // Phase 3 — D-02 org-unit fields. Nullable: not all entries have all three.
  deptCode: string | null;       // primary department code (level1 in org-unit hierarchy)
  divCode: string | null;        // division code (level2 in org-unit hierarchy)
  orgUnit: string | null;        // human-readable "level2 · level1" string for display fallback
};

/**
 * Open a bound LDAP connection. Caller is responsible for `await client.unbind()`.
 */
export async function openLdap(): Promise<Client> {
  const url = process.env.SCHOLARS_LDAP_URL;
  const password = process.env.SCHOLARS_LDAP_BIND_PASSWORD;
  const bindDn = process.env.SCHOLARS_LDAP_BIND_DN ?? DEFAULT_BIND_DN;
  if (!url) throw new Error("SCHOLARS_LDAP_URL is not set");
  if (!password) throw new Error("SCHOLARS_LDAP_BIND_PASSWORD is not set");

  const client = new Client({ url, timeout: 30_000, connectTimeout: 10_000 });
  await client.bind(bindDn, password);
  return client;
}

/**
 * Search active academic-type entries and project to the EdFacultyEntry shape.
 * Returns one entry per CWID; skips records without a CWID.
 */
export async function fetchActiveFaculty(client: Client): Promise<EdFacultyEntry[]> {
  const searchBase = process.env.SCHOLARS_LDAP_SEARCH_BASE ?? DEFAULT_SEARCH_BASE;
  const filter = process.env.SCHOLARS_LDAP_ACTIVE_FILTER ?? DEFAULT_ACTIVE_FILTER;
  const { searchEntries } = await client.search(searchBase, {
    scope: "sub",
    filter,
    attributes: [...ED_FACULTY_ATTRIBUTES],
    paged: { pageSize: 500 },
  });

  return projectEntries(searchEntries, /* fallbackOu */ "people");
}

/**
 * Phase 2 second branch: doctoral students live under ou=students, not ou=people,
 * so the active-faculty filter excludes them. Pull PHD students separately and
 * concatenate before the upsert. Filter restricted to weillCornellEduDegreeCode=PHD
 * per design-spec-v1.7.1.md:352-356 (only PHD students count as eligible-carve
 * doctoral_students; masters / professional students are out of scope).
 */
export async function fetchDoctoralStudents(client: Client): Promise<EdFacultyEntry[]> {
  const searchBase =
    process.env.SCHOLARS_LDAP_STUDENT_SEARCH_BASE ?? DEFAULT_STUDENT_SEARCH_BASE;
  const filter =
    process.env.SCHOLARS_LDAP_STUDENT_FILTER ?? DEFAULT_DOCTORAL_STUDENT_FILTER;
  const { searchEntries } = await client.search(searchBase, {
    scope: "sub",
    filter,
    attributes: [...ED_FACULTY_ATTRIBUTES],
    paged: { pageSize: 500 },
  });

  return projectEntries(searchEntries, /* fallbackOu */ "students");
}

/**
 * Shared projection: LDAP search entries → EdFacultyEntry[]. Skips records with
 * no CWID. Phase 2 fields (personTypeCode, fte, ou, degreeCode) are populated
 * here so downstream deriveRoleCategory has everything it needs.
 */
function projectEntries(
  searchEntries: ReadonlyArray<Record<string, unknown>>,
  fallbackOu: string,
): EdFacultyEntry[] {
  const out: EdFacultyEntry[] = [];
  for (const e of searchEntries) {
    const cwid = firstString(e.weillCornellEduCWID);
    if (!cwid) continue;

    const givenName = firstString(e.givenName) ?? "";
    const middleName = firstString(e.weillCornellEduMiddleName) ?? "";
    const sn = stripSurnameNoise(firstString(e.sn) ?? "");
    const preferredName = [givenName, sn].filter(Boolean).join(" ").trim();
    const fullName = [givenName, middleName, sn].filter(Boolean).join(" ").trim();

    out.push({
      cwid,
      preferredName: preferredName || cwid,
      fullName: fullName || preferredName || cwid,
      primaryTitle: firstString(e.weillCornellEduPrimaryTitle) ?? firstString(e.title) ?? null,
      primaryDepartment: firstString(e.weillCornellEduDepartment) ?? firstString(e.ou) ?? null,
      email: firstString(e.mail) ?? null,
      personTypeCode: firstString(e.weillCornellEduPersonTypeCode),
      fte: parseFte(e.weillCornellEduFTE),
      ou: firstString(e.ou) ?? fallbackOu,
      degreeCode: firstString(e.weillCornellEduDegreeCode),
      // Probe 2026-05-03: weillCornellEduOrgUnitCode is the authoritative org-unit code
      // (refactored LDAP schema). weillCornellEduDepartmentCode is a legacy 10-digit code.
      // divCode not available via LDAP in current schema.
      deptCode: firstString(e.weillCornellEduOrgUnitCode) ?? null,
      divCode: null,
      orgUnit: firstString(e.weillCornellEduOrgUnit) ?? null,
    });
  }
  return out;
}

function firstString(v: unknown): string | null {
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string");
    return typeof first === "string" ? first : null;
  }
  return typeof v === "string" ? v : null;
}

/**
 * weillCornellEduFTE is stored as a string like "100" or "50" in ED. Parse to
 * number; null on missing or unparseable. The full_time_faculty derivation
 * checks fte === 100 strictly (per design-spec-v1.7.1.md:352-356).
 */
function parseFte(v: unknown): number | null {
  const s = firstString(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Surnames in ED occasionally have suffixes like "- M.D." baked in. Match the
 * institutional client's de-noising before slug derivation.
 */
function stripSurnameNoise(sn: string): string {
  return sn.replace(/-\s*M\.?D\.?$/i, "").trim();
}
