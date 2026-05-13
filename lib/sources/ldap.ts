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
/** WOOFA-sourced System-of-Record for faculty academic appointments. One LDAP
 *  entry per appointment row with per-appointment dept, dates, status, etc.
 *  We pull from here instead of the multi-valued `title` attribute on the
 *  person entry — that mixed clinical/admin roles in with academic appointments
 *  and had no per-row dates or status. */
export const DEFAULT_FACULTY_SOR_BASE =
  "ou=faculty,ou=sors,dc=weill,dc=cornell,dc=edu";
export const DEFAULT_ACTIVE_FILTER =
  "(&(objectClass=eduPerson)(weillCornellEduPersonTypeCode=academic))";
/** Phase 2 — only doctoral students (PHD degree code) feed the eligibility carve. */
export const DEFAULT_DOCTORAL_STUDENT_FILTER =
  "(weillCornellEduDegreeCode=PHD)";
/** Faculty SOR search: only currently-active appointments. Excludes
 *  faculty:expired rows so the profile sidebar shows live titles only. */
export const DEFAULT_FACULTY_SOR_FILTER =
  "(&(objectClass=weillCornellEduSORRoleRecord)(weillCornellEduStatus=faculty:active))";

/** WOOFA-sourced System-of-Record for employee records. Carries the
 *  `manager` attribute (full DN of the reporting manager) used for the
 *  postdoc-mentor lookup (issue #5) and the division-chief manager-graph
 *  detection (issue #16, Path B). */
export const DEFAULT_EMPLOYEE_SOR_BASE =
  "ou=employees,ou=sors,dc=weill,dc=cornell,dc=edu";
/** Employee SOR search: only currently-active employee records. */
export const DEFAULT_EMPLOYEE_SOR_FILTER =
  "(&(objectClass=weillCornellEduSORRecord)(weillCornellEduStatus=employee:active))";

/** NYP affiliates SOR — `ou=nyp affiliates,ou=sors`. One LDAP entry per active
 *  NYP role record. Used to surface NewYork-Presbyterian Hospital titles on
 *  the scholar profile as a secondary appointment below the WCM appointments
 *  (issue #162). */
export const DEFAULT_NYP_AFFILIATES_SOR_BASE =
  "ou=nyp affiliates,ou=sors,dc=weill,dc=cornell,dc=edu";
/** NYP affiliates filter: only currently-active affiliate records. */
export const DEFAULT_NYP_AFFILIATES_FILTER =
  "(&(objectClass=weillCornellEduSORRecord)(weillCornellEduStatus=affiliate:active))";

/** Attributes we pull on the active-faculty search. */
export const ED_FACULTY_ATTRIBUTES = [
  "weillCornellEduCWID",
  "weillCornellEduPrimaryTitle",
  "weillCornellEduMiddleName",
  // Curated human-readable display name from the directory. Preferred over
  // the constructed `givenName + sn` form so initials, middle names, and
  // capitalization conventions ("M. Cary Reid") are honored. Falls back to
  // the constructed form when absent.
  "displayName",
  // Multi-valued leaf-class array — the live WCM directory carries the rich
  // taxonomy here ("academic", "academic-faculty", "academic-faculty-weillfulltime",
  // "academic-nonfaculty-postdoc", etc.). Probe 2026-05-04 (debug session
  // recent-contributions-hidden): the array carries the leaf-level signal we need
  // for deriveRoleCategory; the scalar is just the umbrella value "academic".
  "weillCornellEduPersonTypeCode",
  // Single-valued canonical primary type — preferred signal when populated
  // (e.g. "employee-faculty-new-york-fulltime", "employee-postdoc-new-york").
  // Probe 2026-05-04: covers ~99% of active scholars; falls back to the array
  // for the residual ~27 entries with NULL primary.
  "weillCornellEduPrimaryPersonTypeCode",
  "weillCornellEduDepartment",
  "givenName",
  "sn",
  "cn",
  "mail",
  "ou",
  "title",
  "departmentNumber",
  // Phase 2 — the design spec assumes a populated weillCornellEduFTE attribute for
  // the full_time_faculty rule. Probe 2026-05-04: this attribute is NOT populated
  // in the live WCM directory; the FTE signal is encoded directly into the
  // *PersonTypeCode* values ("-fulltime"/"-weillfulltime" suffixes). The attribute
  // stays in the request list for forward-compat in case the schema changes.
  "weillCornellEduFTE",
  "weillCornellEduDegreeCode",  // Phase 2 — drives doctoral_student derivation
  // Phase 3 — D-02 org-unit attributes for Department/Division population.
  // Probe 2026-05-03 (03-LDAP-PROBE.md): weillCornellEduOrgUnitCode is the authoritative
  // org-unit attribute (refactored schema). weillCornellEduDepartmentCode is a 10-digit
  // legacy numeric code (populated but not the stable org-unit join key).
  "weillCornellEduOrgUnit",                  // returns subtypes ;level1 / ;level2
  "weillCornellEduOrgUnit;level1",           // dept name
  "weillCornellEduOrgUnit;level2",           // division name (when present)
  "weillCornellEduOrgUnitCode",
  "weillCornellEduOrgUnitCode;level1",       // dept code (e.g. N1280)
  "weillCornellEduOrgUnitCode;level2",       // division code (e.g. N2856)
  "weillCornellEduPrimaryOrgUnit;level1",    // primary appointment dept name
  "weillCornellEduPrimaryOrgUnitCode;level1",// primary appointment dept code
  "weillCornellEduPrimaryDepartment",        // primary dept name (single-value)
  "weillCornellEduPrimaryDepartmentCode",    // primary dept code (legacy 10-digit)
  "weillCornellEduDepartmentCode",           // multi-valued legacy 10-digit code
  "weillCornellEduDepartment",               // multi-valued dept name (per-appointment)
  // Pre-concatenated postnominal degree string (e.g. "MD", "MD, MPH"). Lives
  // on the person entry — also present on the SOR parent (weillCornellEduSORRecord)
  // but NOT on the Role subordinates that fetchActiveFacultyAppointments filters
  // for, so the people branch is the simpler source.
  "weillCornellEduDegree",
  // Issue #165 — canonical clinical profile URL on weillcornell.org. The
  // attribute is option-tagged (`labeledURI;pops`); ldapts surfaces it
  // under the same tagged key when requested explicitly. The bare
  // `labeledURI` is requested too as a defensive fallback in case the
  // tag isn't carried on every entry.
  "labeledURI",
  "labeledURI;pops",
] as const;

export type EdFacultyEntry = {
  cwid: string;
  preferredName: string;
  fullName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  email: string | null;
  // Phase 2 — feeds deriveRoleCategory in etl/ed/index.ts.
  //
  // primaryPersonTypeCode: scalar "best single signal" value; preferred when populated.
  //   Examples: "employee-faculty-new-york-fulltime", "employee-postdoc-new-york",
  //             "faculty-affiliated-non-employee", "academic-prestart".
  //
  // personTypeCodes: multi-valued leaf-class array carrying the rich taxonomy.
  //   Examples: ["academic", "academic-faculty", "academic-faculty-weillfulltime", ...].
  //   Used as fallback when primaryPersonTypeCode is null and as a tiebreaker for
  //   fellow vs postdoc detection (the array distinguishes "academic-nonfaculty-postdoc"
  //   from "academic-nonfaculty-postdoc-fellow").
  primaryPersonTypeCode: string | null;
  personTypeCodes: string[];
  fte: number | null;
  ou: string;
  degreeCode: string | null;
  /** Pre-concatenated postnominal degree string from `weillCornellEduDegree`
   *  on the person entry (e.g. "MD", "MD, MPH"). Null when absent. */
  degree: string | null;
  // Phase 3 — D-02 org-unit fields. Nullable: not all entries have all three.
  deptCode: string | null;       // primary department code (level1 in org-unit hierarchy)
  divCode: string | null;        // division code (level2 in org-unit hierarchy)
  orgUnit: string | null;        // human-readable "level2 · level1" string for display fallback
  /** Issue #165 — canonical clinical profile URL from `labeledURI;pops`
   *  (e.g. "https://weillcornell.org/matthewfink"). Already normalized to
   *  https:// at projection time. Null when the attribute is absent. */
  clinicalProfileUrl: string | null;
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

/** Structured faculty appointment row sourced from
 *  `ou=faculty,ou=sors,dc=weill,dc=cornell,dc=edu` (WOOFA SOR). One per active
 *  academic appointment — fields mirror what the profile sidebar renders.
 *
 *  Org-unit fields come from the LDAP subtype attributes
 *  `weillCornellEduOrgUnit;level1` (dept name), `weillCornellEduOrgUnit;level2`
 *  (division name), and matching `weillCornellEduOrgUnitCode;level{1,2}`
 *  (probed 2026-05-06 against ccole). level2 is null for appointments
 *  without a sub-department (e.g. Library, where the dept itself is the
 *  leaf unit). */
export type EdFacultyAppointment = {
  cwid: string;
  title: string;
  /** Per-appointment department NAME (level1). Same value previously stored
   *  as `organization` — kept under that name for back-compat with existing
   *  callers, plus deptCode below for the FK join. */
  organization: string | null;
  startDate: Date | null;
  /** Null when the SOR end-date is the 2099-06-30 sentinel (= indefinite). */
  endDate: Date | null;
  isPrimary: boolean;
  /** Stable per-appointment ID from `weillCornellEduSORID`, prefixed for
   *  attribution. Survives ETL reruns so the externalId column doesn't churn. */
  externalId: string;
  /** Joint-appointment flag (e.g. "The Bruce Webster Professor of Internal
   *  Medicine" is a Joint appointment in Medicine while Crystal's primary
   *  dept is Genetic Medicine). Available to UI if needed. */
  isJoint: boolean;
  /** Stable level1 dept code (e.g. "N1280" for Medicine). Use as Scholar.deptCode. */
  deptCode: string | null;
  /** Stable level2 division code (e.g. "N2856" for General Internal Medicine).
   *  Null when the appointment is at the dept level (no sub-division). */
  divCode: string | null;
  /** Division NAME (level2). Used to upsert the Division row's display name. */
  divName: string | null;
};

const FACULTY_SOR_ATTRS = [
  "weillCornellEduCWID",
  "title",
  "weillCornellEduDepartment",
  "weillCornellEduStartDate",
  "weillCornellEduEndDate",
  "weillCornellEduPrimaryEntry",
  "weillCornellEduStatus",
  "weillCornellEduSORID",
  "weillCornellEduType",
  // Bare base attribute requests usually return ALL subtypes as separate
  // keys in ldapts. Listing the explicit subtype names too is harmless and
  // documents the assumption.
  "weillCornellEduOrgUnit",
  "weillCornellEduOrgUnit;level1",
  "weillCornellEduOrgUnit;level2",
  "weillCornellEduOrgUnitCode",
  "weillCornellEduOrgUnitCode;level1",
  "weillCornellEduOrgUnitCode;level2",
] as const;

/** Fetch all currently-active faculty appointment records across every
 *  scholar in one paginated search. Caller groups by CWID before write.
 *  Filter is `weillCornellEduStatus=faculty:active` so expired rows don't
 *  reach the database (no need to mirror the SOR's history table). */
export async function fetchActiveFacultyAppointments(
  client: Client,
): Promise<EdFacultyAppointment[]> {
  const searchBase =
    process.env.SCHOLARS_LDAP_FACULTY_SOR_BASE ?? DEFAULT_FACULTY_SOR_BASE;
  const filter =
    process.env.SCHOLARS_LDAP_FACULTY_SOR_FILTER ?? DEFAULT_FACULTY_SOR_FILTER;
  const { searchEntries } = await client.search(searchBase, {
    scope: "sub",
    filter,
    attributes: [...FACULTY_SOR_ATTRS],
    paged: { pageSize: 500 },
  });

  const out: EdFacultyAppointment[] = [];
  for (const e of searchEntries) {
    const cwid = firstString(e.weillCornellEduCWID);
    const title = firstString(e.title);
    const sorId = firstString(e.weillCornellEduSORID);
    if (!cwid || !title || !sorId) continue;

    // Subtype-aware reads. ldapts surfaces option-tagged attributes with
    // their tag suffix in the key (probed: "weillCornellEduOrgUnit;level1").
    const r = e as Record<string, unknown>;
    const deptName =
      firstString(r["weillCornellEduOrgUnit;level1"]) ??
      firstString(r["weillCornellEduDepartment"]);
    const divName = firstString(r["weillCornellEduOrgUnit;level2"]);
    const deptCode = firstString(r["weillCornellEduOrgUnitCode;level1"]);
    const divCode = firstString(r["weillCornellEduOrgUnitCode;level2"]);

    out.push({
      cwid,
      title,
      organization: deptName,
      startDate: parseLdapGeneralizedTime(firstString(e.weillCornellEduStartDate)),
      endDate: parseLdapGeneralizedTime(firstString(e.weillCornellEduEndDate)),
      isPrimary: firstString(e.weillCornellEduPrimaryEntry) === "TRUE",
      externalId: `ED-FACULTY-${sorId}`,
      isJoint: firstString(e.weillCornellEduType) === "Joint",
      deptCode,
      divCode,
      divName,
    });
  }
  return out;
}

/** Employee SOR record. One LDAP entry per active employee row in
 *  `ou=employees,ou=sors`. A scholar may have multiple rows (concurrent
 *  appointments); callers collapse by CWID before consuming.
 *
 *  `managerCwid` is parsed from the `manager` attribute, which carries a
 *  full DN like `uid=par9082,ou=people,dc=weill,dc=cornell,dc=edu`. The
 *  CWID is the value of the first `uid=` RDN (lowercased). Returns null
 *  on missing/malformed DNs. */
export type EdEmployeeRecord = {
  cwid: string;
  managerCwid: string | null;
  sorId: string;
  isPrimary: boolean;
};

const EMPLOYEE_SOR_ATTRS = [
  "weillCornellEduCWID",
  "manager",
  "weillCornellEduStatus",
  "weillCornellEduSORID",
  "weillCornellEduPrimaryEntry",
] as const;

/** Fetch all currently-active employee SOR records in one paginated search.
 *  One row per appointment (a scholar may appear multiple times). Caller
 *  should collapse rows per CWID — see `collapseEmployeeRecordsByCwid`. */
export async function fetchActiveEmployeeRecords(
  client: Client,
): Promise<EdEmployeeRecord[]> {
  const searchBase =
    process.env.SCHOLARS_LDAP_EMPLOYEE_SOR_BASE ?? DEFAULT_EMPLOYEE_SOR_BASE;
  const filter =
    process.env.SCHOLARS_LDAP_EMPLOYEE_SOR_FILTER ?? DEFAULT_EMPLOYEE_SOR_FILTER;
  const { searchEntries } = await client.search(searchBase, {
    scope: "sub",
    filter,
    attributes: [...EMPLOYEE_SOR_ATTRS],
    paged: { pageSize: 500 },
  });

  const out: EdEmployeeRecord[] = [];
  for (const e of searchEntries) {
    const cwid = firstString(e.weillCornellEduCWID);
    const sorId = firstString(e.weillCornellEduSORID);
    if (!cwid || !sorId) continue;
    const managerDn = firstString(e.manager);
    out.push({
      cwid: cwid.toLowerCase(),
      managerCwid: parseManagerCwid(managerDn),
      sorId,
      isPrimary: firstString(e.weillCornellEduPrimaryEntry) === "TRUE",
    });
  }
  return out;
}

/** NYP affiliate title row — one per active NYP role record. The title is
 *  normalized by `normalizeNypTitle()` before write so sub-specialty suffixes
 *  ("Physician - Neurology") collapse to the role only ("Physician"). */
export type EdNypAffiliateTitle = {
  cwid: string;
  /** Already-normalized role string (sub-specialty stripped). */
  title: string;
};

const NYP_AFFILIATES_ATTRS = [
  "weillCornellEduCWID",
  "title",
  "weillCornellEduStatus",
] as const;

/** Strip a `" - <specialty>"` suffix from a raw NYP title. Preserves casing.
 *  Examples:
 *    "Physician"               → "Physician"
 *    "Physician - Neurology"   → "Physician"
 *    "Attending - Cardiology"  → "Attending"
 *  Rule: split on the first occurrence of " - " (space-dash-space) and keep
 *  the left side. Trailing whitespace trimmed. Bare hyphens inside a word
 *  (e.g. "Co-Director") are preserved. */
export function normalizeNypTitle(raw: string): string {
  const idx = raw.indexOf(" - ");
  const left = idx >= 0 ? raw.slice(0, idx) : raw;
  return left.trim();
}

/** Fetch all currently-active NYP affiliate title records in one paginated
 *  search. Caller filters to known CWIDs and dedupes (cwid, normalizedTitle)
 *  before insert. */
export async function fetchActiveNypAffiliates(
  client: Client,
): Promise<EdNypAffiliateTitle[]> {
  const searchBase =
    process.env.SCHOLARS_LDAP_NYP_AFFILIATES_BASE ??
    DEFAULT_NYP_AFFILIATES_SOR_BASE;
  const filter =
    process.env.SCHOLARS_LDAP_NYP_AFFILIATES_FILTER ??
    DEFAULT_NYP_AFFILIATES_FILTER;
  const { searchEntries } = await client.search(searchBase, {
    scope: "sub",
    filter,
    attributes: [...NYP_AFFILIATES_ATTRS],
    paged: { pageSize: 500 },
  });

  const out: EdNypAffiliateTitle[] = [];
  for (const e of searchEntries) {
    const cwid = firstString(e.weillCornellEduCWID);
    const rawTitle = firstString(e.title);
    if (!cwid || !rawTitle) continue;
    const title = normalizeNypTitle(rawTitle);
    if (!title) continue;
    out.push({ cwid: cwid.toLowerCase(), title });
  }
  return out;
}

/** Issue #183 — Postdoc employment role record from `ou=employees,ou=sors`.
 *  One entry per postdoc appointment (a postdoc may have multiple if they
 *  re-appointed). Both currently-active and expired records are pulled so
 *  alumni postdocs surface on the mentor's profile.
 *
 *  Mentor (= reporting PI) comes from the `manager` attribute on the role
 *  record itself — parsed by `parseManagerCwid`. Names of the postdoc
 *  themselves are NOT on the role record; the ETL resolves them via a
 *  separate name lookup against `ou=people` (`fetchPersonNamesByCwid`).
 *
 *  Privacy: attribute list is the minimum required — no DOB, SSN-equivalents,
 *  postalCode, employeeNumber, or mail. See memory note feedback_ldap_minimal_attrs.
 */
export type EdPostdocEmploymentRecord = {
  cwid: string;
  managerCwid: string | null;
  sorId: string;
  status: string;
  title: string | null;
  roleCode: string | null;
  startDate: Date | null;
  endDate: Date | null;
  isPrimary: boolean;
};

const POSTDOC_EMPLOYMENT_ATTRS = [
  "weillCornellEduCWID",
  "manager",
  "weillCornellEduStartDate",
  "weillCornellEduEndDate",
  "weillCornellEduStatus",
  "weillCornellEduSORID",
  "weillCornellEduRoleCode",
  "title",
  "weillCornellEduPrimaryEntry",
] as const;

/** Active + expired postdoc role records. The role-code branch is the
 *  primary signal (`06` = "Post Doc. Assoc-Sal" in WCM HR); the title
 *  branch is a fallback in case a legacy record is missing the code. */
export const DEFAULT_POSTDOC_EMPLOYMENT_FILTER =
  "(&(objectClass=weillCornellEduSORRoleRecord)" +
  "(|(weillCornellEduRoleCode=06)(title=Postdoctoral*))" +
  "(|(weillCornellEduStatus=employee:active)(weillCornellEduStatus=employee:expired)))";

/** Fetch every postdoc employment role record under `ou=employees,ou=sors`
 *  (both active and expired). Caller is responsible for downstream tombstone
 *  handling — what isn't in this result set should be deleted from
 *  `postdoc_mentor_relationship`.
 *
 *  Connection handling: opens its own short-lived ldapts client and unbinds
 *  on completion. The shared ETL client experienced sporadic `0x20`
 *  noSuchObject errors on paged sub-searches late in a long ETL run
 *  (probed 2026-05-13 against ed.weill.cornell.edu — the same call succeeds
 *  on a fresh client). Owning the client locally isolates this fetcher
 *  from whatever connection state the long-lived ETL client accumulates. */
export async function fetchAllPostdocEmploymentRecords(): Promise<
  EdPostdocEmploymentRecord[]
> {
  const searchBase =
    process.env.SCHOLARS_LDAP_EMPLOYEE_SOR_BASE ?? DEFAULT_EMPLOYEE_SOR_BASE;
  const filter =
    process.env.SCHOLARS_LDAP_POSTDOC_EMPLOYMENT_FILTER ??
    DEFAULT_POSTDOC_EMPLOYMENT_FILTER;
  const client = await openLdap();
  try {
    const { searchEntries } = await client.search(searchBase, {
      scope: "sub",
      filter,
      attributes: [...POSTDOC_EMPLOYMENT_ATTRS],
      paged: { pageSize: 500 },
    });

    const out: EdPostdocEmploymentRecord[] = [];
    for (const e of searchEntries) {
      const cwid = firstString(e.weillCornellEduCWID);
      const sorId = firstString(e.weillCornellEduSORID);
      const status = firstString(e.weillCornellEduStatus);
      if (!cwid || !sorId || !status) continue;
      const managerDn = firstString(e.manager);
      out.push({
        cwid: cwid.toLowerCase(),
        managerCwid: parseManagerCwid(managerDn),
        sorId,
        status,
        title: firstString(e.title),
        roleCode: firstString(e.weillCornellEduRoleCode),
        startDate: parseLdapGeneralizedTime(firstString(e.weillCornellEduStartDate)),
        endDate: parseLdapGeneralizedTime(firstString(e.weillCornellEduEndDate)),
        isPrimary: firstString(e.weillCornellEduPrimaryEntry) === "TRUE",
      });
    }
    return out;
  } finally {
    try {
      await client.unbind();
    } catch {
      // unbind failures are non-fatal — the connection will be closed by the
      // server when the process exits anyway.
    }
  }
}

/** Resolve display names for a batch of CWIDs against `ou=people`. Used by
 *  the postdoc-mentor ETL (issue #183) to populate
 *  `postdoc_mentor_relationship.mentee_first_name` / `mentee_last_name`
 *  for alumni postdocs who are not present in our local Scholar table.
 *
 *  Returns a map keyed by lowercase CWID. Missing CWIDs are simply absent
 *  from the map — callers fall back to the CWID itself for the display
 *  string. Batches the OR-of-CWIDs filter at 100 entries per query so a
 *  large alumni list doesn't blow the LDAP filter-length limit.
 *
 *  Privacy: only requests CWID + name attributes. Explicitly does NOT
 *  reuse `ED_FACULTY_ATTRIBUTES` (which pulls title, department, FTE, etc.)
 *  — narrow per-call lists per the repo's LDAP minimal-attribute policy. */
const PERSON_NAME_ATTRS = [
  "weillCornellEduCWID",
  "givenName",
  "sn",
  "displayName",
] as const;

export async function fetchPersonNamesByCwid(
  cwids: string[],
): Promise<Map<string, { firstName: string | null; lastName: string | null }>> {
  const out = new Map<string, { firstName: string | null; lastName: string | null }>();
  if (cwids.length === 0) return out;

  const searchBase = process.env.SCHOLARS_LDAP_SEARCH_BASE ?? DEFAULT_SEARCH_BASE;
  const batchSize = 100;
  const client = await openLdap();
  try {
    for (let i = 0; i < cwids.length; i += batchSize) {
      const batch = cwids.slice(i, i + batchSize);
      const filter =
        "(|" +
        batch.map((c) => `(weillCornellEduCWID=${escapeLdapFilter(c)})`).join("") +
        ")";
      const { searchEntries } = await client.search(searchBase, {
        scope: "sub",
        filter,
        attributes: [...PERSON_NAME_ATTRS],
        paged: { pageSize: 500 },
      });
      for (const e of searchEntries) {
        const cwid = firstString(e.weillCornellEduCWID);
        if (!cwid) continue;
        const givenName = firstString(e.givenName);
        const sn = stripSurnameNoise(firstString(e.sn) ?? "");
        const displayName = firstString(e.displayName);
        // displayName beats given+sn only if the constructed form is empty;
        // for postdoc name persistence the structured first/last fields are
        // what downstream code reads, so prefer the components.
        const firstName = givenName ?? (displayName ? displayName.split(/\s+/)[0] : null);
        const lastName = sn || (displayName ? displayName.split(/\s+/).slice(-1)[0] : null) || null;
        out.set(cwid.toLowerCase(), { firstName, lastName });
      }
    }
  } finally {
    try {
      await client.unbind();
    } catch {
      // see fetchAllPostdocEmploymentRecords — non-fatal.
    }
  }
  return out;
}

/** RFC 4515 LDAP filter escaping. CWIDs are alphanumeric in practice, but
 *  hardening anyway in case ED ever returns a CWID with a hyphen or other
 *  reserved character. */
function escapeLdapFilter(s: string): string {
  return s.replace(/[\\*()\0]/g, (c) => {
    switch (c) {
      case "\\":
        return "\\5c";
      case "*":
        return "\\2a";
      case "(":
        return "\\28";
      case ")":
        return "\\29";
      case "\0":
        return "\\00";
      default:
        return c;
    }
  });
}

/** Issue #195 — PhD student SOR Role record from `ou=students,ou=sors`. One
 *  LDAP entry per PhD program enrollment. A scholar may have more than one
 *  (re-enrollment, dual programs); caller collapses to the most-recent record
 *  before persisting. Expired rows are included so alumni mentees still
 *  resolve to a program name. */
export type EdPhdStudentProgramRecord = {
  cwid: string;
  program: string;
  programCode: string | null;
  expectedGradYear: number | null;
  status: string | null;
  exitReason: string | null;
  startDate: Date | null;
  endDate: Date | null;
};

export const DEFAULT_STUDENT_SOR_BASE =
  "ou=students,ou=sors,dc=weill,dc=cornell,dc=edu";
/** Pull every PHD Role record — active and expired. Alumni mentees rely on
 *  this; restricting to `student:active` would erase graduated PhDs. */
export const DEFAULT_STUDENT_SOR_FILTER =
  "(&(objectClass=weillCornellEduSORRoleRecord)(weillCornellEduDegreeCode=PHD))";

const STUDENT_SOR_ATTRS = [
  "weillCornellEduCWID",
  "weillCornellEduProgram",
  "weillCornellEduProgramCode",
  "weillCornellEduDegreeCode",
  "weillCornellEduStatus",
  "weillCornellEduExpectedGradYear",
  "weillCornellEduExitReason",
  "weillCornellEduStartDate",
  "weillCornellEduEndDate",
] as const;

/** Fetch every PHD student Role record in `ou=students,ou=sors`. Includes
 *  expired rows so alumni show their program of study. Caller collapses
 *  per-CWID; see `collapsePhdStudentProgramRecords`. */
export async function fetchPhdStudentProgramRecords(
  client: Client,
): Promise<EdPhdStudentProgramRecord[]> {
  const searchBase =
    process.env.SCHOLARS_LDAP_STUDENT_SOR_BASE ?? DEFAULT_STUDENT_SOR_BASE;
  const filter =
    process.env.SCHOLARS_LDAP_STUDENT_SOR_FILTER ?? DEFAULT_STUDENT_SOR_FILTER;
  const { searchEntries } = await client.search(searchBase, {
    scope: "sub",
    filter,
    attributes: [...STUDENT_SOR_ATTRS],
    paged: { pageSize: 500 },
  });

  const out: EdPhdStudentProgramRecord[] = [];
  for (const e of searchEntries) {
    const cwid = firstString(e.weillCornellEduCWID);
    const program = firstString(e.weillCornellEduProgram);
    if (!cwid || !program) continue;

    const expectedGradYearRaw = firstString(e.weillCornellEduExpectedGradYear);
    const expectedGradYear = expectedGradYearRaw
      ? Number.parseInt(expectedGradYearRaw, 10)
      : null;

    out.push({
      cwid: cwid.toLowerCase(),
      program,
      programCode: firstString(e.weillCornellEduProgramCode),
      expectedGradYear:
        Number.isFinite(expectedGradYear) && expectedGradYear !== 0
          ? expectedGradYear
          : null,
      status: firstString(e.weillCornellEduStatus),
      exitReason: firstString(e.weillCornellEduExitReason),
      startDate: parseLdapGeneralizedTime(firstString(e.weillCornellEduStartDate)),
      endDate: parseLdapGeneralizedTime(firstString(e.weillCornellEduEndDate)),
    });
  }
  return out;
}

/** Collapse multiple PHD Role records per CWID to a single row. Selection
 *  rule mirrors the mentoring chip's intent ("what program is this person
 *  associated with?"): active rows beat expired; among ties, the row with
 *  the most recent endDate wins; among further ties, the most recent
 *  startDate. This way a re-enrolled student shows their current program
 *  and a graduated mentee shows the terminal program. */
export function collapsePhdStudentProgramRecords(
  records: EdPhdStudentProgramRecord[],
): Map<string, EdPhdStudentProgramRecord> {
  const byCwid = new Map<string, EdPhdStudentProgramRecord>();
  for (const r of records) {
    const existing = byCwid.get(r.cwid);
    if (!existing) {
      byCwid.set(r.cwid, r);
      continue;
    }
    if (rankPhdRecord(r) > rankPhdRecord(existing)) {
      byCwid.set(r.cwid, r);
    }
  }
  return byCwid;
}

function rankPhdRecord(r: EdPhdStudentProgramRecord): number {
  // Active rows beat expired (big offset so date never wins over status).
  const activeBoost = r.status === "student:active" ? 1e15 : 0;
  // endDate then startDate. Null dates rank lowest.
  const end = r.endDate ? r.endDate.getTime() : 0;
  const start = r.startDate ? r.startDate.getTime() : 0;
  return activeBoost + end + start / 1e6;
}

/** Parse a manager DN of the form `uid=<cwid>,ou=people,...` to its CWID.
 *  Returns null on null/malformed input. */
export function parseManagerCwid(dn: string | null | undefined): string | null {
  if (!dn) return null;
  const m = dn.match(/^uid=([^,]+)/i);
  if (!m) return null;
  const cwid = m[1].trim().toLowerCase();
  return cwid.length > 0 ? cwid : null;
}

/** Collapse multiple employee SOR rows per CWID into a single best-row map.
 *  Selection rule: the row marked `weillCornellEduPrimaryEntry=TRUE` with a
 *  non-null managerCwid wins; failing that, the first row with any non-null
 *  managerCwid; failing that, the first row at all. Logs a warning if the
 *  candidate rows disagree on managerCwid (different DNs across concurrent
 *  appointments — caller can decide to surface or ignore). */
export function collapseEmployeeRecordsByCwid(
  records: EdEmployeeRecord[],
): Map<string, EdEmployeeRecord> {
  const byCwid = new Map<string, EdEmployeeRecord[]>();
  for (const r of records) {
    const arr = byCwid.get(r.cwid) ?? [];
    arr.push(r);
    byCwid.set(r.cwid, arr);
  }
  const out = new Map<string, EdEmployeeRecord>();
  for (const [cwid, rows] of byCwid) {
    const primaryWithMgr = rows.find((r) => r.isPrimary && r.managerCwid);
    const anyWithMgr = rows.find((r) => r.managerCwid);
    const chosen = primaryWithMgr ?? anyWithMgr ?? rows[0];
    out.set(cwid, chosen);

    const distinctManagers = new Set(
      rows.map((r) => r.managerCwid).filter((x): x is string => !!x),
    );
    if (distinctManagers.size > 1) {
      console.warn(
        `[ldap] CWID ${cwid} has ${distinctManagers.size} distinct manager CWIDs across ${rows.length} employee SOR rows; using ${chosen.managerCwid ?? "null"}`,
      );
    }
  }
  return out;
}

/** LDAP generalizedTime is `YYYYMMDDhhmmssZ` (e.g. "19930301050000Z"). The
 *  SOR uses `20990630050000Z` as a sentinel for "no end date / open-ended".
 *  Anything in 2050+ is treated as null so the UI can render it as "active". */
function parseLdapGeneralizedTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() >= 2050) return null;
  return date;
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
 * no CWID. Phase 2 fields (primaryPersonTypeCode, personTypeCodes, ou, degreeCode)
 * are populated here so downstream deriveRoleCategory has everything it needs.
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
    const displayName = stripTrailingDegree(firstString(e.displayName)?.trim() ?? "");
    const constructed = [givenName, sn].filter(Boolean).join(" ").trim();
    // Prefer LDAP-curated displayName so middle names, initials, and stylized
    // capitalization ("M. Cary Reid") are honored. Concatenation can't reproduce
    // those conventions and silently drops the curator's middle component.
    const preferredName = displayName || constructed;
    // fullName keeps the constructed form when it's richer than displayName
    // (carries the explicit middle name token for full-text search recall).
    const constructedFull = [givenName, middleName, sn].filter(Boolean).join(" ").trim();
    const fullName = constructedFull || preferredName;

    const r = e as Record<string, unknown>;

    out.push({
      cwid,
      preferredName: preferredName || cwid,
      fullName: fullName || preferredName || cwid,
      primaryTitle: firstString(e.weillCornellEduPrimaryTitle) ?? firstString(e.title) ?? null,
      primaryDepartment:
        firstString(r["weillCornellEduPrimaryDepartment"]) ??
        firstString(e.weillCornellEduDepartment) ??
        firstString(e.ou) ??
        null,
      email: firstString(e.mail) ?? null,
      primaryPersonTypeCode: firstString(e.weillCornellEduPrimaryPersonTypeCode),
      personTypeCodes: allStrings(e.weillCornellEduPersonTypeCode),
      fte: parseFte(e.weillCornellEduFTE),
      ou: firstString(e.ou) ?? fallbackOu,
      degreeCode: firstString(e.weillCornellEduDegreeCode),
      degree: firstString(e.weillCornellEduDegree),
      // Probe 2026-05-06: org-unit data is exposed via LDAP option subtypes
      // (`;level1` / `;level2`). On the people branch the **primary** subtypes
      // mark the scholar's main appointment unambiguously even when the
      // person has multiple joint appointments. Division (level2) is only
      // populated on SOR child role records — see fetchActiveFacultyAppointments
      // for the authoritative div_code source.
      //
      // We deliberately do NOT fall back to weillCornellEduDepartmentCode
      // (10-digit legacy) here: that creates parallel rows for the same
      // conceptual dept (Medicine appears as both N1280 and 1280000000),
      // which collides on the dept slug unique index. Scholars without
      // an N-prefixed primary code get null deptCode and resolve via the
      // SOR appointment fallback in etl/ed/index.ts (resolveOrgUnit).
      deptCode:
        firstString(r["weillCornellEduPrimaryOrgUnitCode;level1"]) ??
        firstString(r["weillCornellEduOrgUnitCode;level1"]),
      divCode: null, // hydrated from SOR primary appointment in etl/ed/index.ts
      orgUnit:
        firstString(r["weillCornellEduPrimaryOrgUnit;level1"]) ??
        firstString(r["weillCornellEduOrgUnit;level1"]),
      // Issue #165 — canonical weillcornell.org clinical profile URL. Prefer
      // the option-tagged `labeledURI;pops` (POPS = the directory schema's
      // own tag) and fall back to the bare attribute if the tag is missing.
      clinicalProfileUrl: normalizeClinicalProfileUrl(
        firstString(r["labeledURI;pops"]) ?? firstString(r["labeledURI"]),
      ),
    });
  }
  return out;
}

/** Normalize an LDAP `labeledURI` value to a usable HTTPS URL.
 *  - Trims surrounding whitespace.
 *  - Rewrites `http://` → `https://` so the link doesn't trigger a
 *    redirect / mixed-content warning when clicked from the HTTPS site.
 *  - Returns null for empty / non-http(s) values (e.g. relative paths or
 *    `mailto:` links accidentally stored on the attribute).
 *  - LDAP `labeledURI` syntax allows a space-separated label after the URI
 *    (RFC 2079); strip anything after the first whitespace so a curated
 *    label doesn't end up in the href. */
export function normalizeClinicalProfileUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const uri = trimmed.split(/\s+/, 1)[0];
  if (/^http:\/\//i.test(uri)) return "https://" + uri.slice(7);
  if (/^https:\/\//i.test(uri)) return uri;
  return null;
}

/**
 * Slugify an org-unit name to UPPER_SNAKE for use as a stable code.
 * Used as a deptCode fallback when LDAP returns no numeric code.
 */
function slugifyOrgName(name: string | null): string | null {
  if (!name) return null;
  const t = name.trim();
  if (!t) return null;
  return t
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * Derive a stable division code from the LDAP `weillCornellEduOrgUnit` value
 * when it differs from the dept name. Same UPPER_SNAKE shape as deptCode so
 * dept and division share a slugify convention. Returns null when the
 * scholar has no division (orgUnit absent or equal to the dept name) — the
 * Division upsert path in etl/ed/index.ts skips null divCodes.
 */
function deriveDivCode(
  orgUnit: string | null,
  deptName: string | null,
): string | null {
  if (!orgUnit) return null;
  const trimmedOrg = orgUnit.trim();
  const trimmedDept = deptName?.trim() ?? "";
  if (trimmedOrg.length === 0) return null;
  if (trimmedDept && trimmedOrg === trimmedDept) return null;
  return slugifyOrgName(trimmedOrg);
}

function firstString(v: unknown): string | null {
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string");
    return typeof first === "string" ? first : null;
  }
  return typeof v === "string" ? v : null;
}

/**
 * Project a multi-valued LDAP attribute to a string[]. Returns [] for null/undefined.
 * Single-valued attributes (string) are wrapped in a one-element array.
 */
function allStrings(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return typeof v === "string" ? [v] : [];
}

/**
 * weillCornellEduFTE is stored as a string like "100" or "50" in ED — when it
 * is populated. Probe 2026-05-04: the live WCM directory does NOT populate this
 * attribute; the FTE signal is encoded directly into *PersonTypeCode* values
 * ("-fulltime"/"-weillfulltime" suffixes). Parser kept for forward-compat.
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

/**
 * Some legacy LDAP `displayName` entries carry a postnominal degree baked in
 * ("Curtis Cole, MD"). The ETL appends the postnominal at render time from
 * the SOR `weillCornellEduDegree` attribute, so a duplicate would result.
 * Strip a trailing `, <DEGREE>` suffix so the rendered name stays clean.
 */
function stripTrailingDegree(name: string): string {
  // Match `, ` followed by a comma-separated list of all-caps tokens / dotted
  // forms ("MD", "M.D.", "PhD", "Sc.D.", "MD, MPH"). Conservative: requires
  // each token to look degree-shaped to avoid eating real name suffixes.
  const tokenRe = /[A-Za-z]\.?(?:[A-Za-z]\.?){0,4}/;
  const re = new RegExp(`,\\s*(?:${tokenRe.source})(?:\\s*,\\s*${tokenRe.source})*\\s*$`);
  // Only strip if the matched tail is plausibly a degree (contains an upper-
  // case letter and avoids common name suffixes like "Jr", "Sr", "II", "III").
  const m = name.match(re);
  if (!m) return name.trim();
  const tail = m[0].replace(/^,\s*/, "").trim();
  const tokens = tail.split(/\s*,\s*/);
  const looksLikeDegree = tokens.every(
    (t) => /[A-Z]/.test(t) && !/^(Jr|Sr|I{1,3}|IV|V|VI{0,3}|Esq)\.?$/i.test(t),
  );
  return looksLikeDegree ? name.slice(0, m.index).trim() : name.trim();
}
